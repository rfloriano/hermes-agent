import test from 'node:test';
import assert from 'node:assert/strict';

// bridge.js is a module with side-effects (starts HTTP server) when run as
// main. We import only the named exports we need. The server startup is guarded
// by an import.meta.url check in bridge.js so importing it here is safe.
import { OBSERVE_NON_SELF, parseObserveNonSelf } from './bridge.js';

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
