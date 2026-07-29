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
 *   POST /send-location  - Send location pin { chatId, latitude, longitude, name?, address? }
 *   POST /typing         - Send typing indicator { chatId }
 *   GET  /chat/:id       - Get chat info
 *   GET  /health         - Health check
 *
 * Usage:
 *   node bridge.js --port 3000 --session ~/.hermes/whatsapp/session
 */

import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage, getAggregateVotesInPollMessage, decryptPollVote, getKeyAuthor, jidNormalizedUser } from '@whiskeysockets/baileys';
import express from 'express';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import path from 'path';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync, appendFileSync } from 'fs';
import { randomBytes, createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import qrcode from 'qrcode-terminal';
import { matchesAllowedUser, parseAllowedUsers } from './allowlist.js';
import { createOutboundIdTracker } from './outbound_ids.js';
import { classifyOwnerMessageGate } from './owner_message_gate.js';
import { DisconnectAction, classifyDisconnect, decideReconnect } from './reconnect_policy.js';
import {
  buildPollPayload,
  buildLocationPayload,
  buildTextSendPayload,
  createBoundedMessageStore,
  extractBridgeEvent,
  inboundReadReceiptKeys,
  inferMediaType,
  mediaPayloadForFile,
  pollCreationMessageFromPayload,
  pollUpdateForAggregation,
} from './bridge_helpers.js';

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

// Opt-in: when true (and WHATSAPP_MODE === 'bot'), fromMe inbound messages
// that are NOT echoes of our own /send or /send-media calls are forwarded
// to the Python adapter with `fromOwner: true`. This lets plugins detect
// "owner just typed in this customer chat" — needed for handover / sliding
// TTL flows. Default OFF: existing deployments see no behavior change.
//
// Heuristic limitation: we distinguish bot-API-sent from owner-typed by
// looking up `key.id` in `recentlySentIds` (populated when /send returns).
// On bridge restart that set is empty, so a few in-flight bot replies may
// briefly look like owner-typed until they age out. Acceptable; we don't
// persist the set.
const FORWARD_OWNER_MESSAGES =
  typeof process !== 'undefined' &&
  process.env &&
  typeof process.env.WHATSAPP_FORWARD_OWNER_MESSAGES === 'string' &&
  ['1', 'true', 'yes', 'on'].includes(process.env.WHATSAPP_FORWARD_OWNER_MESSAGES.toLowerCase());

const SEND_READ_RECEIPTS =
  typeof process !== 'undefined' &&
  process.env &&
  typeof process.env.WHATSAPP_SEND_READ_RECEIPTS === 'string' &&
  ['1', 'true', 'yes', 'on'].includes(process.env.WHATSAPP_SEND_READ_RECEIPTS.toLowerCase());

const PORT = parseInt(getArg('port', '3000'), 10);
const SESSION_DIR = getArg('session', path.join(process.env.HOME || '~', '.hermes', 'whatsapp', 'session'));
// Cache directories: the Python gateway passes the profile-aware paths via
// env (HERMES_HOME-aware, new cache/ layout).  Fall back to the legacy
// hardcoded locations for bridges launched outside the gateway.
const IMAGE_CACHE_DIR = process.env.HERMES_IMAGE_CACHE_DIR
  || path.join(process.env.HOME || '~', '.hermes', 'image_cache');
const DOCUMENT_CACHE_DIR = process.env.HERMES_DOCUMENT_CACHE_DIR
  || path.join(process.env.HOME || '~', '.hermes', 'document_cache');
const AUDIO_CACHE_DIR = process.env.HERMES_AUDIO_CACHE_DIR
  || path.join(process.env.HOME || '~', '.hermes', 'audio_cache');

// Self-hash of this script file.  Reported in /health so the Python gateway
// can detect a running bridge that predates the current bridge.js and
// restart it instead of silently reusing stale code (stale-bridge trap:
// `hermes update` updates bridge.js on disk but a long-lived bridge process
// keeps serving the old behavior forever).
let SCRIPT_HASH = '';
try {
  SCRIPT_HASH = createHash('sha256')
    .update(readFileSync(fileURLToPath(import.meta.url)))
    .digest('hex')
    .slice(0, 16);
} catch {}
const PAIR_ONLY = args.includes('--pair-only');
const PAIR_JSON = args.includes('--pair-json');
const WHATSAPP_MODE = getArg('mode', process.env.WHATSAPP_MODE || 'self-chat'); // "bot" or "self-chat"
const WHATSAPP_DM_POLICY = String(process.env.WHATSAPP_DM_POLICY || 'open').trim().toLowerCase();
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

// --- Send queue: serialise all sock.sendMessage() calls across concurrent
//     HTTP handlers so a single Baileys socket never has overlapping sends.
//     Overlapping sends are the root cause of cross-chat contamination
//     (#33360) — the WhatsApp protocol-level routing can misdeliver when
//     two sendMessage() Promises race on the same socket. ---
let _sendQueue = Promise.resolve();

function enqueueSend(fn) {
  const task = _sendQueue.then(() => fn(), () => fn());
  _sendQueue = task.catch(() => {});
  return task;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sendWithTimeout(chatId, payload, options = {}, timeoutMs = SEND_TIMEOUT_MS) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`sendMessage timed out after ${timeoutMs / 1000}s`)),
      timeoutMs,
    );
  });
  return enqueueSend(() =>
    Promise.race([sock.sendMessage(chatId, payload, options), timeoutPromise])
      .finally(() => clearTimeout(timer))
  );
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

function rememberSentMessage(sent, payload) {
  if (!sent?.key?.id) return;
  if (sent.message) {
    messageStore.remember(sent);
    return;
  }
  const syntheticMessage = pollCreationMessageFromPayload(payload);
  if (syntheticMessage) {
    messageStore.remember({ ...sent, message: syntheticMessage });
  }
}

function trackSentMessageId(sent) {
  rememberSentId(sent?.key?.id);
}

function normalizeWhatsAppId(value) {
  if (!value) return '';
  return String(value).replace(':', '@');
}

function redactWhatsAppId(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const [userPart, domainPart = ''] = raw.split('@', 2);
  const bare = userPart.split(':', 1)[0];
  const digits = bare.replace(/\D/g, '');
  const suffix = digits ? digits.slice(-4) : bare.slice(-4);
  return `${suffix ? `…${suffix}` : '…'}${domainPart ? `@${domainPart}` : ''}`;
}

function emitDebugEvent(payload) {
  if (!WHATSAPP_DEBUG) return;
  try {
    console.log(JSON.stringify({ event: 'debug', ...payload }));
  } catch {}
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

// Track recently sent message IDs.  Two purposes:
//   1. Prevent echo-back loops with media in self-chat mode.
//   2. (When WHATSAPP_FORWARD_OWNER_MESSAGES=true) distinguish our own
//      bot-API outbound messages from owner-typed messages on the linked
//      device so we can forward only the latter.
// Capacity bounded (see outbound_ids.js) to keep memory flat under
// sustained sending.
const recentlySentIds = createOutboundIdTracker(512);
const recentlyProcessedPollUpdates = createOutboundIdTracker(512);
const messageStore = createBoundedMessageStore(512);

function normalizePollUpdateOptions(aggregation, pollUpdateMessage, meId) {
  const selected = [];
  for (const option of aggregation || []) {
    if ((option.voters || []).length > 0 && option.name && option.name !== 'Unknown') {
      selected.push(option.name);
    }
  }
  if (selected.length > 0) return selected;

  // Fallback for already-decrypted pollUpdateMessage payloads where Baileys did
  // not have the creation message available. This may only yield hashes, but
  // keeping them in metadata is still better than dropping the vote entirely.
  const raw = pollUpdateMessage?.vote?.selectedOptions || [];
  return raw.map(option => String(option)).filter(Boolean);
}

function pollAggregationSummary(aggregation) {
  return (aggregation || []).map(option => ({
    name: option?.name || '',
    voterCount: (option?.voters || []).length,
  }));
}

function logPollUpdateDiagnostic({ sourcePath, pollId, pollCreation, pollUpdates, selectedOptions, aggregation }) {
  const firstUpdate = pollUpdates?.[0] || {};
  try {
    console.log(JSON.stringify({
      event: 'poll_update_decode',
      sourcePath,
      pollId: pollId || '',
      pollCreationFound: !!pollCreation,
      updateKeys: Object.keys(firstUpdate),
      hasVote: !!firstUpdate.vote,
      selectedOptionsLength: selectedOptions?.length || 0,
      aggregation: pollAggregationSummary(aggregation),
    }));
  } catch {}
}

function enqueuePollUpdateEvent({ key, update, selectedOptions, aggregation }) {
  const chatId = normalizeWhatsAppId(key?.remoteJid || update?.pollUpdates?.[0]?.pollUpdateMessageKey?.remoteJid || '');
  const senderId = normalizeWhatsAppId(
    key?.participant
    || update?.pollUpdates?.[0]?.pollUpdateMessageKey?.participant
    || chatId
  );
  const pollId = key?.id
    || update?.pollUpdates?.[0]?.pollCreationMessageKey?.id
    || update?.pollUpdates?.[0]?.pollUpdateMessageKey?.id
    || '';
  // Only surface votes on polls Hermes itself created (tracked when
  // /send-poll returns). Arbitrary human polls in a group chat must not
  // inject agent-visible messages on every vote.
  if (!pollId || !recentlySentIds.has(pollId)) {
    if (WHATSAPP_DEBUG) {
      try { console.log(JSON.stringify({ event: 'ignored', reason: 'foreign_poll_update', pollId })); } catch {}
    }
    return;
  }
  const chosenText = selectedOptions.length ? selectedOptions.join(', ') : `[Poll update${pollId ? `: ${pollId}` : ''}]`;
  const dedupeId = `poll:${pollId}:${senderId}:${selectedOptions.join('|')}`;
  if (recentlyProcessedPollUpdates.has(dedupeId)) return;
  recentlyProcessedPollUpdates.remember(dedupeId);
  const event = {
    messageId: `${pollId || 'poll'}:update:${Date.now()}`,
    chatId,
    senderId,
    senderName: senderId.replace(/@.*/, ''),
    chatName: chatId.replace(/@.*/, ''),
    isGroup: chatId.endsWith('@g.us'),
    body: chosenText,
    hasMedia: false,
    mediaType: 'poll_update',
    mime: '',
    fileName: '',
    nativeType: 'pollUpdateMessage',
    nativeMetadata: {
      pollUpdate: {
        pollId,
        selectedOptions,
        aggregation,
      },
    },
    mediaUrls: [],
    mentionedIds: [],
    quotedMessageId: pollId,
    quotedParticipant: '',
    quotedRemoteJid: chatId,
    quotedText: '',
    hasQuotedMessage: !!pollId,
    botIds: [],
    timestamp: Math.floor(Date.now() / 1000),
  };
  messageQueue.push(event);
  if (messageQueue.length > MAX_QUEUE_SIZE) {
    messageQueue.shift();
  }
}

function rememberSentId(id) {
  recentlySentIds.remember(id);
}

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
  // `text` is used only for the typing-duration calc. The actual payload sent
  // defaults to a plain text message, but callers that need a richer payload
  // (e.g. a quoted reply built via buildTextSendPayload) pass opts.payload plus
  // opts.sendOptions so the Baileys send options — quoted metadata lives there,
  // not inside the content — ride through to sock.sendMessage / sendWithTimeout.
  const content = opts.payload ?? { text };
  const sendOptions = opts.sendOptions ?? {};
  const sendFn = opts.sendFn ?? ((cid, payloadArg, optsArg) => sock.sendMessage(cid, payloadArg, optsArg));
  return sendFn(chatId, content, sendOptions);
}

let sock = null;
let connectionState = 'disconnected';
// Consecutive failed connection attempts in the current outage, counted PER
// disconnect class. A single shared counter was wrong: after a handful of 503s
// the next 515 would be judged against the exhausted tail of the retryable
// schedule, and the post-QR-scan 515 that WhatsApp requires to finish pairing
// would be told to give up — killing pairing right after the phone reports
// success. Each class now depletes its own budget.
let reconnectAttemptsByClass = Object.create(null);
// Total consecutive failures across classes; observability only, never a
// scheduling input.
let reconnectAttemptsTotal = 0;
let lastReconnectDecision = null;
// A connection must survive this long before it counts as "recovered" and
// clears the budgets. Resetting on 'open' alone let a flapping socket
// (accept -> immediate drop) restart the schedule at ~2.3s forever, which is
// the hammering behaviour this whole change exists to remove.
const SUSTAINED_CONNECTION_MS = 60_000;
let sustainedConnectionTimer = null;

function emitPairEvent(event) {
  if (!PAIR_JSON) return;
  try {
    console.log(JSON.stringify({ ts: Date.now(), ...event }));
  } catch {}
}

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
      if (PAIR_JSON) {
        emitPairEvent({ event: 'qr', qr });
      } else {
        console.log('\n📱 Scan this QR code with WhatsApp on your phone:\n');
        qrcode.generate(qr, { small: true });
        console.log('\nWaiting for scan...\n');
      }
    }

    if (connection === 'close') {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      connectionState = 'disconnected';

      // A connection that never lasted SUSTAINED_CONNECTION_MS does not count
      // as a recovery, so cancel the pending reset and keep the budget.
      if (sustainedConnectionTimer) {
        clearTimeout(sustainedConnectionTimer);
        sustainedConnectionTimer = null;
      }

      const disconnectClass = classifyDisconnect(reason);
      reconnectAttemptsByClass[disconnectClass] =
        (reconnectAttemptsByClass[disconnectClass] || 0) + 1;
      reconnectAttemptsTotal += 1;
      const decision = decideReconnect({
        reason,
        attempt: reconnectAttemptsByClass[disconnectClass],
      });
      lastReconnectDecision = decision;

      if (decision.action === DisconnectAction.EXIT) {
        emitPairEvent({ event: 'error', error: 'logged_out', reason });
        if (!PAIR_JSON) {
          console.log('❌ Logged out. Delete session and restart to re-authenticate.');
        }
        process.exit(1);
      } else if (decision.action === DisconnectAction.STOP) {
        // Budget exhausted for this class. Exit non-zero -- this is the ONLY
        // signal that reaches the gateway's recovery machinery.
        //
        // Do not "improve" this by staying alive and reporting disconnected on
        // /health: nothing polls /health outside connect(), and /messages keeps
        // answering 200 [] regardless of connection state, so the gateway would
        // go on believing WhatsApp was connected until a human noticed.
        // _check_managed_bridge_exit() watches the PROCESS, once per second,
        // and is what escalates to a retryable fatal error and a fresh bridge.
        emitPairEvent({ event: 'error', error: 'reconnect_gave_up', reason });
        if (!PAIR_JSON) {
          console.log(
            `🛑 Giving up after ${decision.attempt - 1} attempt(s) ` +
            `(reason: ${reason}, classified: ${decision.classification}). ` +
            `Exiting so the gateway can restart the bridge with a fresh budget.`
          );
        }
        process.exit(1);
      } else {
        emitPairEvent({ event: 'disconnected', reason });
        if (!PAIR_JSON) {
          const secs = (decision.delayMs / 1000).toFixed(1);
          if (decision.classification === 'restart_required') {
            console.log(`↻ WhatsApp requested restart (code 515). Reconnecting in ${secs}s...`);
          } else {
            console.log(
              `⚠️  Connection closed (reason: ${reason}, ${decision.classification}). ` +
              `Reconnecting in ${secs}s ` +
              `[attempt ${decision.attempt}/${decision.maxAttempts}]...`
            );
          }
        }
        setTimeout(startSocket, decision.delayMs);
      }
    } else if (connection === 'open') {
      connectionState = 'connected';
      // Clear the budgets only once the connection has PROVEN itself. A socket
      // that is accepted and immediately dropped would otherwise reset the
      // schedule on every cycle and never deplete — ~7s per flap, which is
      // back in hammering territory. unref() so this timer never by itself
      // keeps the process alive.
      if (sustainedConnectionTimer) {
        clearTimeout(sustainedConnectionTimer);
      }
      sustainedConnectionTimer = setTimeout(() => {
        reconnectAttemptsByClass = Object.create(null);
        reconnectAttemptsTotal = 0;
        lastReconnectDecision = null;
        sustainedConnectionTimer = null;
      }, SUSTAINED_CONNECTION_MS);
      if (typeof sustainedConnectionTimer.unref === 'function') {
        sustainedConnectionTimer.unref();
      }
      const connectedUser = sock?.user
        ? {
            id: sock.user.id || null,
            name: sock.user.name || sock.user.verifiedName || null,
          }
        : null;
      emitPairEvent({ event: 'connected', user: connectedUser });
      if (!PAIR_JSON) {
        console.log('✅ WhatsApp connected!');
      }
      if (PAIR_ONLY) {
        if (!PAIR_JSON) {
          console.log('✅ Pairing complete. Credentials saved.');
        }
        // Give Baileys a moment to flush creds, then exit cleanly
        setTimeout(() => process.exit(0), 2000);
      }
    }
  });

  sock.ev.on('messages.update', async (updates) => {
    for (const { key, update } of updates || []) {
      if (!update?.pollUpdates) continue;
      const pollCreationId = key?.id || update.pollUpdates?.[0]?.pollCreationMessageKey?.id;
      const pollCreation = messageStore.get(pollCreationId);
      let aggregation = [];
      let pollUpdates = update.pollUpdates;
      try {
        if (pollCreation) {
          const meId = jidNormalizedUser(sock.user?.id || 'me');
          pollUpdates = update.pollUpdates.map(pollUpdate => (
            pollUpdateForAggregation({
              pollUpdateMessage: pollUpdate,
              pollUpdateMessageKey: pollUpdate.pollUpdateMessageKey,
              pollCreation,
              decryptPollVote,
              getKeyAuthor,
              meId,
              pollCreatorJids: [
                jidNormalizedUser(sock.user?.lid || ''),
                jidNormalizedUser(sock.user?.id || ''),
                getKeyAuthor(pollUpdate.pollCreationMessageKey || key, jidNormalizedUser(sock.user?.lid || '')),
                getKeyAuthor(pollUpdate.pollCreationMessageKey || key, jidNormalizedUser(sock.user?.id || '')),
              ],
              voterJids: [
                normalizeWhatsAppId(pollUpdate.pollUpdateMessageKey?.participant || ''),
                normalizeWhatsAppId(pollUpdate.pollUpdateMessageKey?.remoteJid || key?.remoteJid || ''),
              ],
            }) || pollUpdate
          ));
          aggregation = getAggregateVotesInPollMessage({
            message: pollCreation.message,
            pollUpdates,
          });
        }
      } catch (err) {
        console.warn('[bridge] failed to aggregate poll update:', err.message);
      }
      const selectedOptions = normalizePollUpdateOptions(aggregation, pollUpdates?.[0]);
      logPollUpdateDiagnostic({
        sourcePath: 'messages.update',
        pollId: pollCreationId,
        pollCreation,
        pollUpdates,
        selectedOptions,
        aggregation,
      });
      enqueuePollUpdateEvent({ key, update: { ...update, pollUpdates }, selectedOptions, aggregation });
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
      const senderId = msg.key.participant || chatId;
      const isGroup = chatId.endsWith('@g.us');
      const senderNumber = senderId.replace(/@.*/, '');
      emitDebugEvent({
        stage: 'upsert',
        type,
        fromMe: !!msg.key.fromMe,
        chatId: redactWhatsAppId(chatId),
        senderId: redactWhatsAppId(senderId),
        messageKeys: Object.keys(msg.message || {}),
      });

      // Watcher OBSERVE mode: when WHATSAPP_OBSERVE_NON_SELF is enabled,
      // messages that would normally be dropped (own group posts, non-self
      // DMs in self-chat mode) are instead forwarded tagged observe_only:true
      // so the Python watcher can archive them and drive engagement windows
      // WITHOUT engaging the agent. Declared here so it's in scope at
      // event-build time below. (See processIncoming for the pure form of
      // this eligibility logic — kept exported + unit-tested.)
      let observeOnly = false;

      // Handle fromMe messages based on mode
      let fromOwner = false;
      if (msg.key.fromMe) {
        if (chatId.includes('status')) {
          // Status broadcasts are never observed or forwarded.
          emitDebugEvent({
            stage: 'ignored',
            reason: 'from_me_status',
            chatId: redactWhatsAppId(chatId),
          });
          continue;
        } else if (isGroup) {
          // Own group posts: observe (watcher) when enabled, otherwise drop
          // as before.
          if (OBSERVE_NON_SELF) {
            observeOnly = true;
          } else {
            emitDebugEvent({
              stage: 'ignored',
              reason: 'from_me_group',
              chatId: redactWhatsAppId(chatId),
            });
            continue;
          }
        } else if (WHATSAPP_MODE === 'bot') {
          // Bot mode: separate bot number. fromMe inbound is either
          //   (a) an echo of our own /send (recentlySentIds will catch it), or
          //   (b) a message the owner typed from their own phone using the
          //       linked-device session.
          //
          // We always drop (a). We drop (b) too unless the operator opts in
          // via WHATSAPP_FORWARD_OWNER_MESSAGES so existing deployments see
          // no behavior change. When opted in, we still gate on the
          // customer chatId allowlist — without that gate, any contact
          // the owner replied to would leak into Hermes and trigger
          // implicit handover. See `owner_message_gate.js`.
          const decision = classifyOwnerMessageGate({
            fromMe: true,
            fromOwnerEnabled: FORWARD_OWNER_MESSAGES,
            recentlySent: recentlySentIds,
            allowlistMatches: (id) => matchesAllowedUser(id, ALLOWED_USERS, SESSION_DIR),
            messageId: msg.key.id,
            chatId,
          });
          if (decision.action === 'drop_echo') continue;
          if (decision.action === 'drop_disabled') continue;
          if (decision.action === 'drop_allowlist') {
            try {
              console.log(JSON.stringify({
                event: 'ignored',
                reason: 'allowlist_mismatch_owner_chat',
                chatId,
                senderId,
              }));
            } catch {}
            continue;
          }
          fromOwner = true;
        } else {
          // Self-chat mode: only allow messages in the user's own self-chat.
          // WhatsApp now uses LID (Linked Identity Device) format: 67427329167522@lid
          // AND classic format: 34652029134@s.whatsapp.net
          // sock.user has both: { id: "number:10@s.whatsapp.net", lid: "lid_number:10@lid" }
          const myNumber = (sock.user?.id || '').replace(/:.*@/, '@').replace(/@.*/, '');
          const myLid = (sock.user?.lid || '').replace(/:.*@/, '@').replace(/@.*/, '');
          const chatNumber = chatId.replace(/@.*/, '');
          const isSelfChat = (myNumber && chatNumber === myNumber) || (myLid && chatNumber === myLid);
          emitDebugEvent({
            stage: 'self_chat_check',
            matched: !!isSelfChat,
            chatId: redactWhatsAppId(chatId),
            accountId: redactWhatsAppId(sock.user?.id),
            accountLid: redactWhatsAppId(sock.user?.lid),
          });
          if (!isSelfChat) {
            emitDebugEvent({
              stage: 'ignored',
              reason: 'self_chat_mismatch',
              chatId: redactWhatsAppId(chatId),
              senderId: redactWhatsAppId(senderId),
            });
            continue;
          }
        }
      }

      // Handle !fromMe messages (from other people) based on mode.
      // Self-chat mode only responds to the user's own messages to
      // themselves — stranger DMs / group pings must never reach the
      // Python gateway, otherwise a pairing-code reply fires in response
      // to arbitrary incoming messages (#8389). Watcher OBSERVE mode is the
      // one exception: it archives them tagged observe_only without engaging.
      if (!msg.key.fromMe) {
        if (WHATSAPP_MODE === 'self-chat') {
          if (OBSERVE_NON_SELF) {
            // Watcher: record the inbound in the per-chat unread queue (so
            // /mark-read and /send mark_read can blue-tick it later) and
            // forward it tagged observe_only.
            appendUnread(chatId, {
              remoteJid: chatId,
              id: msg.key.id,
              ...(msg.key.participant ? { participant: msg.key.participant } : {}),
            });
            observeOnly = true;
          } else {
            try {
              console.log(JSON.stringify({
                event: 'ignored',
                reason: 'self_chat_mode_rejects_non_self',
                chatId,
                senderId,
              }));
            } catch {}
            continue;
          }
        } else {
          // Bot mode: record the inbound in the per-chat unread queue before
          // the allowlist/pairing gate so /mark-read and /send mark_read can
          // drain it later (mirrors the pre-gate appendUnread in processIncoming).
          appendUnread(chatId, {
            remoteJid: chatId,
            id: msg.key.id,
            ...(msg.key.participant ? { participant: msg.key.participant } : {}),
          });
          if (WHATSAPP_DM_POLICY !== 'pairing' && !matchesAllowedUser(senderId, ALLOWED_USERS, SESSION_DIR)) {
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
      }

      const messageContent = getMessageContent(msg);
      if (messageContent.pollUpdateMessage) {
        const pollUpdateMessage = messageContent.pollUpdateMessage;
        const pollKey = pollUpdateMessage.pollCreationMessageKey || {
          id: pollUpdateMessage.key?.id || msg.key.id,
          remoteJid: chatId,
          participant: senderId,
        };
        const pollCreation = messageStore.get(pollKey.id);
        let aggregation = [];
        let pollUpdates = [pollUpdateMessage];
        try {
          if (pollCreation) {
            const meId = jidNormalizedUser(sock.user?.id || 'me');
            const pollUpdate = pollUpdateForAggregation({
              pollUpdateMessage,
              pollUpdateMessageKey: msg.key,
              pollCreation,
              decryptPollVote,
              getKeyAuthor,
              meId,
              pollCreatorJids: [
                jidNormalizedUser(sock.user?.lid || ''),
                jidNormalizedUser(sock.user?.id || ''),
                getKeyAuthor(pollUpdateMessage.pollCreationMessageKey || pollKey, jidNormalizedUser(sock.user?.lid || '')),
                getKeyAuthor(pollUpdateMessage.pollCreationMessageKey || pollKey, jidNormalizedUser(sock.user?.id || '')),
              ],
              voterJids: [
                normalizeWhatsAppId(msg.key?.participant || ''),
                normalizeWhatsAppId(msg.key?.remoteJid || chatId || ''),
                normalizeWhatsAppId(senderId || ''),
              ],
            });
            if (pollUpdate) pollUpdates = [pollUpdate];
            aggregation = getAggregateVotesInPollMessage({
              message: pollCreation.message,
              pollUpdates,
            });
          }
        } catch (err) {
          console.warn('[bridge] failed to aggregate poll upsert:', err.message);
        }
        const selectedOptions = normalizePollUpdateOptions(aggregation, pollUpdates[0]);
        logPollUpdateDiagnostic({
          sourcePath: 'messages.upsert',
          pollId: pollKey.id,
          pollCreation,
          pollUpdates,
          selectedOptions,
          aggregation,
        });
        enqueuePollUpdateEvent({
          key: { ...pollKey, remoteJid: pollKey.remoteJid || chatId, participant: pollKey.participant || senderId },
          update: { pollUpdates },
          selectedOptions,
          aggregation,
        });
        continue;
      }

      const event = await extractBridgeEvent({
        msg,
        chatId,
        senderId,
        senderNumber,
        botIds,
        isGroup,
        downloadMedia: async (mediaMsg) => downloadMediaMessage(mediaMsg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage }),
        cacheDirs: {
          image: IMAGE_CACHE_DIR,
          document: DOCUMENT_CACHE_DIR,
          audio: AUDIO_CACHE_DIR,
        },
      });
      event.fromOwner = fromOwner;

      // Ignore Hermes' own reply messages in self-chat mode to avoid loops.
      if (msg.key.fromMe && ((REPLY_PREFIX && event.body.startsWith(REPLY_PREFIX)) || recentlySentIds.has(msg.key.id))) {
        if (WHATSAPP_DEBUG) {
          emitDebugEvent({
            stage: 'ignored',
            reason: 'agent_echo',
            chatId: redactWhatsAppId(chatId),
            messageId: msg.key.id,
          });
        }
        continue;
      }

      // Skip empty messages
      if (!event.body && !event.hasMedia) {
        emitDebugEvent({
          stage: 'ignored',
          reason: 'empty',
          chatId: redactWhatsAppId(chatId),
          messageKeys: Object.keys(msg.message || {}),
        });
        continue;
      }

      messageStore.remember(msg);
      // Watcher: tag observe-eligible messages so the Python side archives
      // them without engaging the agent. extractBridgeEvent (above) already
      // produced every field the watcher reads; observe_only is the only
      // watcher-specific addition here (fromOwner was set just above).
      if (observeOnly) event.observe_only = true;
      messageQueue.push(event);
      emitDebugEvent({
        stage: 'queued',
        chatId: redactWhatsAppId(chatId),
        senderId: redactWhatsAppId(senderId),
        fromOwner: !!fromOwner,
        bodyLength: event.body.length,
        hasMedia: event.hasMedia,
        mediaType: event.mediaType,
        queueLength: messageQueue.length,
      });
      if (messageQueue.length > MAX_QUEUE_SIZE) {
        messageQueue.shift();
      }
    }
  });

  // Bulk-sync listener: receives WhatsApp's initial history dump (only
  // delivered when paired as a Desktop-platform device with syncFullHistory
  // enabled). Writes messages straight to the archive — bypasses the
  // live-message queue, which would overflow on a multi-thousand dump.
  // Skips events tagged with peerDataRequestSessionId — those are /backfill
  // responses already handled by waitForHistoryEvent.
  sock.ev.on('messaging-history.set', ({ messages, isLatest, peerDataRequestSessionId }) => {
    if (peerDataRequestSessionId) return;
    if (!Array.isArray(messages) || messages.length === 0) return;

    let written = 0;
    let skipped = 0;
    for (const msg of messages) {
      if (!msg || !msg.message) continue;
      const record = buildBackfillRecord(msg);
      if (!record) continue;
      record.observe_only = true; // historical — don't engage the agent
      if (writeArchiveRecord(record)) written++; else skipped++;
    }
    console.log(JSON.stringify({
      event: 'history_sync',
      written,
      skipped_dup: skipped,
      total: messages.length,
      isLatest: !!isLatest,
    }));
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
      // Build the send payload (quoted reply, if any, rides in `options`).
      // Only the first chunk carries the reply-to; later chunks are plain.
      const { content: payload, options } = buildTextSendPayload(chunks[i], {
        chatId,
        replyTo: i === 0 ? replyTo : undefined,
        messageStore,
      });
      // Typing indicator only before the first chunk; subsequent chunks send
      // immediately. performTypingAndSend forwards the built payload + options
      // (so the quoted-reply metadata survives) to sendWithTimeout.
      const sent = i === 0
        ? await performTypingAndSend(sock, chatId, chunks[i], {
            typingEnabled,
            ...(typingSeconds !== undefined ? { typingSeconds } : {}),
            payload,
            sendOptions: options,
            sendFn: (cid, content, opts) => sendWithTimeout(cid, content, opts),
          })
        : await sendWithTimeout(chatId, payload, options);
      trackSentMessageId(sent);
      messageStore.remember(sent);
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
        if (ext === 'gif') {
          // WhatsApp's native animated-GIF UX is an MP4 video payload with
          // gifPlayback=true. Convert when ffmpeg is available; otherwise fall
          // back to a truthful image/gif send instead of mislabeling GIF bytes
          // as video/mp4.
          let tmpGifMp4 = null;
          try {
            tmpGifMp4 = path.join(tmpdir(), `hermes_gif_${randomBytes(6).toString('hex')}.mp4`);
            execFileSync(
              'ffmpeg',
              ['-y', '-i', filePath, '-movflags', 'faststart', '-pix_fmt', 'yuv420p', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', tmpGifMp4],
              { timeout: 30000, stdio: 'pipe' }
            );
            msgPayload = {
              video: readFileSync(tmpGifMp4),
              caption: caption || undefined,
              mimetype: 'video/mp4',
              gifPlayback: true,
            };
          } catch (gifErr) {
            console.warn('[bridge] gif conversion failed, sending as image/gif:', gifErr.message);
            msgPayload = mediaPayloadForFile({ buffer, filePath, mediaType: type, caption, fileName });
          } finally {
            try { if (tmpGifMp4 && existsSync(tmpGifMp4)) unlinkSync(tmpGifMp4); } catch (_) {}
          }
        } else {
          msgPayload = mediaPayloadForFile({ buffer, filePath, mediaType: type, caption, fileName });
        }
        break;
      case 'video':
        msgPayload = mediaPayloadForFile({ buffer, filePath, mediaType: type, caption, fileName });
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
            execFileSync(
              'ffmpeg',
              ['-y', '-i', filePath, '-ar', '48000', '-ac', '1', '-c:a', 'libopus', tmpPath],
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
        msgPayload = mediaPayloadForFile({ buffer, filePath, mediaType: 'document', caption, fileName });
        break;
    }

    const sent = await sendWithTimeout(chatId, msgPayload);
    trackSentMessageId(sent);
    messageStore.remember(sent);
    // Also feed the per-chat hermes-send recency map (read by isHermesOrigin /
    // processIncoming) so owner-vs-bot origin detection stays accurate.
    if (sent?.key?.id) recordHermesSend(chatId, sent.key.id);
    res.json({ success: true, messageId: sent?.key?.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send poll primitive. Approval UX is intentionally not wired here; gateway
// approvals need text fallback and explicit confirmation semantics above this
// low-level transport helper.
app.post('/send-poll', async (req, res) => {
  if (!sock || connectionState !== 'connected') {
    return res.status(503).json({ error: 'Not connected to WhatsApp' });
  }

  const { chatId, question, options, selectableCount } = req.body;
  if (!chatId || !question || !Array.isArray(options)) {
    return res.status(400).json({ error: 'chatId, question, and options are required' });
  }

  try {
    const payload = buildPollPayload({ question, options, selectableCount });
    const sent = await sendWithTimeout(chatId, payload);
    trackSentMessageId(sent);
    rememberSentMessage(sent, payload);
    res.json({ success: true, messageId: sent?.key?.id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Send native WhatsApp location pin
app.post('/send-location', async (req, res) => {
  if (!sock || connectionState !== 'connected') {
    return res.status(503).json({ error: 'Not connected to WhatsApp' });
  }

  const { chatId, latitude, longitude, name, address } = req.body;
  if (!chatId || latitude === undefined || longitude === undefined) {
    return res.status(400).json({ error: 'chatId, latitude, and longitude are required' });
  }

  try {
    const payload = buildLocationPayload({ latitude, longitude, name, address });
    const sent = await sendWithTimeout(chatId, payload);
    trackSentMessageId(sent);
    messageStore.remember(sent);
    res.json({ success: true, messageId: sent?.key?.id });
  } catch (err) {
    res.status(400).json({ error: err.message });
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

// Mark an inbound message as read only after the Python adapter has accepted
// it through the authoritative DM/group/mention intake policy.
app.post('/read', async (req, res) => {
  if (!sock || connectionState !== 'connected') {
    return res.status(503).json({ error: 'Not connected' });
  }

  const receiptKeys = inboundReadReceiptKeys({
    key: req.body?.key,
    enabled: SEND_READ_RECEIPTS,
  });
  if (receiptKeys.length === 0) {
    return res.json({ success: true, marked: false });
  }

  try {
    await sock.readMessages(receiptKeys);
    return res.json({ success: true, marked: true });
  } catch (err) {
    console.warn('[bridge] failed to send read receipt:', err.message);
    return res.status(500).json({ error: 'Failed to send read receipt' });
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

// ------------------------------------------------------------------
// Direct-archive writes (used by the messaging-history.set listener
// to persist initial-sync messages without going through Python).
// Format matches extensions/whatsapp-watcher/archive.py exactly so
// either writer can append to the same JSONL files.
// ------------------------------------------------------------------
const HERMES_HOME = process.env.HERMES_HOME || path.join(process.env.HOME || '~', '.hermes');
const WA_ARCHIVE_DIR = path.join(HERMES_HOME, 'whatsapp', 'archive');
const _archiveKnownIds = new Map(); // chatId -> Set<message_id>

function _sanitizeChatId(chatId) {
  return chatId.replace(/[^A-Za-z0-9._@-]/g, '_');
}

function _epochToIso(ts) {
  // Match Python's datetime.fromtimestamp(ts, timezone.utc).isoformat():
  // 2026-05-26T17:43:09+00:00 (no fractional seconds, +00:00 suffix).
  if (typeof ts !== 'number' || !Number.isFinite(ts)) {
    return new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');
  }
  return new Date(ts * 1000).toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

function _loadKnownIds(chatId) {
  let ids = _archiveKnownIds.get(chatId);
  if (ids) return ids;
  ids = new Set();
  const p = path.join(WA_ARCHIVE_DIR, `${_sanitizeChatId(chatId)}.jsonl`);
  if (existsSync(p)) {
    try {
      const content = readFileSync(p, 'utf-8');
      for (const line of content.split('\n')) {
        if (!line) continue;
        try {
          const rec = JSON.parse(line);
          if (rec.message_id) ids.add(rec.message_id);
        } catch {}
      }
    } catch {}
  }
  _archiveKnownIds.set(chatId, ids);
  return ids;
}

function writeArchiveRecord(rec) {
  // Returns true if written, false if deduped or invalid.
  const chatId = rec.chatId;
  if (!chatId || !rec.messageId) return false;
  const ids = _loadKnownIds(chatId);
  if (ids.has(rec.messageId)) return false;
  mkdirSync(WA_ARCHIVE_DIR, { recursive: true });
  const filePath = path.join(WA_ARCHIVE_DIR, `${_sanitizeChatId(chatId)}.jsonl`);
  const out = {
    ts: _epochToIso(rec.timestamp),
    direction: rec.fromMe ? 'out' : 'in',
    chat_id: chatId,
    is_group: !!rec.isGroup,
    sender_id: rec.senderId,
    sender_name: rec.senderName || '',
    sender_e164: rec.sender_e164 || null,
    message_id: rec.messageId,
    kind: rec.kind || 'text',
    body: rec.body || '',
    media_ref: rec.media_ref || null,
    hermes_origin: !!rec.hermes_origin,
    observe_only: !!rec.observe_only,
    reply_to: null,
    edited: false,
    original_message_id: null,
    deleted_by: null,
  };
  appendFileSync(filePath, JSON.stringify(out) + '\n', 'utf-8');
  ids.add(rec.messageId);
  return true;
}

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
    oldest_from_me: oldestFromMe = false,
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

  // Build the anchor key from caller-supplied ids. fromMe must match the
  // server-side message's actual sender; if the anchor was a message you
  // sent, passing fromMe:false here silently returns empty (the key won't
  // resolve to a real message on WhatsApp's side).
  let anchorKey = {
    remoteJid: chatId,
    fromMe: !!oldestFromMe,
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
    scriptHash: SCRIPT_HASH,
    sendReadReceipts: SEND_READ_RECEIPTS,
    reconnectAttempts: reconnectAttemptsTotal,
    reconnectAttemptsByClass: { ...reconnectAttemptsByClass },
    connectionSettling: sustainedConnectionTimer !== null,
    lastDisconnectClass: lastReconnectDecision?.classification ?? null,
    lastDisconnectReason: lastReconnectDecision?.reason ?? null,
  });
});

// Start — only when bridge.js is the entry point, not when imported as a module.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain && PAIR_ONLY) {
  // Pair-only mode: just connect, show QR, save creds, exit. No HTTP server.
  if (PAIR_JSON) {
    emitPairEvent({ event: 'started', session: SESSION_DIR });
  } else {
    console.log('📱 WhatsApp pairing mode');
    console.log(`📁 Session: ${SESSION_DIR}`);
    console.log();
  }
  startSocket().catch((err) => {
    emitPairEvent({ event: 'error', error: err?.message || String(err) });
    if (!PAIR_JSON) {
      console.error(err);
    }
    process.exit(1);
  });
} else if (isMain) {
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`🌉 WhatsApp bridge listening on port ${PORT} (mode: ${WHATSAPP_MODE})`);
    console.log(`📁 Session stored in: ${SESSION_DIR}`);
    if (ALLOWED_USERS.size > 0) {
      console.log(`🔒 Allowed users: ${Array.from(ALLOWED_USERS).join(', ')}`);
    } else if (WHATSAPP_MODE === 'self-chat') {
      console.log(`🔒 Self-chat mode — only your own messages to yourself are processed.`);
    } else if (WHATSAPP_MODE === 'bot' && WHATSAPP_DM_POLICY === 'pairing') {
      console.log(`🤝 WHATSAPP_DM_POLICY=pairing — unknown DMs are forwarded for gateway pairing.`);
    } else {
      console.log(`🔒 No WHATSAPP_ALLOWED_USERS set — incoming messages are rejected.`);
      console.log(`   Set WHATSAPP_ALLOWED_USERS=<phone> to authorize specific users,`);
      console.log(`   or WHATSAPP_ALLOWED_USERS=* for an explicit open bot.`);
    }
    if (WHATSAPP_MODE === 'bot' && FORWARD_OWNER_MESSAGES) {
      console.log(`👤 WHATSAPP_FORWARD_OWNER_MESSAGES=true — owner-typed messages will be forwarded with fromOwner:true`);
    }
    console.log();
    startSocket();
  });
}
