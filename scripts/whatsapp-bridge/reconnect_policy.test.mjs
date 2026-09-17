import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DisconnectAction,
  DisconnectClass,
  RECONNECT_TUNING,
  backoffDelayMs,
  classifyDisconnect,
  decideReconnect,
} from './reconnect_policy.js';

// Deterministic RNGs so jitter is testable.
const RNG_MIN = () => 0;   // delay lands on the low edge  (raw / 2)
const RNG_MAX = () => 1;   // delay lands on the high edge (raw)

// ---------------------------------------------------------------------------
// Classification — retryable vs refused
// ---------------------------------------------------------------------------

test('401 loggedOut classifies as logged_out', () => {
  assert.equal(classifyDisconnect(401), DisconnectClass.LOGGED_OUT);
});

test('515 restartRequired classifies as restart_required', () => {
  assert.equal(classifyDisconnect(515), DisconnectClass.RESTART_REQUIRED);
});

test('transient codes classify as retryable', () => {
  for (const code of [408, 428, 503]) {
    assert.equal(classifyDisconnect(code), DisconnectClass.RETRYABLE, `code ${code}`);
  }
});

test('503 unavailableService is retryable — it was the cadence that was wrong, not the code', () => {
  // The 2026-07-28 incident started with a routine 503. It is genuinely
  // transient and SHOULD be retried; what broke the bridge was retrying it
  // every 3s forever.
  assert.equal(classifyDisconnect(503), DisconnectClass.RETRYABLE);
});

test('server refusals classify as refused', () => {
  for (const code of [403, 405, 411, 500]) {
    assert.equal(classifyDisconnect(code), DisconnectClass.REFUSED, `code ${code}`);
  }
});

test('440 connectionReplaced gets its own never-retry class', () => {
  // Another client owns the session. Every retry evicts them and they evict
  // us back, so even one retry starts a ping-pong fight.
  assert.equal(classifyDisconnect(440), DisconnectClass.REPLACED);
  assert.equal(RECONNECT_TUNING[DisconnectClass.REPLACED].maxAttempts, 0);
});

test('the FIRST 440 stops immediately — zero retries', () => {
  const d = decideReconnect({ reason: 440, attempt: 1 });
  assert.equal(d.action, DisconnectAction.STOP);
  assert.equal(d.delayMs, 0);
});

test('405 is refused even though it is absent from Baileys DisconnectReason', () => {
  // 405 is not in the enum at all. The old handler therefore fell into its
  // `else` branch and retried it every 3 seconds indefinitely.
  assert.equal(classifyDisconnect(405), DisconnectClass.REFUSED);
});

test('UNKNOWN codes are refused, not retryable — the old logic had this backwards', () => {
  for (const code of [999, 0, -1, undefined, null, NaN, 'nonsense']) {
    assert.equal(
      classifyDisconnect(code),
      DisconnectClass.REFUSED,
      `unrecognised code ${String(code)} must not be retryable-forever`,
    );
  }
});

// ---------------------------------------------------------------------------
// Backoff schedule
// ---------------------------------------------------------------------------

test('retryable backoff doubles: 3s, 6s, 12s, 24s, 48s, 96s', () => {
  const expected = [3000, 6000, 12000, 24000, 48000, 96000];
  expected.forEach((raw, i) => {
    const delay = backoffDelayMs({
      classification: DisconnectClass.RETRYABLE,
      attempt: i + 1,
      rng: RNG_MAX,
    });
    assert.equal(delay, raw, `attempt ${i + 1}`);
  });
});

test('retryable backoff is capped in the low minutes (2 min)', () => {
  for (const attempt of [7, 8, 20, 500]) {
    const delay = backoffDelayMs({
      classification: DisconnectClass.RETRYABLE,
      attempt,
      rng: RNG_MAX,
    });
    assert.equal(delay, 120000, `attempt ${attempt}`);
    assert.ok(delay <= 5 * 60 * 1000, 'cap must stay in the low minutes');
  }
});

test('refused backoff is aggressive: 60s, 120s, 240s, capped at 300s', () => {
  const expected = [60000, 120000, 240000];
  expected.forEach((raw, i) => {
    assert.equal(
      backoffDelayMs({ classification: DisconnectClass.REFUSED, attempt: i + 1, rng: RNG_MAX }),
      raw,
      `attempt ${i + 1}`,
    );
  });
  assert.equal(
    backoffDelayMs({ classification: DisconnectClass.REFUSED, attempt: 9, rng: RNG_MAX }),
    300000,
  );
});

test('515 restart retry stays fast on the first attempt', () => {
  const delay = backoffDelayMs({
    classification: DisconnectClass.RESTART_REQUIRED,
    attempt: 1,
    rng: RNG_MAX,
  });
  assert.equal(delay, 1000);
  assert.ok(delay <= 1000, 'pairing depends on 515 reconnecting promptly');
});

test('jitter keeps delay within [raw/2, raw] and is applied, not ignored', () => {
  const opts = { classification: DisconnectClass.RETRYABLE, attempt: 3 }; // raw = 12000
  const low = backoffDelayMs({ ...opts, rng: RNG_MIN });
  const high = backoffDelayMs({ ...opts, rng: RNG_MAX });
  const mid = backoffDelayMs({ ...opts, rng: () => 0.5 });

  assert.equal(low, 6000);
  assert.equal(high, 12000);
  assert.equal(mid, 9000);
  assert.notEqual(low, high, 'jitter must actually vary the delay');
});

test('jitter spreads real random draws across the window (anti-lockstep)', () => {
  // The gateway runs its own 300s reconnect cycle; identical delays every
  // time would let the two line up permanently.
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) {
    seen.add(backoffDelayMs({ classification: DisconnectClass.RETRYABLE, attempt: 4 }));
  }
  assert.ok(seen.size > 50, `expected a spread of delays, got ${seen.size} distinct values`);
  for (const d of seen) {
    assert.ok(d >= 12000 && d <= 24000, `delay ${d} outside [raw/2, raw]`);
  }
});

// ---------------------------------------------------------------------------
// decideReconnect — action selection and attempt ceiling
// ---------------------------------------------------------------------------

test('401 exits regardless of attempt count', () => {
  for (const attempt of [1, 5, 99]) {
    const d = decideReconnect({ reason: 401, attempt });
    assert.equal(d.action, DisconnectAction.EXIT);
    assert.equal(d.delayMs, 0);
  }
});

test('515 retries fast (behaviour preserved from the old handler)', () => {
  const d = decideReconnect({ reason: 515, attempt: 1, rng: RNG_MAX });
  assert.equal(d.action, DisconnectAction.RETRY);
  assert.equal(d.delayMs, 1000);
});

test('retryable code retries up to its budget then stops', () => {
  const { maxAttempts } = RECONNECT_TUNING[DisconnectClass.RETRYABLE];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    assert.equal(
      decideReconnect({ reason: 503, attempt }).action,
      DisconnectAction.RETRY,
      `attempt ${attempt} should still retry`,
    );
  }
  const past = decideReconnect({ reason: 503, attempt: maxAttempts + 1 });
  assert.equal(past.action, DisconnectAction.STOP);
  assert.equal(past.delayMs, 0);
});

test('refused code gets a small budget then stops', () => {
  const { maxAttempts } = RECONNECT_TUNING[DisconnectClass.REFUSED];
  assert.ok(maxAttempts <= 3, 'refusals must not get a generous budget');
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    assert.equal(decideReconnect({ reason: 405, attempt }).action, DisconnectAction.RETRY);
  }
  assert.equal(
    decideReconnect({ reason: 405, attempt: maxAttempts + 1 }).action,
    DisconnectAction.STOP,
  );
});

test('unknown code follows the refused budget and stops', () => {
  assert.equal(decideReconnect({ reason: 4242, attempt: 1 }).action, DisconnectAction.RETRY);
  assert.equal(decideReconnect({ reason: 4242, attempt: 4 }).action, DisconnectAction.STOP);
});

test('decision carries the context bridge.js logs', () => {
  const d = decideReconnect({ reason: 503, attempt: 2, rng: RNG_MAX });
  assert.equal(d.classification, DisconnectClass.RETRYABLE);
  assert.equal(d.attempt, 2);
  assert.equal(d.reason, 503);
  assert.equal(d.maxAttempts, RECONNECT_TUNING[DisconnectClass.RETRYABLE].maxAttempts);
});

// ---------------------------------------------------------------------------
// Incident regression (2026-07-28)
// ---------------------------------------------------------------------------

test('REGRESSION: a 503 outage can no longer produce ~1200 attempts/hour', () => {
  // Old behaviour: 3s fixed => 1200 attempts/hour, forever. That hammering is
  // what turned a transient 503 into an all-night 405 refusal.
  let elapsedMs = 0;
  let attempts = 0;
  for (let attempt = 1; attempt <= 100; attempt += 1) {
    const d = decideReconnect({ reason: 503, attempt, rng: RNG_MIN });
    if (d.action !== DisconnectAction.RETRY) break;
    attempts += 1;
    elapsedMs += d.delayMs;
  }

  assert.ok(attempts <= 12, `bridge made ${attempts} attempts; budget must be small`);
  assert.ok(
    attempts < 1200,
    'the whole point of this change: no more 1200 attempts/hour',
  );
  // And it gives up rather than looping forever.
  assert.equal(decideReconnect({ reason: 503, attempt: attempts + 1 }).action, DisconnectAction.STOP);
  // Sanity: the budget still spans a useful amount of real outage.
  assert.ok(elapsedMs > 60_000, `budget spanned only ${elapsedMs}ms of outage`);
});

test('REGRESSION: an undocumented 405 refusal stops quickly instead of hammering', () => {
  let attempts = 0;
  for (let attempt = 1; attempt <= 100; attempt += 1) {
    if (decideReconnect({ reason: 405, attempt }).action !== DisconnectAction.RETRY) break;
    attempts += 1;
  }
  assert.equal(attempts, 3, 'a refusal should stop after a small number of attempts');
});

test('the 515 schedule pairing depends on: prompt at attempt 1, still terminates', () => {
  // NOT a regression guard, despite covering the same ground as the pairing
  // bug -- deliberately renamed. This module is pure and stateless: it is
  // handed an `attempt` number, so passing `attempt: 1` here is green whether
  // or not bridge.js counts per class. A global-counter mutant survives it.
  //
  // The actual guard for that bug is in bridge.test.mjs:
  //   'REGRESSION: attempt budgets are per disconnect class, not global'
  // which inspects how bridge.js derives the number it passes in.
  //
  // What IS verified here is the schedule contract that fix relies on: a 515
  // evaluated at attempt 1 must reconnect promptly enough for pairing to
  // complete, and a pathological 515 loop must still terminate.
  const d = decideReconnect({ reason: 515, attempt: 1, rng: () => 1 });
  assert.equal(d.action, DisconnectAction.RETRY);
  assert.equal(d.delayMs, 1000, 'the pairing restart must still be prompt');

  assert.equal(
    decideReconnect({ reason: 515, attempt: 6 }).action,
    DisconnectAction.STOP,
    'a genuinely pathological 515 loop should still terminate',
  );
});
