import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { schedulePresenceOffline, sendChatState } from './bridge.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_PATH = path.join(HERE, 'bridge.js');

// ---------------------------------------------------------------------------
// WHY THIS FILE EXISTS
//
// 2026-08-17: Rafael showed as permanently "online" on WhatsApp, to every
// contact, for the life of each bridge socket.
//
// WhatsApp will not accept a chat-state ('composing'/'paused') unless the
// session is AVAILABLE, so sending a typing indicator implicitly marks the
// account online. 'paused' only clears the "typing…" text; it does not undo
// that. The bridge sent 'composing' and 'paused' in three places and sent
// 'unavailable' in NONE — so the first outbound message after a connect
// pinned the account online until the socket died. That is a passive
// broadcast of when the agent is running.
//
// markOnlineOnConnect:false is what keeps a fresh socket offline. These tests
// pin the other half: whatever takes us online must put us back.
// ---------------------------------------------------------------------------

function fakeSock() {
  const calls = [];
  return {
    calls,
    async sendPresenceUpdate(state, jid) { calls.push([state, jid]); },
  };
}

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

// --------------------------------------------------------------- the timer

test('schedulePresenceOffline eventually sends unavailable', async () => {
  const sock = fakeSock();
  schedulePresenceOffline(sock, 10);
  await tick(60);
  assert.deepEqual(sock.calls, [['unavailable', undefined]]);
});

test('the timer is DEBOUNCED, not stacked — one unavailable, not three', async () => {
  // Re-arming matters: a burst of chat states must not queue a pile of
  // presence writes, and must not fire an early 'unavailable' mid-typing.
  const sock = fakeSock();
  schedulePresenceOffline(sock, 15);
  schedulePresenceOffline(sock, 15);
  schedulePresenceOffline(sock, 15);
  await tick(80);
  assert.equal(sock.calls.length, 1);
});

test('a later re-arm pushes the deadline out rather than firing early', async () => {
  const sock = fakeSock();
  schedulePresenceOffline(sock, 10);
  await tick(5);
  schedulePresenceOffline(sock, 60);   // still typing — do not go offline yet
  await tick(30);
  assert.deepEqual(sock.calls, [], 'went offline while the first deadline was superseded');
  await tick(70);
  assert.equal(sock.calls.length, 1);
});

test('a failing sendPresenceUpdate never escapes the timer', async () => {
  // Presence is bookkeeping. It runs on a detached timer, so a rejection here
  // would be an unhandled rejection that can take the bridge process down —
  // exactly the class of failure the reconnect work already had to fix once.
  const sock = {
    async sendPresenceUpdate() { throw new Error('socket closed'); },
  };
  let unhandled = null;
  const onUnhandled = (err) => { unhandled = err; };
  process.on('unhandledRejection', onUnhandled);
  try {
    schedulePresenceOffline(sock, 10);
    await tick(60);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.equal(unhandled, null, 'presence failure escaped as an unhandled rejection');
});

// ----------------------------------------------------------- the chat state

test('sendChatState forwards the state and jid to the socket', async () => {
  const sock = fakeSock();
  await sendChatState(sock, 'composing', '55@s.whatsapp.net');
  assert.deepEqual(sock.calls[0], ['composing', '55@s.whatsapp.net']);
});

test('composing gets a LONGER deadline than paused', () => {
  // The two call shapes differ: a send follows 'paused' immediately, while
  // POST /typing may never be followed by a send at all (the agent can decide
  // not to reply). If 'composing' used the short deadline we would drop the
  // typing indicator mid-thought; if 'paused' used the long one we would stay
  // online for 30s after every message.
  //
  // Spawned with tiny env values because the constants are read at import
  // time and ESM caches per process — same technique bridge.test.mjs uses.
  const script = `
    import { sendChatState } from ${JSON.stringify(BRIDGE_PATH)};
    const calls = [];
    const sock = { async sendPresenceUpdate(s, j) { calls.push(s); } };
    const tick = (ms) => new Promise(r => setTimeout(r, ms));
    await sendChatState(sock, 'paused', 'x');
    await tick(60);
    const pausedWentOffline = calls.includes('unavailable');
    calls.length = 0;
    await sendChatState(sock, 'composing', 'x');
    await tick(60);
    const composingWentOffline = calls.includes('unavailable');
    // paused (20ms) must have fired; composing (500ms) must NOT have.
    process.exit(pausedWentOffline && !composingWentOffline ? 0 : 1);
  `;
  const res = execFileSync('node', ['--input-type=module', '-e', script], {
    env: {
      ...process.env,
      WHATSAPP_PRESENCE_OFFLINE_MS: '20',
      WHATSAPP_PRESENCE_TYPING_MAX_MS: '500',
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(res, '');
});

// ------------------------------------------------------- regression fence

test('no raw composing/paused presence calls survive outside the helper', () => {
  // The whole bug was a call site that took the account online with nothing
  // putting it back. Any NEW raw call site would silently reintroduce it, and
  // no runtime test would catch it because the leak is invisible from inside
  // the process — it is only visible to the people in Rafael's contact list.
  const src = readFileSync(BRIDGE_PATH, 'utf8');
  const raw = [...src.matchAll(/sendPresenceUpdate\(\s*'(composing|paused)'/g)];
  assert.equal(
    raw.length, 0,
    `found ${raw.length} raw chat-state call(s); route them through sendChatState()`,
  );
});

test('the bridge still knows how to go offline at all', () => {
  // Positive control for the fence above: if someone deletes the helper, the
  // regex test would pass vacuously (zero raw calls, because zero calls).
  const src = readFileSync(BRIDGE_PATH, 'utf8');
  assert.match(src, /sendPresenceUpdate\('unavailable'\)/);
  assert.match(src, /markOnlineOnConnect:\s*false/);
});
