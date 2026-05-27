#!/usr/bin/env node
/**
 * Hermes Agent WhatsApp Bridge
 *
 * Standalone Node.js process that connects to WhatsApp via Baileys
 * and exposes HTTP endpoints for the Python gateway adapter.
 *
 * Endpoints (matches gateway/platforms/whatsapp.py expectations):
 *   GET  /messages       - Long-poll for new incoming messages
 *   POST /send           - Send a message { chatId, message, replyTo? }
 *   POST /edit           - Edit a sent message { chatId, messageId, message }
 *   POST /send-media     - Send media natively { chatId, filePath, mediaType?, caption?, fileName? }
 *   POST /typing         - Send typing indicator { chatId }
 *   GET  /chat/:id       - Get chat info
 *   GET  /health         - Health check
 *
 * Usage:
 *   node bridge.js --port 3000 --session ~/.hermes/whatsapp/session
 */

import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage } from '@whiskeysockets/baileys';
import express from 'express';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import path from 'path';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from 'fs';
import { randomBytes } from 'crypto';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import qrcode from 'qrcode-terminal';
import { matchesAllowedUser, parseAllowedUsers } from './allowlist.js';

// Parse CLI args
const args = process.argv.slice(2);
function getArg(name, defaultVal) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : defaultVal;
}

const WHATSAPP_DEBUG =
  typeof process !== 'undefined' &&
  process.env &&
  typeof process.env.WHATSAPP_DEBUG === 'string' &&
  ['1', 'true', 'yes', 'on'].includes(process.env.WHATSAPP_DEBUG.toLowerCase());

const PORT = parseInt(getArg('port', '3000'), 10);
const SESSION_DIR = getArg('session', path.join(process.env.HOME || '~', '.hermes', 'whatsapp', 'session'));
const IMAGE_CACHE_DIR = path.join(process.env.HOME || '~', '.hermes', 'image_cache');
const DOCUMENT_CACHE_DIR = path.join(process.env.HOME || '~', '.hermes', 'document_cache');
const AUDIO_CACHE_DIR = path.join(process.env.HOME || '~', '.hermes', 'audio_cache');
const PAIR_ONLY = args.includes('--pair-only');
const WHATSAPP_MODE = getArg('mode', process.env.WHATSAPP_MODE || 'self-chat'); // "bot" or "self-chat"
export function parseObserveNonSelf(val) {
  return (val || 'false').toString().toLowerCase() === 'true';
}
const OBSERVE_NON_SELF =
  parseObserveNonSelf(getArg('observe-non-self', process.env.WHATSAPP_OBSERVE_NON_SELF || 'false'));
export { OBSERVE_NON_SELF };
const ALLOWED_USERS = parseAllowedUsers(process.env.WHATSAPP_ALLOWED_USERS || '');
const DEFAULT_REPLY_PREFIX = '⚕ *Hermes Agent*\n────────────\n';
const REPLY_PREFIX = process.env.WHATSAPP_REPLY_PREFIX === undefined
  ? DEFAULT_REPLY_PREFIX
  : process.env.WHATSAPP_REPLY_PREFIX.replace(/\\n/g, '\n');
const MAX_MESSAGE_LENGTH = parseInt(process.env.WHATSAPP_MAX_MESSAGE_LENGTH || '4096', 10);
const CHUNK_DELAY_MS = parseInt(process.env.WHATSAPP_CHUNK_DELAY_MS || '300', 10);
// Per-call timeout for sock.sendMessage(). Baileys occasionally hangs forever
// when uploading media to WhatsApp servers (and, less often, on text sends),
// which pins the bridge's HTTP handler until the upstream aiohttp timeout
// fires. Fail fast instead so the gateway can surface a real error and retry.
const SEND_TIMEOUT_MS = parseInt(process.env.WHATSAPP_SEND_TIMEOUT_MS || '60000', 10);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sendWithTimeout(chatId, payload, timeoutMs = SEND_TIMEOUT_MS) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`sendMessage timed out after ${timeoutMs / 1000}s`)),
      timeoutMs,
    );
  });
  return Promise.race([sock.sendMessage(chatId, payload), timeoutPromise])
    .finally(() => clearTimeout(timer));
}

export function formatOutgoingMessage(message, opts = {}, mode = WHATSAPP_MODE) {
  // In bot mode, messages come from a different number so the prefix is
  // redundant — the sender identity is already clear.  Only prepend in
  // self-chat mode where bot and user share the same number.
  if (mode !== 'self-chat') return message;
  // If caller provided a prefix_override (even empty string), use it verbatim.
  if ('prefixOverride' in opts) {
    return opts.prefixOverride ? `${opts.prefixOverride}${message}` : message;
  }
  return REPLY_PREFIX ? `${REPLY_PREFIX}${message}` : message;
}

function splitLongMessage(message, maxLength = MAX_MESSAGE_LENGTH) {
  const text = String(message || '');
  if (!text) return [];
  if (!Number.isFinite(maxLength) || maxLength < 1 || text.length <= maxLength) {
    return [text];
  }

  const chunks = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf('\n', maxLength);
    if (splitAt < Math.floor(maxLength / 2)) {
      splitAt = remaining.lastIndexOf(' ', maxLength);
    }
    if (splitAt < 1) splitAt = maxLength;

    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function trackSentMessageId(sent) {
  if (sent?.key?.id) {
    recentlySentIds.add(sent.key.id);
    if (recentlySentIds.size > MAX_RECENT_IDS) {
      recentlySentIds.delete(recentlySentIds.values().next().value);
    }
  }
}

function normalizeWhatsAppId(value) {
  if (!value) return '';
  return String(value).replace(':', '@');
}

function getMessageContent(msg) {
  const content = msg?.message || {};
  if (content.ephemeralMessage?.message) return content.ephemeralMessage.message;
  if (content.viewOnceMessage?.message) return content.viewOnceMessage.message;
  if (content.viewOnceMessageV2?.message) return content.viewOnceMessageV2.message;
  if (content.documentWithCaptionMessage?.message) return content.documentWithCaptionMessage.message;
  if (content.templateMessage?.hydratedTemplate) return content.templateMessage.hydratedTemplate;
  if (content.buttonsMessage) return content.buttonsMessage;
  if (content.listMessage) return content.listMessage;
  return content;
}

function getContextInfo(messageContent) {
  if (!messageContent || typeof messageContent !== 'object') return {};
  for (const value of Object.values(messageContent)) {
    if (value && typeof value === 'object' && value.contextInfo) {
      return value.contextInfo;
    }
  }
  return {};
}

/**
 * Synchronously extract the text body from a message (no media download).
 * Returns '' if the message has no extractable text.
 */
function extractText(msg) {
  const messageContent = getMessageContent(msg);
  if (messageContent.conversation) return messageContent.conversation;
  if (messageContent.extendedTextMessage?.text) return messageContent.extendedTextMessage.text;
  if (messageContent.imageMessage?.caption) return messageContent.imageMessage.caption;
  if (messageContent.videoMessage?.caption) return messageContent.videoMessage.caption;
  if (messageContent.documentMessage?.caption) return messageContent.documentMessage.caption;
  return '';
}

/**
 * Pure routing function: given a raw Baileys message and runtime options,
 * returns a decision object:
 *   { action: 'ignore', reason: string }
 *   { action: 'forward', payload: object }
 *
 * NOTE: this function does NOT perform the isSelfChat number check (which
 * requires sock.user), allowlist checks, echo-back dedup, or media download.
 * Those remain in the messages.upsert handler.
 *
 * @param {object} msg - Raw Baileys message
 * @param {object} opts
 * @param {string} opts.mode - 'self-chat' | 'bot'
 * @param {boolean} [opts.observeNonSelf] - defaults to module-level OBSERVE_NON_SELF
 */
export function processIncoming(msg, { mode, observeNonSelf = OBSERVE_NON_SELF }) {
  const chatId = msg.key.remoteJid;
  const fromMe = !!msg.key.fromMe;
  const isGroup = chatId.endsWith('@g.us');
  const isBroadcast = chatId.includes('status') || chatId.endsWith('@broadcast');

  if (isBroadcast) return { action: 'ignore', reason: 'broadcast' };

  const senderId = msg.key.participant || msg.key.remoteJid;
  const body = extractText(msg);
  const payload = {
    chatId,
    fromMe,
    isGroup,
    senderId,
    senderName: msg.pushName || '',
    messageId: msg.key.id,
    timestamp: msg.messageTimestamp,
    body,
    media: null,
  };

  if (fromMe) {
    if (mode === 'self-chat' && !isGroup) {
      // The user's own message to themselves — process normally.
      // Tag if the bridge originated this send so downstream hook handlers
      // can distinguish bot replies from messages the user typed manually.
      if (isHermesOrigin(chatId, msg.key.id)) {
        payload.hermes_origin = true;
      }
      return { action: 'forward', payload };
    }
    if (mode === 'self-chat' && isGroup) {
      if (observeNonSelf) {
        return { action: 'forward', payload: { ...payload, observe_only: true } };
      }
      return { action: 'ignore', reason: 'self_chat_skip_own_group' };
    }
    // Bot mode: fromMe messages are echo-backs of our own replies — skip.
    return { action: 'ignore', reason: 'bot_mode_echo' };
  }

  // !fromMe path
  if (mode === 'self-chat') {
    if (observeNonSelf) {
      appendUnread(chatId, {
        remoteJid: chatId,
        id: msg.key.id,
        ...(msg.key.participant ? { participant: msg.key.participant } : {}),
      });
      return { action: 'forward', payload: { ...payload, observe_only: true } };
    }
    return { action: 'ignore', reason: 'self_chat_mode_rejects_non_self' };
  }

  // Bot mode: forward for allowlist check in the handler.
  appendUnread(chatId, {
    remoteJid: chatId,
    id: msg.key.id,
    ...(msg.key.participant ? { participant: msg.key.participant } : {}),
  });
  return { action: 'forward', payload };
}

mkdirSync(SESSION_DIR, { recursive: true });

// Build LID → phone reverse map from session files (lid-mapping-{phone}.json)
function buildLidMap() {
  const map = {};
  try {
    for (const f of readdirSync(SESSION_DIR)) {
      const m = f.match(/^lid-mapping-(\d+)\.json$/);
      if (!m) continue;
      const phone = m[1];
      const lid = JSON.parse(readFileSync(path.join(SESSION_DIR, f), 'utf8'));
      if (lid) map[String(lid)] = phone;
    }
  } catch {}
  return map;
}
let lidToPhone = buildLidMap();

const logger = pino({ level: 'warn' });

// Message queue for polling
const messageQueue = [];
const MAX_QUEUE_SIZE = 100;

// Track recently sent message IDs to prevent echo-back loops with media
const recentlySentIds = new Set();
const MAX_RECENT_IDS = 50;

// --- Hermes-origin tagging (Task 3) ---
// Time window (ms) within which a fromMe message is considered hermes-originated
// if we don't have the exact message ID (fallback path).
const RECENT_WINDOW_MS = 10_000;

// Set of message IDs that Hermes sent via the HTTP /send endpoint.
// Entries are removed after ~30 s so they don't accumulate indefinitely.
const HERMES_SENT_IDS = new Set();

// Map of chatId → timestamp (ms) of the last hermes send on that chat.
const HERMES_RECENT_BY_CHAT = new Map();

/**
 * Record that Hermes sent a message with the given ID to the given chat.
 * Called from the HTTP send endpoints after sock.sendMessage() returns.
 */
export function recordHermesSend(chatId, messageId) {
  if (messageId) {
    HERMES_SENT_IDS.add(messageId);
    const timer = setTimeout(() => HERMES_SENT_IDS.delete(messageId), 30_000);
    timer.unref?.();
  }
  if (chatId) {
    HERMES_RECENT_BY_CHAT.set(chatId, Date.now());
    const timer = setTimeout(() => {
      // Only delete if the timestamp hasn't been refreshed
      const ts = HERMES_RECENT_BY_CHAT.get(chatId);
      if (ts !== undefined && Date.now() - ts >= 30_000) {
        HERMES_RECENT_BY_CHAT.delete(chatId);
      }
    }, 30_000);
    timer.unref?.();
  }
}

/**
 * Manually record a recent hermes send timestamp for a chat (used in tests /
 * fallback path when message ID is unavailable).
 */
export function markRecentHermesSendForChat(chatId, tsMs) {
  if (chatId) {
    HERMES_RECENT_BY_CHAT.set(chatId, tsMs);
  }
}

// --- Task 4: Per-chat unread-keys queue ---
// Tracks message keys for !fromMe messages that have been forwarded but not yet
// marked read. Drained by the HTTP send endpoints when mark_read=true.
const UNREAD_KEYS = new Map();

/**
 * Append a message key to the per-chat unread queue.
 * @param {string} chatId
 * @param {{ remoteJid: string, id: string, participant?: string }} key
 */
function appendUnread(chatId, key) {
  if (!UNREAD_KEYS.has(chatId)) UNREAD_KEYS.set(chatId, []);
  UNREAD_KEYS.get(chatId).push(key);
}

/**
 * Return a copy of the unread keys for the given chat (non-destructive).
 * @param {string} chatId
 * @returns {Array}
 */
export function getUnreadKeysForChat(chatId) {
  return [...(UNREAD_KEYS.get(chatId) || [])];
}

/**
 * Drain (remove and return) all unread keys for the given chat.
 * @param {string} chatId
 * @returns {Array}
 */
export function drainUnreadKeysForChat(chatId) {
  const keys = UNREAD_KEYS.get(chatId) || [];
  UNREAD_KEYS.delete(chatId);
  return keys;
}

/**
 * Returns true if the given message appears to have originated from Hermes.
 * Uses either an exact message-ID match or a recency window fallback.
 */
function isHermesOrigin(chatId, messageId) {
  if (messageId && HERMES_SENT_IDS.has(messageId)) return true;
  const lastSent = HERMES_RECENT_BY_CHAT.get(chatId);
  if (lastSent !== undefined && Date.now() - lastSent <= RECENT_WINDOW_MS) return true;
  return false;
}

// --- Task 5: Typing config and helpers ---
const TYPING_CFG = {
  enabled: (process.env.WHATSAPP_TYPING_ENABLED ?? 'true').toLowerCase() === 'true',
  charsPerSecond: Number(process.env.WHATSAPP_TYPING_CPS ?? 15),
  min: Number(process.env.WHATSAPP_TYPING_MIN_SECONDS ?? 1),
  max: Number(process.env.WHATSAPP_TYPING_MAX_SECONDS ?? 8),
};

/**
 * Compute how many seconds to show the typing indicator before sending.
 * Scales linearly with message length, clamped to [cfg.min, cfg.max].
 * @param {string|null} text
 * @param {{ charsPerSecond?: number, min?: number, max?: number }} [cfg]
 * @returns {number}
 */
export function computeTypingSeconds(text, cfg = TYPING_CFG) {
  const len = (text || '').length;
  const cps = cfg.charsPerSecond ?? TYPING_CFG.charsPerSecond;
  const min = cfg.min ?? TYPING_CFG.min;
  const max = cfg.max ?? TYPING_CFG.max;
  return Math.max(min, Math.min(max, Math.round(len / cps)));
}

/**
 * Send composing presence, wait, send paused, then invoke the provided send
 * function (defaults to sock.sendMessage).
 * @param {object} sock - Baileys socket
 * @param {string} chatId
 * @param {string} text
 * @param {{ typingEnabled?: boolean, typingSeconds?: number, sendFn?: Function }} [opts]
 * @returns {Promise}
 */
async function performTypingAndSend(sock, chatId, text, opts = {}) {
  const typingEnabled = opts.typingEnabled !== false && TYPING_CFG.enabled !== false;
  if (typingEnabled) {
    await sock.sendPresenceUpdate('composing', chatId);
    const secs = opts.typingSeconds ?? computeTypingSeconds(text);
    await sleep(secs * 1000);
    await sock.sendPresenceUpdate('paused', chatId);
  }
  const sendFn = opts.sendFn ?? ((cid, payload) => sock.sendMessage(cid, payload));
  return sendFn(chatId, { text });
}

let sock = null;
let connectionState = 'disconnected';

async function startSocket() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: ['Hermes Agent', 'Desktop', '120.0'],
    syncFullHistory: true,
    markOnlineOnConnect: false,
    // Required for Baileys 7.x: without this, incoming messages that need
    // E2EE session re-establishment are silently dropped (msg.message === null)
    getMessage: async (key) => {
      // We don't maintain a message store, so return a placeholder.
      // This is enough for Baileys to complete the retry handshake.
      return { conversation: '' };
    },
  });

  sock.ev.on('creds.update', () => { saveCreds(); lidToPhone = buildLidMap(); });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n📱 Scan this QR code with WhatsApp on your phone:\n');
      qrcode.generate(qr, { small: true });
      console.log('\nWaiting for scan...\n');
    }

    if (connection === 'close') {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      connectionState = 'disconnected';

      if (reason === DisconnectReason.loggedOut) {
        console.log('❌ Logged out. Delete session and restart to re-authenticate.');
        process.exit(1);
      } else {
        // 515 = restart requested (common after pairing). Always reconnect.
        if (reason === 515) {
          console.log('↻ WhatsApp requested restart (code 515). Reconnecting...');
        } else {
          console.log(`⚠️  Connection closed (reason: ${reason}). Reconnecting in 3s...`);
        }
        setTimeout(startSocket, reason === 515 ? 1000 : 3000);
      }
    } else if (connection === 'open') {
      connectionState = 'connected';
      console.log('✅ WhatsApp connected!');
      if (PAIR_ONLY) {
        console.log('✅ Pairing complete. Credentials saved.');
        // Give Baileys a moment to flush creds, then exit cleanly
        setTimeout(() => process.exit(0), 2000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // In self-chat mode, your own messages commonly arrive as 'append' rather
    // than 'notify'. Accept both and filter agent echo-backs below.
    if (type !== 'notify' && type !== 'append') return;

    const botIds = Array.from(new Set([
      normalizeWhatsAppId(sock.user?.id),
      normalizeWhatsAppId(sock.user?.lid),
    ].filter(Boolean)));

    for (const msg of messages) {
      if (!msg.message) continue;

      const chatId = msg.key.remoteJid;
      if (WHATSAPP_DEBUG) {
        try {
          console.log(JSON.stringify({
            event: 'upsert', type,
            fromMe: !!msg.key.fromMe, chatId,
            senderId: msg.key.participant || chatId,
            messageKeys: Object.keys(msg.message || {}),
          }));
        } catch {}
      }
      const senderId = msg.key.participant || chatId;
      const isGroup = chatId.endsWith('@g.us');
      const senderNumber = senderId.replace(/@.*/, '');

      // Use processIncoming to decide whether to forward or ignore this message.
      const decision = processIncoming(msg, { mode: WHATSAPP_MODE });
      if (decision.action === 'ignore') {
        try {
          console.log(JSON.stringify({
            event: 'ignored',
            reason: decision.reason,
            chatId,
            senderId,
          }));
        } catch {}
        continue;
      }

      // decision.action === 'forward'
      // For fromMe self-chat messages processIncoming returns forward, but we
      // must still verify it is actually the user's own self-chat by number
      // (WhatsApp uses LID/classic formats). This guards against edge cases
      // where fromMe is set on a non-self-chat DM.
      if (msg.key.fromMe && WHATSAPP_MODE === 'self-chat' && !isGroup) {
        const myNumber = (sock.user?.id || '').replace(/:.*@/, '@').replace(/@.*/, '');
        const myLid = (sock.user?.lid || '').replace(/:.*@/, '@').replace(/@.*/, '');
        const chatNumber = chatId.replace(/@.*/, '');
        const isSelfChat = (myNumber && chatNumber === myNumber) || (myLid && chatNumber === myLid);
        if (!isSelfChat) continue;
      }

      // For bot-mode !fromMe messages, apply the allowlist check.
      if (!msg.key.fromMe && WHATSAPP_MODE !== 'self-chat' && !decision.payload?.observe_only) {
        if (!matchesAllowedUser(senderId, ALLOWED_USERS, SESSION_DIR)) {
          try {
            console.log(JSON.stringify({
              event: 'ignored',
              reason: 'allowlist_mismatch',
              chatId,
              senderId,
            }));
          } catch {}
          continue;
        }
      }

      const messageContent = getMessageContent(msg);
      const contextInfo = getContextInfo(messageContent);
      const mentionedIds = Array.from(new Set((contextInfo?.mentionedJid || []).map(normalizeWhatsAppId).filter(Boolean)));
      const quotedMessageId = contextInfo?.stanzaId || null;
      const quotedParticipant = normalizeWhatsAppId(contextInfo?.participant || '') || null;
      const quotedRemoteJid = normalizeWhatsAppId(contextInfo?.remoteJid || '') || null;
      const hasQuotedMessage = !!contextInfo?.quotedMessage;

      // Extract message body
      let body = '';
      let hasMedia = false;
      let mediaType = '';
      const mediaUrls = [];

      if (messageContent.conversation) {
        body = messageContent.conversation;
      } else if (messageContent.extendedTextMessage?.text) {
        body = messageContent.extendedTextMessage.text;
      } else if (messageContent.imageMessage) {
        body = messageContent.imageMessage.caption || '';
        hasMedia = true;
        mediaType = 'image';
        try {
          const buf = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
          const mime = messageContent.imageMessage.mimetype || 'image/jpeg';
          const extMap = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };
          const ext = extMap[mime] || '.jpg';
          mkdirSync(IMAGE_CACHE_DIR, { recursive: true });
          const filePath = path.join(IMAGE_CACHE_DIR, `img_${randomBytes(6).toString('hex')}${ext}`);
          writeFileSync(filePath, buf);
          mediaUrls.push(filePath);
        } catch (err) {
          console.error('[bridge] Failed to download image:', err.message);
        }
      } else if (messageContent.videoMessage) {
        body = messageContent.videoMessage.caption || '';
        hasMedia = true;
        mediaType = 'video';
        try {
          const buf = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
          const mime = messageContent.videoMessage.mimetype || 'video/mp4';
          const ext = mime.includes('mp4') ? '.mp4' : '.mkv';
          mkdirSync(DOCUMENT_CACHE_DIR, { recursive: true });
          const filePath = path.join(DOCUMENT_CACHE_DIR, `vid_${randomBytes(6).toString('hex')}${ext}`);
          writeFileSync(filePath, buf);
          mediaUrls.push(filePath);
        } catch (err) {
          console.error('[bridge] Failed to download video:', err.message);
        }
      } else if (messageContent.audioMessage || messageContent.pttMessage) {
        hasMedia = true;
        mediaType = messageContent.pttMessage ? 'ptt' : 'audio';
        try {
          const audioMsg = messageContent.pttMessage || messageContent.audioMessage;
          const buf = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
          const mime = audioMsg.mimetype || 'audio/ogg';
          const ext = mime.includes('ogg') ? '.ogg' : mime.includes('mp4') ? '.m4a' : '.ogg';
          mkdirSync(AUDIO_CACHE_DIR, { recursive: true });
          const filePath = path.join(AUDIO_CACHE_DIR, `aud_${randomBytes(6).toString('hex')}${ext}`);
          writeFileSync(filePath, buf);
          mediaUrls.push(filePath);
        } catch (err) {
          console.error('[bridge] Failed to download audio:', err.message);
        }
      } else if (messageContent.documentMessage) {
        body = messageContent.documentMessage.caption || '';
        hasMedia = true;
        mediaType = 'document';
        const fileName = messageContent.documentMessage.fileName || 'document';
        try {
          const buf = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
          mkdirSync(DOCUMENT_CACHE_DIR, { recursive: true });
          const safeFileName = path.basename(fileName).replace(/[^a-zA-Z0-9._-]/g, '_');
          const filePath = path.join(DOCUMENT_CACHE_DIR, `doc_${randomBytes(6).toString('hex')}_${safeFileName}`);
          writeFileSync(filePath, buf);
          mediaUrls.push(filePath);
        } catch (err) {
          console.error('[bridge] Failed to download document:', err.message);
        }
      }

      // For media without caption, use a placeholder so the API message is never empty
      if (hasMedia && !body) {
        body = `[${mediaType} received]`;
      }

      // Ignore Hermes' own reply messages in self-chat mode to avoid loops.
      if (msg.key.fromMe && ((REPLY_PREFIX && body.startsWith(REPLY_PREFIX)) || recentlySentIds.has(msg.key.id))) {
        if (WHATSAPP_DEBUG) {
          try { console.log(JSON.stringify({ event: 'ignored', reason: 'agent_echo', chatId, messageId: msg.key.id })); } catch {}
        }
        continue;
      }

      // Skip empty messages
      if (!body && !hasMedia) {
        if (WHATSAPP_DEBUG) {
          try { 
            console.log(JSON.stringify({ event: 'ignored', reason: 'empty', chatId, messageKeys: Object.keys(msg.message || {}) })); 
          } catch (err) {
            console.error('Failed to log empty message event:', err);
          }
        }
        continue;
      }

      const event = {
        messageId: msg.key.id,
        chatId,
        senderId,
        senderName: msg.pushName || senderNumber,
        chatName: isGroup ? (chatId.split('@')[0]) : (msg.pushName || senderNumber),
        isGroup,
        body,
        hasMedia,
        mediaType,
        mediaUrls,
        mentionedIds,
        quotedMessageId,
        quotedParticipant,
        quotedRemoteJid,
        hasQuotedMessage,
        botIds,
        timestamp: msg.messageTimestamp,
        ...(decision.payload?.observe_only ? { observe_only: true } : {}),
      };

      messageQueue.push(event);
      if (messageQueue.length > MAX_QUEUE_SIZE) {
        messageQueue.shift();
      }
    }
  });
}

// HTTP server
const app = express();
app.use(express.json());

// Host-header validation — defends against DNS rebinding.
// The bridge binds loopback-only (127.0.0.1) but a victim browser on
// the same machine could be tricked into fetching from an attacker
// hostname that TTL-flips to 127.0.0.1. Reject any request whose Host
// header doesn't resolve to a loopback alias.
// See GHSA-ppp5-vxwm-4cf7.
const _ACCEPTED_HOST_VALUES = new Set([
  'localhost',
  '127.0.0.1',
  '[::1]',
  '::1',
]);

app.use((req, res, next) => {
  const raw = (req.headers.host || '').trim();
  if (!raw) {
    return res.status(400).json({ error: 'Missing Host header' });
  }
  // Strip port suffix: "localhost:3000" → "localhost"
  const hostOnly = (raw.includes(':')
    ? raw.substring(0, raw.lastIndexOf(':'))
    : raw
  ).replace(/^\[|\]$/g, '').toLowerCase();
  if (!_ACCEPTED_HOST_VALUES.has(hostOnly)) {
    return res.status(400).json({
      error: 'Invalid Host header. Bridge accepts loopback hosts only.',
    });
  }
  next();
});

// Poll for new messages (long-poll style)
app.get('/messages', (req, res) => {
  const msgs = messageQueue.splice(0, messageQueue.length);
  res.json(msgs);
});

// Send a message
app.post('/send', async (req, res) => {
  if (!sock || connectionState !== 'connected') {
    return res.status(503).json({ error: 'Not connected to WhatsApp' });
  }

  const {
    chatId,
    message,
    replyTo,
    mark_read: markRead = false,
    typing_enabled: typingEnabled = true,
    typing_seconds: typingSeconds,
    prefix_override: prefixOverride,
  } = req.body;
  if (!chatId || !message) {
    return res.status(400).json({ error: 'chatId and message are required' });
  }

  const fmtOpts = prefixOverride !== undefined ? { prefixOverride } : {};

  try {
    // mark_read: drain unread keys and mark them read before sending
    if (markRead) {
      const keys = drainUnreadKeysForChat(chatId);
      if (keys.length > 0 && sock.readMessages) {
        await sock.readMessages(keys);
      }
    }

    const chunks = splitLongMessage(formatOutgoingMessage(message, fmtOpts));
    const messageIds = [];
    for (let i = 0; i < chunks.length; i += 1) {
      // Typing indicator only before the first chunk; subsequent chunks send immediately.
      const sent = i === 0
        ? await performTypingAndSend(sock, chatId, chunks[i], {
            typingEnabled,
            ...(typingSeconds !== undefined ? { typingSeconds } : {}),
            sendFn: (cid, payload) => sendWithTimeout(cid, payload),
          })
        : await sendWithTimeout(chatId, { text: chunks[i] });
      trackSentMessageId(sent);
      if (sent?.key?.id) {
        messageIds.push(sent.key.id);
        recordHermesSend(chatId, sent.key.id);
      }
      if (chunks.length > 1 && i < chunks.length - 1) {
        await sleep(CHUNK_DELAY_MS);
      }
    }

    res.json({
      success: true,
      messageId: messageIds[messageIds.length - 1],
      messageIds,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Edit a previously sent message
app.post('/edit', async (req, res) => {
  if (!sock || connectionState !== 'connected') {
    return res.status(503).json({ error: 'Not connected to WhatsApp' });
  }

  const { chatId, messageId, message } = req.body;
  if (!chatId || !messageId || !message) {
    return res.status(400).json({ error: 'chatId, messageId, and message are required' });
  }

  try {
    const key = { id: messageId, fromMe: true, remoteJid: chatId };
    const chunks = splitLongMessage(formatOutgoingMessage(message));
    const messageIds = [];

    await sendWithTimeout(chatId, { text: chunks[0], edit: key });
    if (chunks.length > 1) {
      for (let i = 1; i < chunks.length; i += 1) {
        const sent = await sendWithTimeout(chatId, { text: chunks[i] });
        trackSentMessageId(sent);
        if (sent?.key?.id) messageIds.push(sent.key.id);
        if (i < chunks.length - 1) {
          await sleep(CHUNK_DELAY_MS);
        }
      }
    }

    res.json({ success: true, messageIds });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// MIME type map and media type inference for /send-media
const MIME_MAP = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  webp: 'image/webp', gif: 'image/gif',
  mp4: 'video/mp4', mov: 'video/quicktime', avi: 'video/x-msvideo',
  mkv: 'video/x-matroska', '3gp': 'video/3gpp',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

function inferMediaType(ext) {
  if (['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext)) return 'image';
  if (['mp4', 'mov', 'avi', 'mkv', '3gp'].includes(ext)) return 'video';
  if (['ogg', 'opus', 'mp3', 'wav', 'm4a'].includes(ext)) return 'audio';
  return 'document';
}

// Send media (image, video, document) natively
app.post('/send-media', async (req, res) => {
  if (!sock || connectionState !== 'connected') {
    return res.status(503).json({ error: 'Not connected to WhatsApp' });
  }

  const {
    chatId,
    filePath,
    mediaType,
    caption,
    fileName,
    mark_read: markRead = false,
    typing_enabled: typingEnabled = true,
    typing_seconds: typingSeconds,
  } = req.body;
  if (!chatId || !filePath) {
    return res.status(400).json({ error: 'chatId and filePath are required' });
  }

  try {
    // mark_read: drain unread keys and mark them read before sending
    if (markRead) {
      const keys = drainUnreadKeysForChat(chatId);
      if (keys.length > 0 && sock.readMessages) {
        await sock.readMessages(keys);
      }
    }

    // typing indicator before media send (uses caption text for duration calc)
    const typingEnabled_ = typingEnabled !== false && TYPING_CFG.enabled !== false;
    if (typingEnabled_) {
      await sock.sendPresenceUpdate('composing', chatId);
      const secs = typingSeconds ?? computeTypingSeconds(caption || '');
      await sleep(secs * 1000);
      await sock.sendPresenceUpdate('paused', chatId);
    }

    if (!existsSync(filePath)) {
      return res.status(404).json({ error: `File not found: ${filePath}` });
    }

    const buffer = readFileSync(filePath);
    const ext = filePath.toLowerCase().split('.').pop();
    const type = mediaType || inferMediaType(ext);
    let msgPayload;

    switch (type) {
      case 'image':
        msgPayload = { image: buffer, caption: caption || undefined, mimetype: MIME_MAP[ext] || 'image/jpeg' };
        break;
      case 'video':
        msgPayload = { video: buffer, caption: caption || undefined, mimetype: MIME_MAP[ext] || 'video/mp4' };
        break;
      case 'audio': {
        // WhatsApp only renders a native voice bubble (ptt) when the file is ogg/opus.
        // If the caller passes mp3, wav, m4a etc. (e.g. from Edge TTS / NeuTTS),
        // silently convert to ogg/opus via ffmpeg so ptt is always honoured.
        let audioBuffer = buffer;
        let audioExt = ext;
        const needsConversion = !['ogg', 'opus'].includes(ext);
        let tmpPath = null;
        if (needsConversion) {
          tmpPath = path.join(tmpdir(), `hermes_voice_${randomBytes(6).toString('hex')}.ogg`);
          try {
            execSync(
              `ffmpeg -y -i ${JSON.stringify(filePath)} -ar 48000 -ac 1 -c:a libopus ${JSON.stringify(tmpPath)}`,
              { timeout: 30000, stdio: 'pipe' }
            );
            audioBuffer = readFileSync(tmpPath);
            audioExt = 'ogg';
          } catch (convErr) {
            // ffmpeg not available or conversion failed — fall back to original format
            console.warn('[bridge] ffmpeg conversion failed, sending as file attachment:', convErr.message);
          } finally {
            try { if (tmpPath && existsSync(tmpPath)) unlinkSync(tmpPath); } catch (_) {}
          }
        }
        const audioMime = (audioExt === 'ogg' || audioExt === 'opus') ? 'audio/ogg; codecs=opus' : 'audio/mpeg';
        msgPayload = { audio: audioBuffer, mimetype: audioMime, ptt: audioExt === 'ogg' || audioExt === 'opus' };
        break;
      }
      case 'document':
      default:
        msgPayload = {
          document: buffer,
          fileName: fileName || path.basename(filePath),
          caption: caption || undefined,
          mimetype: MIME_MAP[ext] || 'application/octet-stream',
        };
        break;
    }

    const sent = await sendWithTimeout(chatId, msgPayload);

    trackSentMessageId(sent);
    if (sent?.key?.id) recordHermesSend(chatId, sent.key.id);

    res.json({ success: true, messageId: sent?.key?.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Typing indicator
app.post('/typing', async (req, res) => {
  if (!sock || connectionState !== 'connected') {
    return res.status(503).json({ error: 'Not connected' });
  }

  const { chatId } = req.body;
  if (!chatId) return res.status(400).json({ error: 'chatId required' });

  try {
    await sock.sendPresenceUpdate('composing', chatId);
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false });
  }
});

// Mark a chat as read without sending anything. Drains the per-chat
// unread-keys queue (populated on every observed inbound) and calls
// sock.readMessages so blue ticks land on the sender's side. Idempotent —
// if there are no queued keys, this is a no-op and returns count=0.
app.post('/mark-read', async (req, res) => {
  if (!sock || connectionState !== 'connected') {
    return res.status(503).json({ error: 'Not connected' });
  }

  const { chatId } = req.body;
  if (!chatId) return res.status(400).json({ error: 'chatId required' });

  try {
    const keys = drainUnreadKeysForChat(chatId);
    if (keys.length === 0) {
      return res.json({ success: true, marked: 0 });
    }
    if (!sock.readMessages) {
      // Older Baileys without readMessages support — silently no-op so the
      // tool call doesn't surface as a failure to the agent.
      return res.json({ success: true, marked: 0, note: 'readMessages unavailable' });
    }
    await sock.readMessages(keys);
    res.json({ success: true, marked: keys.length });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Backfill history for a specific chat.
// POST /backfill { chatId, days?, count?, oldest_message_id?, oldest_timestamp? }
//
// Asks Baileys to fetch server-side history older than the provided anchor
// point (or the current time if none given). Because fetchMessageHistory in
// Baileys 7.x is event-driven — it issues a peer-data-operation request and
// messages arrive asynchronously via 'messaging-history.set' — this handler
// sets up a one-shot listener correlated by peerDataRequestSessionId, then
// loops until it has collected enough messages or timed out.
//
// Returns:
//   { success: true, fetched: N, oldest_ts: <ISO>, newest_ts: <ISO>, messages: [...] }
//   { success: false, error: "<message>", partial: [...] }
const BACKFILL_TIMEOUT_MS = parseInt(process.env.WHATSAPP_BACKFILL_TIMEOUT_MS || '30000', 10);
const BACKFILL_EMPTY_RETRY = 1; // retry once if first batch is empty

/**
 * Build a message payload identical in shape to what processIncoming / the
 * messages.upsert handler would produce, but for a history-sync message.
 * Media is intentionally skipped in v1 (media_ref = null).
 */
function buildBackfillRecord(msg) {
  const chatId = msg.key?.remoteJid;
  if (!chatId) return null;
  const isBroadcast = chatId.includes('status') || chatId.endsWith('@broadcast');
  if (isBroadcast) return null;
  const fromMe = !!msg.key?.fromMe;
  const isGroup = chatId.endsWith('@g.us');
  const senderId = msg.key?.participant || chatId;
  const body = extractText(msg);
  const messageContent = getMessageContent(msg);
  // Determine kind from message content (no download — placeholders only)
  let kind = 'text';
  let mediaRef = null;
  if (messageContent.imageMessage) kind = 'image';
  else if (messageContent.videoMessage) kind = 'video';
  else if (messageContent.audioMessage || messageContent.pttMessage) kind = messageContent.pttMessage ? 'ptt' : 'audio';
  else if (messageContent.documentMessage) kind = 'document';
  else if (messageContent.stickerMessage) kind = 'sticker';
  // msg.messageTimestamp is a protobuf Long in Baileys 7.x; JSON.stringify
  // serializes Long objects as {low, high, unsigned} which Python's
  // archive.write_message can't parse — it then falls back to now(),
  // wiping the real message timestamp. Coerce to a plain Unix seconds
  // number here so the wire payload is JSON-clean.
  const tsRaw = msg.messageTimestamp;
  let timestamp = null;
  if (typeof tsRaw === 'number') {
    timestamp = tsRaw;
  } else if (typeof tsRaw === 'string') {
    timestamp = parseInt(tsRaw, 10);
  } else if (tsRaw && typeof tsRaw.toNumber === 'function') {
    timestamp = tsRaw.toNumber();
  } else if (tsRaw && typeof tsRaw === 'object' && 'low' in tsRaw) {
    timestamp = tsRaw.low + (tsRaw.high || 0) * 0x100000000;
  }

  // Backfilled messages don't carry msg.pushName (that's a live-only field).
  // Best-effort fallback: if the senderId is a LID we have a reverse
  // mapping for, surface the resolved phone number as sender_e164 AND use
  // it as the displayed sender_name when no other name is available. The
  // lidToPhone map is built from the session's lid-mapping-*.json files
  // and refreshed on every creds.update event.
  let resolvedE164 = null;
  if (senderId && senderId.endsWith('@lid')) {
    const lidValue = senderId.split('@', 1)[0];
    const phone = lidToPhone[lidValue];
    if (phone) {
      resolvedE164 = '+' + phone;
    }
  } else if (senderId && senderId.endsWith('@s.whatsapp.net')) {
    const phonePart = senderId.split('@', 1)[0];
    if (/^\d+$/.test(phonePart)) {
      resolvedE164 = '+' + phonePart;
    }
  }
  const senderName = msg.pushName || resolvedE164 || '';

  return {
    messageId: msg.key?.id,
    chatId,
    fromMe,
    isGroup,
    senderId,
    senderName,
    sender_e164: resolvedE164,
    body: body || (kind !== 'text' ? `[${kind} received]` : ''),
    kind,
    media_ref: mediaRef,
    timestamp,
    isGroup,
    observe_only: false,
    hermes_origin: false,
  };
}

/**
 * Wait for a 'messaging-history.set' event whose peerDataRequestSessionId
 * matches requestId. Resolves with the event payload or rejects on timeout.
 */
function waitForHistoryEvent(requestId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      sock.ev.off('messaging-history.set', handler);
      reject(new Error('timeout'));
    }, timeoutMs);

    function handler(event) {
      // Match by peerDataRequestSessionId when present; fall back to accepting
      // any ON_DEMAND sync event if the sessionId is absent (Baileys race).
      const sid = event.peerDataRequestSessionId;
      if (sid && sid !== requestId) return;
      clearTimeout(timer);
      sock.ev.off('messaging-history.set', handler);
      resolve(event);
    }

    sock.ev.on('messaging-history.set', handler);
  });
}

app.post('/backfill', async (req, res) => {
  if (!sock || connectionState !== 'connected') {
    return res.status(503).json({ error: 'Not connected to WhatsApp' });
  }

  const {
    chatId,
    days = 10,
    count = 500,
    oldest_message_id: oldestMsgId,
    oldest_timestamp: oldestTs,
  } = req.body || {};

  if (!chatId) {
    return res.status(400).json({ error: 'chatId is required' });
  }

  const cutoffTs = Date.now() / 1000 - days * 86400;
  const maxCount = Math.max(1, parseInt(count, 10) || 500);

  // fetchMessageHistory needs a REAL anchor key (a message that exists in
  // this chat on WhatsApp's server) — it fetches messages OLDER than that
  // anchor. Without one, the PDO request either returns empty or times
  // out (silent — there's no "invalid anchor" error from WhatsApp).
  //
  // Earlier we passed `id: 'NONE'` as a placeholder; that silently produced
  // garbage results indistinguishable from "no history available". Refuse
  // the request explicitly instead and let the caller skip the chat with
  // a clear reason.
  if (!oldestMsgId) {
    return res.json({
      success: false,
      error: 'no_anchor',
      reason:
        'fetchMessageHistory requires a real existing message id from this chat as anchor. ' +
        'Caller must supply oldest_message_id (and oldest_timestamp). ' +
        'For empty-archive chats, there is no anchor available and history ' +
        'cannot be fetched without observing live traffic first.',
    });
  }

  // Build the anchor key from caller-supplied ids.
  let anchorKey = {
    remoteJid: chatId,
    fromMe: false,
    id: oldestMsgId,
  };
  let anchorTs = oldestTs ? Number(oldestTs) : Math.floor(Date.now() / 1000);

  const collected = [];
  let emptyRetries = 0;

  try {
    while (collected.length < maxCount) {
      // Issue the request — fetchMessageHistory returns a peer-op message ID
      // (which serves as peerDataRequestSessionId in the response event).
      const requestId = await sock.fetchMessageHistory(
        Math.min(maxCount - collected.length, 100),
        anchorKey,
        anchorTs * 1000, // Baileys expects ms for the PDO request
      );

      let event;
      try {
        event = await waitForHistoryEvent(requestId, BACKFILL_TIMEOUT_MS);
      } catch (timeoutErr) {
        // Timeout — return whatever we have so far.
        return res.json({
          success: false,
          error: 'timeout',
          partial: collected,
        });
      }

      const msgs = event.messages || [];
      if (msgs.length === 0) {
        emptyRetries += 1;
        if (emptyRetries > BACKFILL_EMPTY_RETRY) break;
        continue;
      }
      emptyRetries = 0;

      let reachedCutoff = false;
      for (const msg of msgs) {
        const ts = Number(msg.messageTimestamp || 0);
        if (ts > 0 && ts < cutoffTs) {
          reachedCutoff = true;
          continue; // skip messages older than requested window
        }
        const record = buildBackfillRecord(msg);
        if (record) collected.push(record);
      }

      if (reachedCutoff) break;

      // Advance anchor to the oldest message in this batch for the next loop.
      const sorted = msgs
        .filter(m => m.key?.id && m.messageTimestamp)
        .sort((a, b) => Number(a.messageTimestamp) - Number(b.messageTimestamp));
      if (sorted.length === 0) break;
      const oldest = sorted[0];
      anchorKey = { remoteJid: chatId, fromMe: !!oldest.key.fromMe, id: oldest.key.id };
      anchorTs = Number(oldest.messageTimestamp);

      // If the server indicated this is the full history, stop looping.
      if (event.isLatest) break;
      // Avoid hammering WhatsApp between loop iterations.
      await sleep(500);
    }

    const timestamps = collected
      .map(m => m.timestamp)
      .filter(t => t && t > 0)
      .map(Number);
    const oldestTsOut = timestamps.length ? Math.min(...timestamps) : null;
    const newestTsOut = timestamps.length ? Math.max(...timestamps) : null;

    return res.json({
      success: true,
      fetched: collected.length,
      oldest_ts: oldestTsOut ? new Date(oldestTsOut * 1000).toISOString() : null,
      newest_ts: newestTsOut ? new Date(newestTsOut * 1000).toISOString() : null,
      messages: collected,
    });
  } catch (err) {
    return res.json({ success: false, error: err.message });
  }
});

// Chat info
app.get('/chat/:id', async (req, res) => {
  const chatId = req.params.id;
  const isGroup = chatId.endsWith('@g.us');

  if (isGroup && sock) {
    try {
      const metadata = await sock.groupMetadata(chatId);
      return res.json({
        name: metadata.subject,
        isGroup: true,
        participants: metadata.participants.map(p => p.id),
      });
    } catch {
      // Fall through to default
    }
  }

  res.json({
    name: chatId.replace(/@.*/, ''),
    isGroup,
    participants: [],
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: connectionState,
    queueLength: messageQueue.length,
    uptime: process.uptime(),
  });
});

// Start — only when bridge.js is the entry point, not when imported as a module.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain && PAIR_ONLY) {
  // Pair-only mode: just connect, show QR, save creds, exit. No HTTP server.
  console.log('📱 WhatsApp pairing mode');
  console.log(`📁 Session: ${SESSION_DIR}`);
  console.log();
  startSocket();
} else if (isMain) {
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`🌉 WhatsApp bridge listening on port ${PORT} (mode: ${WHATSAPP_MODE})`);
    console.log(`📁 Session stored in: ${SESSION_DIR}`);
    if (ALLOWED_USERS.size > 0) {
      console.log(`🔒 Allowed users: ${Array.from(ALLOWED_USERS).join(', ')}`);
    } else if (WHATSAPP_MODE === 'self-chat') {
      console.log(`🔒 Self-chat mode — only your own messages to yourself are processed.`);
    } else {
      console.log(`🔒 No WHATSAPP_ALLOWED_USERS set — incoming messages are rejected.`);
      console.log(`   Set WHATSAPP_ALLOWED_USERS=<phone> to authorize specific users,`);
      console.log(`   or WHATSAPP_ALLOWED_USERS=* for an explicit open bot.`);
    }
    console.log();
    startSocket();
  });
}
