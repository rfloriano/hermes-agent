/**
 * Reconnect policy for the WhatsApp bridge socket.
 *
 * Pure decision logic, no I/O — so it can be unit-tested without a socket.
 * bridge.js owns the timers, logging and pairing events; this module only
 * answers "given this disconnect code and this many consecutive failures,
 * what should happen next, and how long should we wait?".
 *
 * ---------------------------------------------------------------------------
 * Why this exists (incident 2026-07-28)
 * ---------------------------------------------------------------------------
 * The previous handler was:
 *
 *   if (reason === DisconnectReason.loggedOut) process.exit(1);
 *   else setTimeout(startSocket, reason === 515 ? 1000 : 3000);
 *
 * Every non-401 code retried every 3 seconds, forever, with no backoff, no
 * jitter and no ceiling. WhatsApp returned a routine 503 (unavailableService);
 * the bridge hammered it at ~1,200 attempts/hour and the connection has been
 * refused with an undocumented 405 ever since. A transient blip became a
 * night-long outage.
 *
 * Two things were wrong, and both are fixed here:
 *   1. No backoff  -> exponential with a ceiling and jitter.
 *   2. Unknown codes were treated as retryable-forever. That is backwards:
 *      an unrecognised refusal is the server telling us to stop. Unknown now
 *      classifies as REFUSED, which gets the aggressive schedule and a small
 *      attempt budget.
 *
 * Note that `new Boom(undefined).output.statusCode === 500`, so a disconnect
 * carrying no usable error object also lands on 500. That is deliberately in
 * the refused set: "we do not know why this closed" is not a licence to retry
 * indefinitely.
 *
 * ---------------------------------------------------------------------------
 * How giving up recovers
 * ---------------------------------------------------------------------------
 * STOP means "this process cannot fix it" — bridge.js responds by exiting
 * non-zero. That is deliberate and load-bearing.
 *
 * An earlier draft of this module had the bridge stay alive reporting
 * `disconnected` on /health, on the assumption that the Python adapter
 * periodically polls health and restarts a disconnected bridge. **No such
 * poll exists.** Verified: /health is read only from inside
 * WhatsAppAdapter.connect(); the only runtime escalation is
 * _check_managed_bridge_exit(), which fires exclusively when the bridge
 * PROCESS exits. Meanwhile /messages keeps returning 200 [] whatever the
 * connection state, so the poll loop stays contented and silent. A bridge
 * that gave up but stayed alive would leave the gateway believing WhatsApp
 * was connected, forever, until a human intervened.
 *
 * Exiting routes into machinery that already works: the adapter's poll loop
 * calls _check_managed_bridge_exit() once per second, marks a retryable fatal
 * error, and the gateway's reconnect watcher spawns a fresh bridge with a
 * fresh budget.
 *
 * What paces that loop is THIS module's budget, not the watcher's backoff.
 * The watcher does have a 30s->300s schedule, but it never engages here:
 * WhatsAppAdapter.connect() waits up to 30s for the bridge to report
 * `connected`, and when it does not it warns and proceeds anyway
 * ("⚠ WhatsApp not connected after 30s"), calling _mark_connected() and
 * returning True. A successful connect() resets the watcher's counter, so it
 * re-queues immediately every time. The spacing between bridges is therefore
 * however long a bridge survives before exhausting its own budget.
 *
 * For a refusal that works out at ~5.3 min of backoff plus the ~30s connect
 * wait -- roughly one bridge every 6 minutes, 3 attempts each, so ~31
 * attempts/hour against the ~1,200/hour that caused the incident. Still
 * self-healing across outages longer than any single bridge's budget, because
 * each new bridge starts clean.
 */

/** What bridge.js should do next. */
export const DisconnectAction = {
  /** Session is dead; a human must re-pair. Exit the process. */
  EXIT: 'exit',
  /** Schedule another startSocket() after `delayMs`. */
  RETRY: 'retry',
  /** Budget exhausted. Stay alive, report disconnected, let the gateway act. */
  STOP: 'stop',
};

/** Why the socket closed, bucketed by what we should do about it. */
export const DisconnectClass = {
  LOGGED_OUT: 'logged_out',
  RESTART_REQUIRED: 'restart_required',
  RETRYABLE: 'retryable',
  REFUSED: 'refused',
  /** Another client owns the session. Retrying evicts them; never retry. */
  REPLACED: 'replaced',
};

/**
 * Transient, server-side or network conditions that clear on their own.
 *   408 connectionLost / timedOut
 *   428 connectionClosed
 *   503 unavailableService  <- the code that triggered the 2026-07-28 incident.
 *                              Genuinely retryable; the bug was the cadence.
 */
export const RETRYABLE_CODES = new Set([408, 428, 503]);

/**
 * The server declining us. Retrying fast makes these worse, not better.
 *   403 forbidden
 *   405 not in Baileys' DisconnectReason enum at all; observed in the wild
 *       as a hard refusal after the bridge hammered the endpoint
 *   411 multideviceMismatch  - needs re-pairing, not retrying
 *   500 badSession, and also Boom's fallback for "no usable error"
 * Anything not listed anywhere is treated as refused too — see classify().
 *
 * 440 connectionReplaced is deliberately NOT here; it gets its own class with
 * a zero-attempt budget, because every retry evicts the other client and
 * starts a ping-pong fight. See REPLACED.
 */
export const REFUSED_CODES = new Set([403, 405, 411, 500]);

/**
 * Per-class schedules.
 *
 *   restart   515 after pairing is routine and expected — keep it fast.
 *             Still budgeted so a pathological 515 loop cannot spin forever.
 *   retryable 3s -> 6s -> 12s -> 24s -> 48s -> 96s, capped at 2 min.
 *             ~10 attempts spans roughly 8 minutes of real outage.
 *   refused   starts at a minute and caps at five. Three strikes, then stop:
 *             if WhatsApp is refusing us, more attempts are what caused the
 *             incident in the first place.
 *   replaced  never retried in-process: attempt 1 already exceeds the budget,
 *             so the first 440 stops (and bridge.js exits, handing the
 *             decision to the gateway rather than fighting the other client).
 */
export const RECONNECT_TUNING = {
  [DisconnectClass.RESTART_REQUIRED]: { baseMs: 1_000, factor: 2, capMs: 30_000, maxAttempts: 5 },
  [DisconnectClass.RETRYABLE]: { baseMs: 3_000, factor: 2, capMs: 120_000, maxAttempts: 10 },
  [DisconnectClass.REFUSED]: { baseMs: 60_000, factor: 2, capMs: 300_000, maxAttempts: 3 },
  [DisconnectClass.REPLACED]: { baseMs: 0, factor: 1, capMs: 0, maxAttempts: 0 },
};

/**
 * Bucket a disconnect status code.
 *
 * @param {number|undefined|null} reason Boom statusCode from lastDisconnect.
 * @returns {string} a DisconnectClass value.
 */
export function classifyDisconnect(reason) {
  if (reason === 401) return DisconnectClass.LOGGED_OUT;
  if (reason === 515) return DisconnectClass.RESTART_REQUIRED;
  if (reason === 440) return DisconnectClass.REPLACED;
  if (RETRYABLE_CODES.has(reason)) return DisconnectClass.RETRYABLE;
  // REFUSED_CODES is explicit for documentation, but the fallback matters
  // more: unknown codes are refusals, never retryable-forever.
  return DisconnectClass.REFUSED;
}

/**
 * Exponential backoff with a ceiling and "equal jitter".
 *
 * Equal jitter (half fixed, half random) keeps growth predictable while
 * breaking lockstep. Lockstep is a real concern here: the Python gateway runs
 * its own 300s reconnect cycle, and an undithered bridge retry can line up
 * with it every time and produce a synchronised thundering herd of two.
 *
 * @param {object}   opts
 * @param {string}   opts.classification a DisconnectClass value.
 * @param {number}   opts.attempt        1-based consecutive failure count.
 * @param {function} [opts.rng]          injectable for deterministic tests.
 * @returns {number} delay in whole milliseconds.
 */
export function backoffDelayMs({ classification, attempt, rng = Math.random }) {
  const tuning = RECONNECT_TUNING[classification];
  if (!tuning) return 0;
  const n = Math.max(1, Number(attempt) || 1);
  const raw = Math.min(tuning.capMs, tuning.baseMs * Math.pow(tuning.factor, n - 1));
  const half = raw / 2;
  return Math.round(half + rng() * half);
}

/**
 * Decide what to do about a closed socket.
 *
 * @param {object}   opts
 * @param {number|undefined|null} opts.reason  Boom statusCode.
 * @param {number}   opts.attempt              1-based; counts THIS failure.
 * @param {function} [opts.rng]                injectable for tests.
 * @returns {{action: string, classification: string, delayMs: number,
 *            attempt: number, maxAttempts: number, reason: *}}
 */
export function decideReconnect({ reason, attempt, rng = Math.random }) {
  const classification = classifyDisconnect(reason);
  const n = Math.max(1, Number(attempt) || 1);

  if (classification === DisconnectClass.LOGGED_OUT) {
    return {
      action: DisconnectAction.EXIT,
      classification,
      delayMs: 0,
      attempt: n,
      maxAttempts: 0,
      reason,
    };
  }

  const { maxAttempts } = RECONNECT_TUNING[classification];
  if (n > maxAttempts) {
    return {
      action: DisconnectAction.STOP,
      classification,
      delayMs: 0,
      attempt: n,
      maxAttempts,
      reason,
    };
  }

  return {
    action: DisconnectAction.RETRY,
    classification,
    delayMs: backoffDelayMs({ classification, attempt: n, rng }),
    attempt: n,
    maxAttempts,
    reason,
  };
}
