import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// bridge.js is a module with side-effects (starts HTTP server) when run as
// main. We import only the named exports we need. The server startup is guarded
// by an import.meta.url check in bridge.js so importing it here is safe.
import { OBSERVE_NON_SELF, parseObserveNonSelf, processIncoming, recordHermesSend, markRecentHermesSendForChat } from './bridge.js';

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
