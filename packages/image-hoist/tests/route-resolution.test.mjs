/**
 * Route resolution checks for the pre-step hoist.
 *
 * `agent/pre-step` runs before the upcoming request header is written, so the
 * logged header describes the *previous* step. A model switch must be read from
 * the newer `model/selection` row; otherwise the first step on the new route is
 * hoisted against the old provider and an image-bearing tool result reaches an
 * upstream that cannot read `function_call_output` images.
 *
 * Run with: node tests/route-resolution.test.mjs
 */
import assert from 'node:assert/strict';
import { upcomingProvider } from '../lib/index.js';

const selection = (seq, provider, model = 'deepseek-v4.1-flash') => ({
  seq, type: 'model/selection', time: 1790000000000 + seq, data: { provider, model }
});
const header = (seq, provider) => ({
  seq, type: 'request/header', time: 1790000000000 + seq,
  data: { header: { config: { provider, model: 'deepseek-v4.1-flash' } } }
});

const session = (events, loggedHeader) => ({
  snapshotEvents: () => events,
  requestHeader: () => loggedHeader === undefined ? undefined : { config: { provider: loggedHeader } }
});
const agentFor = (provider) => ({ options: { provider } });

let passed = 0;
const check = (label, actual, expected) => {
  assert.deepEqual(actual, expected);
  passed += 1;
  console.log(`ok ${passed} - ${label}`);
};

// The real failing order: turn 57 logged d1api, the user then picked
// tokensfree_ds, and the turn-58 header only lands after the pre-step.
check(
  'a newer model selection beats the previous request header',
  upcomingProvider(session([header(10, 'd1api'), selection(11, 'tokensfree_ds')]), agentFor('d1api')),
  'tokensfree_ds'
);

// Once the selection has been consumed the header is newer and wins again.
check(
  'a newer request header beats the consumed selection',
  upcomingProvider(session([selection(20, 'tokensfree_ds'), header(21, 'dashscope')]), agentFor('tokensfree_ds')),
  'dashscope'
);

// A resumed agent with no events falls back to its declared route.
check(
  'declared agent options are the last fallback',
  upcomingProvider(session([], undefined), agentFor('dashscope')),
  'dashscope'
);

// A selection row without a usable provider must not mask an older header.
check(
  'a malformed selection falls through to the older header',
  upcomingProvider(session([header(30, 'tokensfree_ds'), { seq: 31, type: 'model/selection', data: {} }]), agentFor('dashscope')),
  'tokensfree_ds'
);

console.log(`\nALL ${passed} ROUTE CHECKS PASSED`);