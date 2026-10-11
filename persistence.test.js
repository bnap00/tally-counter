import test from 'node:test';
import assert from 'node:assert/strict';

import {
  newerStoredEnvelope,
  nextStoredEnvelope,
  parseStoredEnvelope,
  runWithExclusiveLock,
} from './persistence.js';

const rawState = {
  version: 1,
  mode: 'endless',
  counter: { value: 7, target: null },
};

test('parses versioned envelopes and migrates legacy raw states at revision zero', () => {
  assert.deepEqual(
    parseStoredEnvelope(JSON.stringify({ revision: 4, state: rawState })),
    { revision: 4, state: rawState },
  );
  assert.deepEqual(
    parseStoredEnvelope(JSON.stringify(rawState)),
    { revision: 0, state: rawState },
  );
});

test('rejects malformed JSON and invalid envelope shapes', () => {
  for (const stored of [
    null,
    'not-json',
    'null',
    '[]',
    JSON.stringify({ revision: -1, state: rawState }),
    JSON.stringify({ revision: 1.5, state: rawState }),
    JSON.stringify({ revision: 2, state: null }),
    JSON.stringify({ revision: 2 }),
  ]) {
    assert.equal(parseStoredEnvelope(stored), null);
  }
});

test('accepts only valid envelopes with a newer revision', () => {
  const stored = JSON.stringify({ revision: 6, state: rawState });

  assert.deepEqual(newerStoredEnvelope(stored, 5), { revision: 6, state: rawState });
  assert.equal(newerStoredEnvelope(stored, 6), null);
  assert.equal(newerStoredEnvelope(stored, 7), null);
  assert.equal(newerStoredEnvelope(JSON.stringify(rawState), 0), null);
  assert.equal(newerStoredEnvelope('broken', 0), null);
});

test('creates the next monotonic envelope without changing the state', () => {
  assert.deepEqual(nextStoredEnvelope(rawState, 8), {
    revision: 9,
    state: rawState,
  });
});

test('serializes concurrent contexts through one exclusive Web Lock', async () => {
  let queue = Promise.resolve();
  const requests = [];
  const locks = {
    request(name, options, callback) {
      requests.push({ name, options });
      const result = queue.then(callback);
      queue = result.catch(() => {});
      return result;
    },
  };
  const events = [];
  let releaseFirst;
  let firstEntered;
  const entered = new Promise((resolve) => { firstEntered = resolve; });
  const first = runWithExclusiveLock(locks, 'tally-state-v1', async () => {
    events.push('first:start');
    firstEntered();
    await new Promise((resolve) => { releaseFirst = resolve; });
    events.push('first:end');
  });
  await entered;
  const second = runWithExclusiveLock(locks, 'tally-state-v1', () => {
    events.push('second');
  });

  await Promise.resolve();
  assert.deepEqual(events, ['first:start']);
  releaseFirst();
  await Promise.all([first, second]);

  assert.deepEqual(events, ['first:start', 'first:end', 'second']);
  assert.deepEqual(requests, [
    { name: 'tally-state-v1', options: { mode: 'exclusive' } },
    { name: 'tally-state-v1', options: { mode: 'exclusive' } },
  ]);
});

test('executes directly when Web Locks is unavailable', () => {
  let called = false;
  const result = runWithExclusiveLock(undefined, 'tally-state-v1', () => {
    called = true;
    return 42;
  });

  assert.equal(called, true);
  assert.equal(result, 42);
});
