import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MODES,
  advance,
  createState,
  normalizeState,
  reset,
  setMode,
  setPrimaryTarget,
  setSecondaryTarget,
  setStep,
  undo,
  updatePreferences,
} from './counter.js';

const MAX = Number.MAX_SAFE_INTEGER;

function createPendingNestedCompletion() {
  const initial = normalizeState({
    mode: 'nested',
    counter: { value: 1, target: 2 },
    secondary: { value: 0, target: 3 },
  });
  const completed = advance(initial);

  assert.equal(completed.counter.value, 2);
  assert.equal(completed.secondary.value, 1);
  assert.equal(completed.pendingReset, true);
  return completed;
}

test('exports all five modes', () => {
  assert.deepEqual(MODES, ['endless', 'target', 'auto', 'nested', 'countdown']);
});

test('creates a safe default state', () => {
  const before = Date.now();
  const state = createState();

  assert.deepEqual(state, {
    version: 1,
    mode: 'endless',
    counter: { value: 0, target: null },
    secondary: { value: 0, target: null },
    session: { total: 0, startedAt: state.session.startedAt },
    step: 1,
    pendingReset: false,
    preferences: {
      theme: 'system',
      tapVibration: true,
      targetVibration: true,
      keepAwake: false,
      animation: true,
    },
  });
  assert.ok(Number.isSafeInteger(state.session.startedAt));
  assert.ok(state.session.startedAt >= before);
  assert.ok(state.session.startedAt <= Date.now());
});

test('normalizes malformed and partial persisted data', () => {
  const state = normalizeState({
    version: 99,
    mode: 'unknown',
    counter: { value: -4, target: 3.8 },
    secondary: { value: MAX + 100, target: 0 },
    session: { total: -1, startedAt: -50 },
    step: 0,
    pendingReset: 'yes',
    preferences: {
      theme: 'sepia',
      tapVibration: false,
      targetVibration: 'no',
      keepAwake: true,
      animation: false,
    },
  });

  assert.equal(state.version, 1);
  assert.equal(state.mode, 'endless');
  assert.deepEqual(state.counter, { value: 0, target: null });
  assert.deepEqual(state.secondary, { value: MAX, target: null });
  assert.deepEqual(state.session, { total: 0, startedAt: 0 });
  assert.equal(state.step, 1);
  assert.equal(state.pendingReset, false);
  assert.deepEqual(state.preferences, {
    theme: 'system',
    tapVibration: false,
    targetVibration: true,
    keepAwake: true,
    animation: false,
  });
});

test('normalizes null input and copies valid nested state', () => {
  assert.deepEqual(normalizeState(null).counter, { value: 0, target: null });

  const input = {
    mode: 'nested',
    counter: { value: 2, target: 4 },
    secondary: { value: 1, target: 3 },
    session: { total: 7, startedAt: 10 },
    step: 2,
    pendingReset: true,
    preferences: { theme: 'dark' },
  };
  const state = normalizeState(input);

  assert.deepEqual(state.counter, input.counter);
  assert.deepEqual(state.secondary, input.secondary);
  assert.deepEqual(state.session, input.session);
  assert.notEqual(state.counter, input.counter);
  assert.notEqual(state.secondary, input.secondary);
  assert.notEqual(state.session, input.session);
  assert.notEqual(state.preferences, input.preferences);
});

test('repairs missing or invalid persisted primary targets with recommended defaults', () => {
  for (const mode of ['target', 'auto', 'nested', 'countdown']) {
    for (const invalid of [null, 0, 'invalid']) {
      const state = normalizeState({
        mode,
        counter: { value: 0, target: invalid },
      });

      assert.equal(state.counter.target, 100);
      assert.equal(state.counter.value, mode === 'countdown' ? 100 : 0);
    }
  }
});

test('repairs a missing or invalid persisted nested secondary target', () => {
  for (const invalid of [null, 0, 'invalid']) {
    const state = normalizeState({
      mode: 'nested',
      counter: { value: 0, target: 5 },
      secondary: { value: 0, target: invalid },
    });

    assert.deepEqual(state.secondary, { value: 0, target: 10 });
  }
});

test('preserves a valid completed persisted countdown', () => {
  const state = normalizeState({
    mode: 'countdown',
    counter: { value: 0, target: 9 },
  });

  assert.deepEqual(state.counter, { value: 0, target: 9 });
  assert.deepEqual(advance(state), state);
});

test('all repaired persisted target-bearing modes advance deterministically', () => {
  const target = advance(normalizeState({
    mode: 'target',
    counter: { value: 0, target: null },
  }));
  assert.deepEqual(target.counter, { value: 1, target: 100 });

  const auto = advance(normalizeState({
    mode: 'auto',
    counter: { value: 0, target: 0 },
  }));
  assert.deepEqual(auto.counter, { value: 1, target: 100 });
  assert.equal(auto.pendingReset, false);

  const nested = advance(normalizeState({
    mode: 'nested',
    counter: { value: 0, target: 'invalid' },
    secondary: { value: 0, target: null },
  }));
  assert.deepEqual(nested.counter, { value: 1, target: 100 });
  assert.deepEqual(nested.secondary, { value: 0, target: 10 });
  assert.equal(nested.pendingReset, false);

  const countdown = advance(normalizeState({
    mode: 'countdown',
    counter: { value: 0, target: null },
  }));
  assert.deepEqual(countdown.counter, { value: 99, target: 100 });
});

test('endless mode increments by step without mutating its input', () => {
  const original = normalizeState({ step: 3 });
  const state = advance(original);

  assert.equal(original.counter.value, 0);
  assert.equal(state.counter.value, 3);
  assert.equal(state.session.total, 3);
  assert.notEqual(state, original);
  assert.notEqual(state.counter, original.counter);
});

test('endless mode saturates at Number.MAX_SAFE_INTEGER', () => {
  const state = advance(normalizeState({
    counter: { value: MAX - 1 },
    session: { total: MAX - 1, startedAt: 1 },
    step: 10,
  }));

  assert.equal(state.counter.value, MAX);
  assert.equal(state.session.total, MAX);
});

test('target mode clamps at its target and then stops', () => {
  let state = normalizeState({
    mode: 'target',
    counter: { value: 8, target: 10 },
    session: { total: 8, startedAt: 1 },
    step: 3,
  });

  state = advance(state);
  assert.equal(state.counter.value, 10);
  assert.equal(state.session.total, 10);
  state = advance(state);
  assert.equal(state.counter.value, 10);
  assert.equal(state.session.total, 10);
});

test('switching a completed target count to auto creates held completion', () => {
  const completed = normalizeState({
    mode: 'target',
    counter: { value: 5, target: 5 },
  });
  const auto = setMode(completed, 'auto');

  assert.deepEqual(completed.counter, { value: 5, target: 5 });
  assert.equal(completed.pendingReset, false);
  assert.equal(auto.pendingReset, true);

  const nextCycle = advance(auto);
  assert.equal(nextCycle.counter.value, 1);
  assert.equal(nextCycle.pendingReset, false);
});

test('switching a completed target count to nested records one held cycle', () => {
  const completed = normalizeState({
    mode: 'target',
    counter: { value: 2, target: 2 },
    secondary: { value: 0, target: 3 },
  });
  const nested = setMode(completed, 'nested');

  assert.deepEqual(completed.secondary, { value: 0, target: 3 });
  assert.deepEqual(nested.secondary, { value: 1, target: 3 });
  assert.equal(nested.pendingReset, true);

  const nextCycle = advance(nested);
  assert.equal(nextCycle.counter.value, 1);
  assert.equal(nextCycle.secondary.value, 1);
  assert.equal(nextCycle.pendingReset, false);

  const nextCompletion = advance(nextCycle);
  assert.equal(nextCompletion.counter.value, 2);
  assert.equal(nextCompletion.secondary.value, 2);
  assert.equal(nextCompletion.pendingReset, true);
});

test('switching a completed target count to nested stops at secondary target', () => {
  const completed = normalizeState({
    mode: 'target',
    counter: { value: 2, target: 2 },
    secondary: { value: 0, target: 1 },
  });
  const nested = setMode(completed, 'nested');

  assert.deepEqual(nested.secondary, { value: 1, target: 1 });
  assert.equal(nested.pendingReset, false);
  assert.deepEqual(advance(nested), nested);
});

for (const { source, input, target } of [
  {
    source: 'endless above the default',
    input: { mode: 'endless', counter: { value: 120, target: null } },
    target: 100,
  },
  {
    source: 'countdown at target',
    input: { mode: 'countdown', counter: { value: 5, target: 5 } },
    target: 5,
  },
  {
    source: 'nested at target',
    input: {
      mode: 'nested',
      counter: { value: 5, target: 5 },
      secondary: { value: 1, target: 3 },
      pendingReset: true,
    },
    target: 5,
  },
  {
    source: 'target at completion',
    input: { mode: 'target', counter: { value: 5, target: 5 } },
    target: 5,
  },
]) {
  test(`switching ${source} into auto applies destination completion`, () => {
    const original = normalizeState(input);
    const auto = setMode(original, 'auto');

    assert.equal(original.mode, input.mode);
    assert.deepEqual(auto.counter, { value: target, target });
    assert.equal(auto.pendingReset, true);

    const nextCycle = advance(auto);
    assert.equal(nextCycle.counter.value, 1);
    assert.equal(nextCycle.pendingReset, false);
  });
}

for (const { source, input, target } of [
  {
    source: 'endless above the default',
    input: { mode: 'endless', counter: { value: 120, target: null } },
    target: 100,
  },
  {
    source: 'countdown at target',
    input: {
      mode: 'countdown',
      counter: { value: 5, target: 5 },
      secondary: { value: 0, target: 3 },
    },
    target: 5,
  },
  {
    source: 'auto at target',
    input: {
      mode: 'auto',
      counter: { value: 5, target: 5 },
      secondary: { value: 0, target: 3 },
      pendingReset: true,
    },
    target: 5,
  },
  {
    source: 'target at completion',
    input: {
      mode: 'target',
      counter: { value: 5, target: 5 },
      secondary: { value: 0, target: 3 },
    },
    target: 5,
  },
]) {
  test(`switching ${source} into nested records destination completion once`, () => {
    const original = normalizeState(input);
    const nested = setMode(original, 'nested');

    assert.equal(original.mode, input.mode);
    assert.deepEqual(nested.counter, { value: target, target });
    assert.equal(nested.secondary.value, 1);
    assert.equal(nested.pendingReset, true);

    const nextCycle = advance(nested);
    assert.equal(nextCycle.counter.value, 1);
    assert.equal(nextCycle.secondary.value, 1);
    assert.equal(nextCycle.pendingReset, false);
  });
}

test('auto mode holds completion and starts the next cycle without showing zero', () => {
  let state = normalizeState({
    mode: 'auto',
    counter: { value: 8, target: 10 },
    session: { total: 8, startedAt: 1 },
    step: 3,
  });

  state = advance(state);
  assert.equal(state.counter.value, 10);
  assert.equal(state.pendingReset, true);
  state = advance(state);
  assert.equal(state.counter.value, 3);
  assert.equal(state.pendingReset, false);
  assert.equal(state.session.total, 13);
});

test('nested mode increments a completed cycle exactly once', () => {
  let state = normalizeState({
    mode: 'nested',
    counter: { value: 1, target: 2 },
    secondary: { value: 0, target: 3 },
    session: { total: 1, startedAt: 1 },
  });

  state = advance(state);
  assert.deepEqual(state.counter, { value: 2, target: 2 });
  assert.deepEqual(state.secondary, { value: 1, target: 3 });
  assert.equal(state.pendingReset, true);

  state = advance(state);
  assert.equal(state.counter.value, 1);
  assert.equal(state.secondary.value, 1);
  assert.equal(state.pendingReset, false);

  state = advance(state);
  assert.equal(state.counter.value, 2);
  assert.equal(state.secondary.value, 2);
  assert.equal(state.pendingReset, true);
});

test('nested mode stops when the secondary target completes', () => {
  let state = normalizeState({
    mode: 'nested',
    counter: { value: 1, target: 2 },
    secondary: { value: 1, target: 2 },
  });

  state = advance(state);
  assert.equal(state.counter.value, 2);
  assert.equal(state.secondary.value, 2);
  assert.equal(state.pendingReset, false);

  const stopped = advance(state);
  assert.deepEqual(stopped, state);
});

test('changing the secondary target cannot count a pending nested cycle twice', () => {
  const completed = createPendingNestedCompletion();
  const changed = setSecondaryTarget(completed, 4);
  const advanced = advance(changed);

  assert.equal(completed.pendingReset, true);
  assert.equal(completed.secondary.target, 3);
  assert.equal(changed.pendingReset, true);
  assert.equal(advanced.counter.value, 1);
  assert.equal(advanced.secondary.value, 1);
});

test('changing the primary target cannot count a pending nested cycle twice', () => {
  const completed = createPendingNestedCompletion();
  const changed = setPrimaryTarget(completed, 4);
  const advanced = advance(changed);

  assert.equal(completed.pendingReset, true);
  assert.equal(completed.counter.target, 2);
  assert.equal(changed.counter.value, 2);
  assert.equal(changed.pendingReset, true);
  assert.equal(advanced.counter.value, 1);
  assert.equal(advanced.secondary.value, 1);
});

test('lowering a nested target below active progress completes one cycle exactly once', () => {
  const original = normalizeState({
    mode: 'nested',
    counter: { value: 8, target: 10 },
    secondary: { value: 1, target: 3 },
    session: { total: 8, startedAt: 1 },
    pendingReset: false,
  });
  const completed = setPrimaryTarget(original, 5);

  assert.deepEqual(original.counter, { value: 8, target: 10 });
  assert.deepEqual(original.secondary, { value: 1, target: 3 });
  assert.equal(original.pendingReset, false);
  assert.deepEqual(completed.counter, { value: 5, target: 5 });
  assert.deepEqual(completed.secondary, { value: 2, target: 3 });
  assert.equal(completed.pendingReset, true);
  assert.equal(completed.session.total, 8);

  const nextCycle = advance(completed);
  assert.equal(nextCycle.counter.value, 1);
  assert.equal(nextCycle.secondary.value, 2);
  assert.equal(nextCycle.pendingReset, false);
});

test('setting a nested target equal to active progress completes one cycle exactly once', () => {
  const original = normalizeState({
    mode: 'nested',
    counter: { value: 5, target: 10 },
    secondary: { value: 1, target: 3 },
    session: { total: 5, startedAt: 1 },
    pendingReset: false,
  });
  const completed = setPrimaryTarget(original, 5);

  assert.deepEqual(original.counter, { value: 5, target: 10 });
  assert.deepEqual(original.secondary, { value: 1, target: 3 });
  assert.equal(original.pendingReset, false);
  assert.deepEqual(completed.counter, { value: 5, target: 5 });
  assert.deepEqual(completed.secondary, { value: 2, target: 3 });
  assert.equal(completed.pendingReset, true);

  const nextCycle = advance(completed);
  assert.equal(nextCycle.counter.value, 1);
  assert.equal(nextCycle.secondary.value, 2);
  assert.equal(nextCycle.pendingReset, false);
});

test('lowering an auto target enters its normal held-completion state', () => {
  const original = normalizeState({
    mode: 'auto',
    counter: { value: 8, target: 10 },
    pendingReset: false,
  });
  const completed = setPrimaryTarget(original, 5);

  assert.equal(original.counter.value, 8);
  assert.equal(original.pendingReset, false);
  assert.deepEqual(completed.counter, { value: 5, target: 5 });
  assert.equal(completed.pendingReset, true);

  const nextCycle = advance(completed);
  assert.equal(nextCycle.counter.value, 1);
  assert.equal(nextCycle.pendingReset, false);
});

test('setting an auto target equal to active progress enters held completion', () => {
  const original = normalizeState({
    mode: 'auto',
    counter: { value: 5, target: 10 },
    pendingReset: false,
  });
  const completed = setPrimaryTarget(original, 5);

  assert.equal(original.counter.target, 10);
  assert.deepEqual(completed.counter, { value: 5, target: 5 });
  assert.equal(completed.pendingReset, true);

  const nextCycle = advance(completed);
  assert.equal(nextCycle.counter.value, 1);
  assert.equal(nextCycle.pendingReset, false);
});

test('lowering a target-mode target clamps to a consistent stopped state', () => {
  const original = normalizeState({
    mode: 'target',
    counter: { value: 8, target: 10 },
  });
  const completed = setPrimaryTarget(original, 5);
  const stopped = advance(completed);

  assert.equal(original.counter.value, 8);
  assert.deepEqual(completed.counter, { value: 5, target: 5 });
  assert.equal(completed.pendingReset, false);
  assert.deepEqual(stopped, completed);
});

test('setting target mode target equal to progress remains stopped', () => {
  const completed = setPrimaryTarget(normalizeState({
    mode: 'target',
    counter: { value: 5, target: 10 },
  }), 5);

  assert.equal(completed.pendingReset, false);
  assert.deepEqual(advance(completed), completed);
});

test('setting countdown target equal to remaining progress remains valid', () => {
  const configured = setPrimaryTarget(normalizeState({
    mode: 'countdown',
    counter: { value: 5, target: 10 },
  }), 5);
  const advanced = advance(configured);

  assert.deepEqual(configured.counter, { value: 5, target: 5 });
  assert.equal(configured.pendingReset, false);
  assert.equal(advanced.counter.value, 4);
});

test('combined target changes cannot count a pending nested cycle twice', () => {
  const completed = createPendingNestedCompletion();
  const changedPrimary = setPrimaryTarget(completed, 4);
  const closedSecondary = setSecondaryTarget(changedPrimary, 1);
  const reopenedSecondary = setSecondaryTarget(closedSecondary, 4);
  const advanced = advance(advance(reopenedSecondary));

  assert.equal(completed.pendingReset, true);
  assert.equal(advanced.secondary.value, 1);
});

test('reselecting nested mode cannot count a pending cycle twice', () => {
  const completed = createPendingNestedCompletion();
  const reselected = setMode(completed, 'nested');
  const advanced = advance(reselected);

  assert.equal(completed.pendingReset, true);
  assert.equal(reselected.pendingReset, true);
  assert.equal(advanced.counter.value, 1);
  assert.equal(advanced.secondary.value, 1);
});

test('leaving and returning to nested mode cannot recount a completed cycle', () => {
  const completed = createPendingNestedCompletion();
  const targetMode = setMode(completed, 'target');
  const nestedMode = setMode(targetMode, 'nested');
  const advanced = advance(nestedMode);

  assert.equal(completed.pendingReset, true);
  assert.equal(advanced.secondary.value, 1);
});

test('ordinary settings changes preserve a pending nested completion', () => {
  const completed = createPendingNestedCompletion();
  const stepped = setStep(completed, 1);
  const configured = updatePreferences(stepped, { theme: 'dark' });
  const advanced = advance(configured);

  assert.equal(completed.step, 1);
  assert.equal(completed.preferences.theme, 'system');
  assert.equal(configured.pendingReset, true);
  assert.equal(advanced.counter.value, 1);
  assert.equal(advanced.secondary.value, 1);
});

test('countdown starts at its target and subtracts step to zero', () => {
  let state = setMode(createState(), 'countdown');
  state = setPrimaryTarget(state, 5);
  assert.equal(state.counter.value, 5);

  state = setStep(state, 2);
  state = advance(state);
  assert.equal(state.counter.value, 3);
  state = advance(state);
  assert.equal(state.counter.value, 1);
  state = advance(state);
  assert.equal(state.counter.value, 0);
  state = advance(state);
  assert.equal(state.counter.value, 0);
  assert.equal(state.session.total, 5);
});

test('switching a zero counter to countdown starts from an existing target', () => {
  const state = setMode(normalizeState({
    mode: 'target',
    counter: { value: 0, target: 7 },
  }), 'countdown');

  assert.equal(state.counter.value, 7);
});

test('switching partial progress from any non-countdown mode starts countdown at target', () => {
  for (const mode of ['endless', 'target', 'auto', 'nested']) {
    const original = normalizeState({
      mode,
      counter: { value: 4, target: mode === 'endless' ? null : 12 },
      secondary: { value: 2, target: 10 },
    });
    const countdown = setMode(original, 'countdown');
    const expectedTarget = mode === 'endless' ? 100 : 12;

    assert.equal(original.counter.value, 4);
    assert.equal(countdown.counter.target, expectedTarget);
    assert.equal(countdown.counter.value, expectedTarget);
  }
});

test('entering target-bearing modes supplies recommended missing targets', () => {
  const target = setMode(createState(), 'target');
  const auto = setMode(createState(), 'auto');
  const nested = setMode(createState(), 'nested');
  const countdown = setMode(createState(), 'countdown');

  assert.deepEqual(target.counter, { value: 0, target: 100 });
  assert.deepEqual(auto.counter, { value: 0, target: 100 });
  assert.deepEqual(nested.counter, { value: 0, target: 100 });
  assert.deepEqual(nested.secondary, { value: 0, target: 10 });
  assert.deepEqual(countdown.counter, { value: 100, target: 100 });
});

test('configured countdown target edits preserve representable progress', () => {
  const completed = normalizeState({
    mode: 'countdown',
    counter: { value: 0, target: 5 },
  });
  const changedCompleted = setPrimaryTarget(completed, 10);
  assert.deepEqual(changedCompleted.counter, { value: 0, target: 10 });
  assert.deepEqual(completed.counter, { value: 0, target: 5 });

  const partial = normalizeState({
    mode: 'countdown',
    counter: { value: 3, target: 5 },
  });
  assert.deepEqual(setPrimaryTarget(partial, 10).counter, { value: 3, target: 10 });
  assert.deepEqual(setPrimaryTarget(partial, 2).counter, { value: 2, target: 2 });
});

test('setting the first countdown target initializes its remaining value', () => {
  const missingTarget = {
    mode: 'countdown',
    counter: { value: 0, target: null },
  };
  const initialized = setPrimaryTarget(missingTarget, 7);

  assert.deepEqual(missingTarget, {
    mode: 'countdown',
    counter: { value: 0, target: null },
  });
  assert.deepEqual(initialized.counter, { value: 7, target: 7 });
});

test('undo subtracts step in ordinary modes and reverses session total', () => {
  for (const mode of ['endless', 'target']) {
    const state = undo(normalizeState({
      mode,
      counter: { value: 2, target: mode === 'target' ? 5 : null },
      session: { total: 2, startedAt: 1 },
      step: 3,
    }));
    assert.equal(state.counter.value, 0);
    assert.equal(state.session.total, 0);
  }
});

test('countdown undo restores the remaining count only up to target', () => {
  let state = undo(normalizeState({
    mode: 'countdown',
    counter: { value: 4, target: 5 },
    session: { total: 1, startedAt: 1 },
    step: 3,
  }));

  assert.equal(state.counter.value, 5);
  assert.equal(state.session.total, 0);
  state = undo(state);
  assert.equal(state.counter.value, 5);
});

test('undo reverses a pending auto completion', () => {
  const state = undo(normalizeState({
    mode: 'auto',
    counter: { value: 5, target: 5 },
    session: { total: 5, startedAt: 1 },
    step: 2,
    pendingReset: true,
  }));

  assert.equal(state.counter.value, 3);
  assert.equal(state.session.total, 3);
  assert.equal(state.pendingReset, false);
});

test('undo reverses a pending nested completion and its cycle increment', () => {
  const state = undo(normalizeState({
    mode: 'nested',
    counter: { value: 5, target: 5 },
    secondary: { value: 2, target: 3 },
    session: { total: 10, startedAt: 1 },
    step: 2,
    pendingReset: true,
  }));

  assert.equal(state.counter.value, 3);
  assert.equal(state.secondary.value, 1);
  assert.equal(state.session.total, 8);
  assert.equal(state.pendingReset, false);
});

test('undo can reverse the final nested completion', () => {
  let state = normalizeState({
    mode: 'nested',
    counter: { value: 1, target: 2 },
    secondary: { value: 1, target: 2 },
    session: { total: 3, startedAt: 1 },
  });
  state = advance(state);
  assert.equal(state.pendingReset, false);

  state = undo(state);
  assert.equal(state.counter.value, 1);
  assert.equal(state.secondary.value, 1);
  assert.equal(state.session.total, 3);
});

test('reset clears progress and refreshes the session timestamp', () => {
  const ordinary = reset(normalizeState({
    mode: 'nested',
    counter: { value: 4, target: 5 },
    secondary: { value: 2, target: 3 },
    session: { total: 20, startedAt: 1 },
    pendingReset: true,
  }));
  assert.equal(ordinary.counter.value, 0);
  assert.equal(ordinary.secondary.value, 0);
  assert.equal(ordinary.session.total, 0);
  assert.ok(ordinary.session.startedAt > 1);
  assert.equal(ordinary.pendingReset, false);

  const countdown = reset(normalizeState({
    mode: 'countdown',
    counter: { value: 2, target: 9 },
    secondary: { value: 3, target: 4 },
    session: { total: 7, startedAt: 1 },
  }));
  assert.equal(countdown.counter.value, 9);
  assert.equal(countdown.secondary.value, 0);
  assert.equal(countdown.session.total, 0);
});

test('changing primary targets preserves progress and clamps only when needed', () => {
  let state = normalizeState({
    mode: 'target',
    counter: { value: 7, target: 10 },
  });

  state = setPrimaryTarget(state, 9);
  assert.equal(state.counter.value, 7);
  state = setPrimaryTarget(state, 5);
  assert.equal(state.counter.value, 5);
  state = setPrimaryTarget(state, 8);
  assert.equal(state.counter.value, 5);
});

test('changing a secondary target preserves or clamps nested progress', () => {
  let state = normalizeState({
    mode: 'nested',
    counter: { value: 1, target: 4 },
    secondary: { value: 3, target: 5 },
  });

  state = setSecondaryTarget(state, 4);
  assert.equal(state.secondary.value, 3);
  assert.equal(state.pendingReset, false);
  state = setSecondaryTarget(state, 2);
  assert.equal(state.secondary.value, 2);
});

test('target one works for target, auto, nested, and countdown modes', () => {
  let target = advance(normalizeState({
    mode: 'target',
    counter: { value: 0, target: 1 },
  }));
  assert.equal(target.counter.value, 1);

  let auto = advance(normalizeState({
    mode: 'auto',
    counter: { value: 0, target: 1 },
  }));
  assert.equal(auto.counter.value, 1);
  assert.equal(auto.pendingReset, true);
  auto = advance(auto);
  assert.equal(auto.counter.value, 1);
  assert.equal(auto.pendingReset, true);

  let nested = normalizeState({
    mode: 'nested',
    counter: { value: 0, target: 1 },
    secondary: { value: 0, target: 2 },
  });
  nested = advance(nested);
  assert.equal(nested.secondary.value, 1);
  nested = advance(nested);
  assert.equal(nested.secondary.value, 2);
  assert.equal(nested.pendingReset, false);

  let countdown = setPrimaryTarget(setMode(createState(), 'countdown'), 1);
  assert.equal(countdown.counter.value, 1);
  countdown = advance(countdown);
  assert.equal(countdown.counter.value, 0);
});

test('target-one auto completes a new cycle on every advance', () => {
  let state = normalizeState({
    mode: 'auto',
    counter: { value: 0, target: 1 },
    session: { total: 0, startedAt: 1 },
  });

  for (let cycle = 1; cycle <= 4; cycle += 1) {
    state = advance(state);
    assert.equal(state.counter.value, 1);
    assert.equal(state.pendingReset, true);
    assert.equal(state.session.total, cycle);
  }
});

test('target-one nested increments exactly once per advance until completion', () => {
  let state = normalizeState({
    mode: 'nested',
    counter: { value: 0, target: 1 },
    secondary: { value: 0, target: 3 },
  });

  for (let cycle = 1; cycle <= 3; cycle += 1) {
    state = advance(state);
    assert.equal(state.counter.value, 1);
    assert.equal(state.secondary.value, cycle);
    assert.equal(state.pendingReset, cycle < 3);
  }
  assert.deepEqual(advance(state), state);
});

test('active target setters coerce invalid targets to one', () => {
  for (const mode of ['target', 'auto', 'nested', 'countdown']) {
    for (const invalid of [null, undefined, '', 0, -5, Number.NaN]) {
      const state = setPrimaryTarget(normalizeState({
        mode,
        counter: { value: 0, target: 5 },
        secondary: { value: 0, target: 3 },
      }), invalid);
      assert.equal(state.counter.target, 1);
    }
  }

  assert.equal(setPrimaryTarget(createState(), 0).counter.target, null);
});

test('nested secondary setter coerces invalid targets to one', () => {
  for (const invalid of [null, undefined, '', 0, -5, Number.NaN]) {
    const state = setSecondaryTarget(normalizeState({
      mode: 'nested',
      counter: { value: 0, target: 5 },
      secondary: { value: 0, target: 3 },
    }), invalid);
    assert.equal(state.secondary.target, 1);
  }
});

test('setters sanitize modes, targets, and steps', () => {
  let state = setMode(createState(), 'target');
  state = setPrimaryTarget(state, MAX + 10);
  state = setSecondaryTarget(state, 2.9);
  state = setStep(state, MAX + 10);

  assert.equal(state.mode, 'target');
  assert.equal(state.counter.target, MAX);
  assert.equal(state.secondary.target, 2);
  assert.equal(state.step, MAX);
  assert.equal(setMode(state, 'invalid').mode, 'target');
  assert.equal(setStep(state, -1).step, 1);
});

test('primary target setter preserves the endless-mode target invariant', () => {
  const state = setPrimaryTarget(createState(), 10);

  assert.equal(state.counter.target, null);
});

test('updatePreferences merges only valid preference values', () => {
  const state = updatePreferences(createState(), {
    theme: 'dark',
    tapVibration: false,
    targetVibration: 'false',
    keepAwake: true,
    animation: false,
  });

  assert.deepEqual(state.preferences, {
    theme: 'dark',
    tapVibration: false,
    targetVibration: true,
    keepAwake: true,
    animation: false,
  });
});
