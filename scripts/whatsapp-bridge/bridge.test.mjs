import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// bridge.js is a module with side-effects (starts HTTP server) when run as
// main. We import only the named exports we need. The server startup is guarded
// by an import.meta.url check in bridge.js so importing it here is safe.
import { OBSERVE_NON_SELF, parseObserveNonSelf, processIncoming, recordHermesSend, markRecentHermesSendForChat, getUnreadKeysForChat, drainUnreadKeysForChat, computeTypingSeconds, formatOutgoingMessage } from './bridge.js';

const BRIDGE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bridge.js');

test('WHATSAPP_OBSERVE_NON_SELF defaults to false', () => {
  // OBSERVE_NON_SELF is the module-level constant evaluated at import time.
  // In this test process the env var is not set, so it should be false.
  assert.equal(typeof OBSERVE_NON_SELF, 'boolean');
  assert.equal(OBSERVE_NON_SELF, false);
});

test('parseObserveNonSelf returns false for absent/empty values', () => {
  assert.equal(parseObserveNonSelf(undefined), false);
  assert.equal(parseObserveNonSelf(''), false);
  assert.equal(parseObserveNonSelf('false'), false);
  assert.equal(parseObserveNonSelf('FALSE'), false);
  assert.equal(parseObserveNonSelf('0'), false);
});

test('parseObserveNonSelf returns true when value is "true"', () => {
  assert.equal(parseObserveNonSelf('true'), true);
  assert.equal(parseObserveNonSelf('TRUE'), true);
  assert.equal(parseObserveNonSelf('True'), true);
});

test('OBSERVE_NON_SELF is true when WHATSAPP_OBSERVE_NON_SELF=true (env→constant wiring)', () => {
  // ESM modules cache once per process, so we verify the env-var wiring
  // by spawning a fresh node process with the env set.
  const script = `import('${BRIDGE_PATH}').then(m => process.exit(m.OBSERVE_NON_SELF ? 0 : 1)).catch(e => { console.error(e); process.exit(2); });`;
  const result = execFileSync('node', ['--input-type=module', '-e', script], {
    env: { ...process.env, WHATSAPP_OBSERVE_NON_SELF: 'true' },
    encoding: 'utf8',
  });
  // execFileSync throws on non-zero exit, so reaching this line means exit 0.
  assert.ok(true, 'child process exited 0 indicating OBSERVE_NON_SELF was true');
});

// --- Task 2: processIncoming tests ---

test('self-chat mode drops non-self DM when observeNonSelf=false', () => {
  const result = processIncoming({
    key: { remoteJid: '15551234567@s.whatsapp.net', fromMe: false, id: 'M1' },
    pushName: 'Carol',
    message: { conversation: 'hi' },
    messageTimestamp: 1716000000,
  }, { mode: 'self-chat', observeNonSelf: false });
  assert.equal(result.action, 'ignore');
  assert.equal(result.reason, 'self_chat_mode_rejects_non_self');
});

test('self-chat mode forwards non-self DM with observe_only when observeNonSelf=true', () => {
  const result = processIncoming({
    key: { remoteJid: '15551234567@s.whatsapp.net', fromMe: false, id: 'M1' },
    pushName: 'Carol',
    message: { conversation: 'hi' },
    messageTimestamp: 1716000000,
  }, { mode: 'self-chat', observeNonSelf: true });
  assert.equal(result.action, 'forward');
  assert.equal(result.payload.observe_only, true);
  assert.equal(result.payload.body, 'hi');
});

test('groups are forwarded with observe_only and isGroup=true', () => {
  const result = processIncoming({
    key: { remoteJid: '120363@g.us', fromMe: false, id: 'M2', participant: '15551234567@s.whatsapp.net' },
    pushName: 'Mom',
    message: { conversation: 'family dinner sunday?' },
    messageTimestamp: 1716000010,
  }, { mode: 'self-chat', observeNonSelf: true });
  assert.equal(result.action, 'forward');
  assert.equal(result.payload.observe_only, true);
  assert.equal(result.payload.isGroup, true);
});

test('status broadcasts stay rejected even with observeNonSelf=true', () => {
  const result = processIncoming({
    key: { remoteJid: 'status@broadcast', fromMe: false, id: 'M3' },
    message: { conversation: 'x' },
    messageTimestamp: 1716000020,
  }, { mode: 'self-chat', observeNonSelf: true });
  assert.equal(result.action, 'ignore');
});

test('self-chat reply path: fromMe DM in self-chat forwards without observe_only (regression guard)', () => {
  // The user's own self-chat message — the channel where they talk to the
  // bot via WhatsApp. This MUST continue to forward as today; observe_only
  // must be absent so the agent runs (not treated as observation).
  const result = processIncoming({
    key: { remoteJid: '15557654321@s.whatsapp.net', fromMe: true, id: 'SELF-1' },
    pushName: 'Owner',
    message: { conversation: '/status' },
    messageTimestamp: 1716000030,
  }, { mode: 'self-chat', observeNonSelf: true });
  assert.equal(result.action, 'forward');
  assert.notEqual(result.payload.observe_only, true);
});

// --- Task 3: hermes_origin tagging tests ---

test('outbound sent via bridge is tagged hermes_origin on upsert', () => {
  recordHermesSend('15550000001@s.whatsapp.net', 'HERMES-MSG-1');
  const result = processIncoming({
    key: { remoteJid: '15550000001@s.whatsapp.net', fromMe: true, id: 'HERMES-MSG-1' },
    message: { conversation: 'reply from bot' },
    messageTimestamp: 1716000050,
  }, { mode: 'self-chat', observeNonSelf: true });
  assert.equal(result.action, 'forward');
  assert.equal(result.payload.hermes_origin, true);
});

test('outbound that does not match a recent hermes send is not tagged', () => {
  const result = processIncoming({
    key: { remoteJid: '15550000002@s.whatsapp.net', fromMe: true, id: 'PHONE-MSG-1' },
    message: { conversation: 'typed manually from the phone' },
    messageTimestamp: 1716000060,
  }, { mode: 'self-chat', observeNonSelf: true });
  // Forward (self-chat fromMe path), but hermes_origin should be falsy.
  assert.equal(result.action, 'forward');
  assert.notEqual(result.payload.hermes_origin, true);
});

test('fallback tags hermes_origin via recentlySent timestamp window', () => {
  markRecentHermesSendForChat('15550000003@s.whatsapp.net', Date.now());
  const result = processIncoming({
    key: { remoteJid: '15550000003@s.whatsapp.net', fromMe: true, id: 'UNKNOWN-ID' },
    message: { conversation: 'late ack' },
    messageTimestamp: Math.floor(Date.now() / 1000),
  }, { mode: 'self-chat', observeNonSelf: true });
  assert.equal(result.payload.hermes_origin, true);
});

// --- Task 4: Per-chat unread-keys queue ---

test('observed inbound DM appends key to unread queue', () => {
  // Use unique chatId to avoid state leakage.
  const chatId = '15550000010@s.whatsapp.net';
  processIncoming({
    key: { remoteJid: chatId, fromMe: false, id: 'M1-task4a' },
    message: { conversation: 'hi' },
    messageTimestamp: 1716000000,
  }, { mode: 'self-chat', observeNonSelf: true });

  const keys = getUnreadKeysForChat(chatId);
  assert.equal(keys.length, 1);
  assert.equal(keys[0].id, 'M1-task4a');
});

test('drainUnreadKeysForChat empties the queue', () => {
  const chatId = '15550000011@s.whatsapp.net';
  processIncoming({
    key: { remoteJid: chatId, fromMe: false, id: 'M1-task4b' },
    message: { conversation: 'hi' },
    messageTimestamp: 1716000000,
  }, { mode: 'self-chat', observeNonSelf: true });

  const drained = drainUnreadKeysForChat(chatId);
  assert.equal(drained.length, 1);
  const second = drainUnreadKeysForChat(chatId);
  assert.equal(second.length, 0);
});

test('non-self group message also appends to unread queue', () => {
  const chatId = '120363-task4c@g.us';
  processIncoming({
    key: { remoteJid: chatId, fromMe: false, id: 'GM1-task4c', participant: '15551234567@s.whatsapp.net' },
    message: { conversation: 'hi family' },
    messageTimestamp: 1716000010,
  }, { mode: 'self-chat', observeNonSelf: true });
  const keys = getUnreadKeysForChat(chatId);
  assert.equal(keys.length, 1);
  assert.equal(keys[0].participant, '15551234567@s.whatsapp.net');
});

test('outbound (fromMe) does NOT append to unread queue', () => {
  const chatId = '15550000013@s.whatsapp.net';
  processIncoming({
    key: { remoteJid: chatId, fromMe: true, id: 'OUT-1' },
    message: { conversation: 'mine' },
    messageTimestamp: 1716000020,
  }, { mode: 'self-chat', observeNonSelf: true });
  const keys = getUnreadKeysForChat(chatId);
  assert.equal(keys.length, 0);
});

// --- Task 5: computeTypingSeconds ---

test('typing duration scales with message length within bounds', () => {
  assert.equal(computeTypingSeconds('hi'),  1);            // floor (2/15 < 1)
  assert.equal(computeTypingSeconds('a'.repeat(75)), 5);   // 75/15 = 5
  assert.equal(computeTypingSeconds('a'.repeat(300)), 8);  // ceiling
});

test('computeTypingSeconds respects custom config', () => {
  assert.equal(
    computeTypingSeconds('a'.repeat(40), { charsPerSecond: 10, min: 2, max: 5 }),
    4,
  );
});

test('computeTypingSeconds handles empty/null gracefully', () => {
  assert.equal(computeTypingSeconds(''), 1);    // floor
  assert.equal(computeTypingSeconds(null), 1);  // floor
});

// --- Task 6: stealth invariant — markOnlineOnConnect must stay false ---

test('makeWASocket call includes markOnlineOnConnect: false (stealth invariant)', () => {
  // Static-source check: if a refactor accidentally removes this option,
  // the bridge would silently start announcing "online" to senders on connect.
  // This guard fails loud rather than letting that regression land.
  const src = readFileSync(BRIDGE_PATH, 'utf8');
  assert.match(src, /markOnlineOnConnect:\s*false/);
});

// --- prefix_override: formatOutgoingMessage tests ---

test('formatOutgoingMessage with prefixOverride="" returns raw message in self-chat mode', () => {
  // Empty string override suppresses the default REPLY_PREFIX entirely.
  assert.equal(formatOutgoingMessage('hi', { prefixOverride: '' }, 'self-chat'), 'hi');
});

test('formatOutgoingMessage with no opts uses default REPLY_PREFIX in self-chat mode', () => {
  // When no prefixOverride is supplied the default prefix must be prepended.
  const DEFAULT_REPLY_PREFIX = '⚕ *Hermes Agent*\n────────────\n';
  assert.equal(
    formatOutgoingMessage('hi', {}, 'self-chat'),
    `${DEFAULT_REPLY_PREFIX}hi`,
  );
});

test('formatOutgoingMessage with prefixOverride="[via bot] " uses custom prefix', () => {
  assert.equal(
    formatOutgoingMessage('hi', { prefixOverride: '[via bot] ' }, 'self-chat'),
    '[via bot] hi',
  );
});

// --- /mark-read endpoint: source-level sanity ---

test('bridge.js exposes a /mark-read endpoint', () => {
  const src = readFileSync(BRIDGE_PATH, 'utf8');
  // Endpoint declared.
  assert.match(src, /app\.post\(['"]\/mark-read['"]/);
  // Drains the unread keys via the existing helper.
  assert.match(src, /drainUnreadKeysForChat\(chatId\)/);
  // Calls sock.readMessages with the drained keys.
  assert.match(src, /sock\.readMessages\(keys\)/);
});

// --- /backfill endpoint: source-level sanity ---

test('bridge.js exposes a /backfill endpoint', () => {
  const src = readFileSync(BRIDGE_PATH, 'utf8');
  assert.match(src, /app\.post\(['"]\/backfill['"]/);
});

test('/backfill handler validates chatId — missing chatId triggers 400 response', () => {
  const src = readFileSync(BRIDGE_PATH, 'utf8');
  // Guard: the handler must check for chatId and return a 400.
  assert.match(src, /chatId is required/);
  assert.match(src, /status\(400\)/);
});

test('/backfill handler uses sock.fetchMessageHistory', () => {
  const src = readFileSync(BRIDGE_PATH, 'utf8');
  assert.match(src, /sock\.fetchMessageHistory\(/);
});

test('/backfill handler waits for messaging-history.set event', () => {
  const src = readFileSync(BRIDGE_PATH, 'utf8');
  assert.match(src, /messaging-history\.set/);
});

test('/backfill returns timeout error on slow WhatsApp response', () => {
  const src = readFileSync(BRIDGE_PATH, 'utf8');
  assert.match(src, /timeout/);
  assert.match(src, /success:\s*false/);
});

test('buildBackfillRecord extracts text and kind (source-level)', () => {
  const src = readFileSync(BRIDGE_PATH, 'utf8');
  // The helper function must exist.
  assert.match(src, /function buildBackfillRecord/);
  // It must call extractText for body extraction.
  assert.match(src, /extractText\(msg\)/);
  // It must set kind for media types.
  assert.match(src, /imageMessage.*kind.*image|kind.*image.*imageMessage/s);
});


// --- reconnect backoff wiring: source-level sanity ---
//
// reconnect_policy.test.mjs proves the decision logic. These prove bridge.js
// actually USES it -- the policy being correct is worthless if the socket
// handler still hardcodes a 3s retry, or if the give-up branch does nothing.
//
// Assertions are deliberately token-based rather than exact-call-shape
// regexes: `npm run fix` reflows this file, and a wiring test that breaks on
// whitespace teaches people to delete wiring tests.

/**
 * Slice out one branch of the connection-close handler so assertions are
 * scoped to it. Matching against the whole file is how the earlier version of
 * `keeps 401 -> exit` passed while asserting nothing: `process.exit(1)` was
 * already present for the 401 path, so the STOP branch could have been empty.
 */
function closeBranchSource(src, actionConst) {
  const start = src.indexOf(`decision.action === DisconnectAction.${actionConst}`);
  assert.ok(start > -1, `${actionConst} branch not found in bridge.js`);
  const rest = src.slice(start);
  // Branches are separated by `} else if (` / `} else {` at the same depth.
  const end = rest.search(/\n\s*\} else[\s{]/);
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * Same idea as closeBranchSource, applied to the sustained-connection timer:
 * return only what runs INSIDE the setTimeout callback.
 *
 * Scoping matters for exactly the reason it did in the STOP branch. Asserting
 * that `setTimeout` and the reset statements both merely *exist somewhere* is
 * satisfied by a build that keeps the timer but performs the resets eagerly on
 * 'open' -- which is precisely the flap bug this timer exists to prevent (a
 * socket accepted and instantly dropped resets the schedule forever).
 */
function sustainedResetCallbackSource(src) {
  const start = src.indexOf('sustainedConnectionTimer = setTimeout(() =>');
  assert.ok(start > -1, 'sustained-connection timer not found in bridge.js');
  const rest = src.slice(start);
  const end = rest.indexOf('SUSTAINED_CONNECTION_MS)');
  assert.ok(end > -1, 'could not delimit the sustained-connection timer callback');
  return rest.slice(0, end);
}

test('bridge.js delegates disconnect handling to reconnect_policy', () => {
  const src = readFileSync(BRIDGE_PATH, 'utf8');
  assert.match(src, /from '\.\/reconnect_policy\.js'/);
  assert.match(src, /decideReconnect\(/);
  assert.match(src, /classifyDisconnect\(/);
  // The scheduled delay must come from the decision, not a literal.
  assert.match(src, /scheduleReconnect\(decision\.delayMs\)/);
});

test('REGRESSION: the unconditional 3s retry is gone from bridge.js', () => {
  const src = readFileSync(BRIDGE_PATH, 'utf8');
  assert.doesNotMatch(
    src,
    /scheduleReconnect\(reason === 515 \? 1000 : 3000\)/,
    'the fixed 3s retry that caused the 2026-07-28 outage must not come back',
  );
  // Both call forms are covered on purpose: the reschedule went through
  // setTimeout(startSocket, …) before 0.20 and through upstream's
  // scheduleReconnect() after it. Guarding only the current one would let a
  // literal delay return under the other name without failing anything.
  assert.doesNotMatch(
    src,
    /setTimeout\(startSocket,\s*\d+\)/,
    'reconnect delay must always come from the backoff policy',
  );
  // Non-zero literals only: scheduleReconnect(0) is the initial connect, which
  // is not a retry-after-failure and so has no backoff decision behind it.
  assert.doesNotMatch(
    src,
    /scheduleReconnect\(\s*[1-9]\d*\s*\)/,
    'reconnect delay must always come from the backoff policy',
  );
});

test('CRITICAL: the STOP branch exits the process', () => {
  // Giving up is only recoverable because the process exits: nothing polls
  // /health outside connect(), and /messages answers 200 [] whatever the
  // connection state, so a bridge that gave up while staying alive would
  // leave the gateway believing WhatsApp was connected indefinitely.
  // _check_managed_bridge_exit() watches the PROCESS, once per second.
  const branch = closeBranchSource(readFileSync(BRIDGE_PATH, 'utf8'), 'STOP');
  assert.match(
    branch,
    /process\.exit\(1\)/,
    'STOP must exit non-zero -- it is the only signal the gateway can observe',
  );
});

test('the EXIT branch (401) still exits the process', () => {
  const branch = closeBranchSource(readFileSync(BRIDGE_PATH, 'utf8'), 'EXIT');
  assert.match(branch, /process\.exit\(1\)/);
});

test('the RETRY path schedules rather than exits', () => {
  const src = readFileSync(BRIDGE_PATH, 'utf8');
  // The final `else` of the close handler is the retry path; it must schedule.
  assert.match(src, /scheduleReconnect\(decision\.delayMs\)/);
});

test('REGRESSION: attempt budgets are per disconnect class, not global', () => {
  // A single shared counter let 5 unrelated failures exhaust the budget for
  // the post-QR-scan 515, killing pairing right after the phone reports
  // success.
  //
  // This is the real guard for that bug. The pure-policy suite cannot catch
  // it -- reconnect_policy.js is handed an `attempt` number and cannot know
  // how the caller derived it -- so the assertion has to be about how
  // bridge.js counts.
  const src = readFileSync(BRIDGE_PATH, 'utf8');
  assert.match(src, /reconnectAttemptsByClass/);
  assert.match(
    src,
    /attempt:\s*reconnectAttemptsByClass\[disconnectClass\]/,
    'the attempt passed to decideReconnect must come from the per-class counter',
  );
});

test('the budget resets only after a sustained connection', () => {
  // Resetting on any 'open' let a flapping socket restart the schedule every
  // few seconds and never deplete the budget: measured at 266 sockets and
  // still going, where the fixed build stops after 11.
  const src = readFileSync(BRIDGE_PATH, 'utf8');
  assert.match(src, /SUSTAINED_CONNECTION_MS/);
  assert.match(src, /sustainedConnectionTimer = setTimeout\(/);
  // ...and a close must cancel a pending reset.
  assert.match(src, /clearTimeout\(sustainedConnectionTimer\)/);

  // The load-bearing part: the reset must happen INSIDE the timer callback.
  // Keeping the timer but hoisting the resets out of it restores the flap bug
  // while leaving every token above present.
  const callback = sustainedResetCallbackSource(src);
  assert.match(
    callback,
    /reconnectAttemptsByClass = Object\.create\(null\)/,
    'budgets must be cleared inside the sustained-connection timer, not on open',
  );
  assert.match(
    callback,
    /reconnectAttemptsTotal = 0/,
    'the total counter must reset inside the timer too',
  );
});

test('bridge.js preserves the pairing events through the new paths', () => {
  const src = readFileSync(BRIDGE_PATH, 'utf8');
  assert.match(src, /emitPairEvent\(\{ event: 'error', error: 'logged_out', reason \}\)/);
  assert.match(src, /emitPairEvent\(\{ event: 'disconnected', reason \}\)/);
  assert.match(src, /emitPairEvent\(\{ event: 'error', error: 'reconnect_gave_up', reason \}\)/);
});

test('/health surfaces reconnect state', () => {
  const src = readFileSync(BRIDGE_PATH, 'utf8');
  assert.match(src, /reconnectAttempts:\s*reconnectAttemptsTotal/);
  assert.match(src, /reconnectAttemptsByClass:/);
});
