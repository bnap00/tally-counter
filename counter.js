export const MODES = Object.freeze([
  'endless',
  'target',
  'auto',
  'nested',
  'countdown',
]);

const MAX = Number.MAX_SAFE_INTEGER;
const DEFAULT_PRIMARY_TARGET = 100;
const DEFAULT_SECONDARY_TARGET = 10;
const MODE_SET = new Set(MODES);
const THEMES = new Set(['system', 'light', 'dark']);

function nonNegativeInteger(value, fallback = 0) {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback;
  if (value <= 0) return 0;
  if (value >= MAX) return MAX;
  return Math.floor(value);
}

function positiveInteger(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'number' || Number.isNaN(value) || value <= 0) {
    return fallback;
  }
  if (value >= MAX) return MAX;
  return Math.max(1, Math.floor(value));
}

function booleanOr(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function saturatingAdd(value, amount) {
  return amount >= MAX - value ? MAX : value + amount;
}

function addSessionProgress(state, amount) {
  state.session.total = saturatingAdd(state.session.total, amount);
}

function subtractSessionProgress(state, amount) {
  state.session.total = Math.max(0, state.session.total - amount);
}

function boundedIncrement(state) {
  const { target, value } = state.counter;
  if (target === null || value >= target) return 0;

  const amount = Math.min(state.step, target - value);
  state.counter.value += amount;
  addSessionProgress(state, amount);
  return amount;
}

function completeNestedCycle(state) {
  const target = state.secondary.target;
  if (target === null) {
    state.secondary.value = saturatingAdd(state.secondary.value, 1);
    state.pendingReset = true;
    return;
  }

  state.secondary.value = Math.min(target, state.secondary.value + 1);
  state.pendingReset = state.secondary.value < target;
}

export function createState() {
  return {
    version: 1,
    mode: 'endless',
    counter: { value: 0, target: null },
    secondary: { value: 0, target: null },
    session: { total: 0, startedAt: Date.now() },
    step: 1,
    pendingReset: false,
    preferences: {
      theme: 'system',
      tapVibration: true,
      targetVibration: true,
      keepAwake: false,
      animation: true,
    },
  };
}

export function normalizeState(input) {
  const defaults = createState();
  const source = input && typeof input === 'object' ? input : {};
  const counter = source.counter && typeof source.counter === 'object'
    ? source.counter
    : {};
  const secondary = source.secondary && typeof source.secondary === 'object'
    ? source.secondary
    : {};
  const session = source.session && typeof source.session === 'object'
    ? source.session
    : {};
  const preferences = source.preferences && typeof source.preferences === 'object'
    ? source.preferences
    : {};
  const mode = MODE_SET.has(source.mode) ? source.mode : defaults.mode;
  const parsedPrimaryTarget = mode === 'endless'
    ? null
    : positiveInteger(counter.target);
  const repairedPrimaryTarget = mode !== 'endless' && parsedPrimaryTarget === null;
  const primaryTarget = repairedPrimaryTarget
    ? DEFAULT_PRIMARY_TARGET
    : parsedPrimaryTarget;
  const parsedSecondaryTarget = positiveInteger(secondary.target);
  const secondaryTarget = mode === 'nested' && parsedSecondaryTarget === null
    ? DEFAULT_SECONDARY_TARGET
    : parsedSecondaryTarget;
  let primaryValue = nonNegativeInteger(counter.value);
  let secondaryValue = nonNegativeInteger(secondary.value);

  if (mode === 'countdown' && repairedPrimaryTarget) {
    primaryValue = primaryTarget;
  } else if (primaryTarget !== null) {
    primaryValue = Math.min(primaryValue, primaryTarget);
  }
  if (secondaryTarget !== null) secondaryValue = Math.min(secondaryValue, secondaryTarget);

  const requestedReset = booleanOr(source.pendingReset, false);
  const pendingReset = requestedReset && (
    (mode === 'auto'
      && primaryTarget !== null
      && primaryValue === primaryTarget)
    || mode === 'nested'
  );

  return {
    version: 1,
    mode,
    counter: { value: primaryValue, target: primaryTarget },
    secondary: { value: secondaryValue, target: secondaryTarget },
    session: {
      total: nonNegativeInteger(session.total),
      startedAt: nonNegativeInteger(session.startedAt, defaults.session.startedAt),
    },
    step: positiveInteger(source.step, 1),
    pendingReset,
    preferences: {
      theme: THEMES.has(preferences.theme) ? preferences.theme : defaults.preferences.theme,
      tapVibration: booleanOr(
        preferences.tapVibration,
        defaults.preferences.tapVibration,
      ),
      targetVibration: booleanOr(
        preferences.targetVibration,
        defaults.preferences.targetVibration,
      ),
      keepAwake: booleanOr(preferences.keepAwake, defaults.preferences.keepAwake),
      animation: booleanOr(preferences.animation, defaults.preferences.animation),
    },
  };
}

export function advance(state) {
  const next = normalizeState(state);

  if (next.mode === 'endless') {
    const value = saturatingAdd(next.counter.value, next.step);
    const amount = value - next.counter.value;
    next.counter.value = value;
    addSessionProgress(next, amount);
    return next;
  }

  if (next.mode === 'target') {
    boundedIncrement(next);
    return next;
  }

  if (next.mode === 'countdown') {
    const amount = Math.min(next.step, next.counter.value);
    next.counter.value -= amount;
    addSessionProgress(next, amount);
    return next;
  }

  if (next.counter.target === null) return next;

  if (next.mode === 'auto') {
    if (next.pendingReset) {
      next.counter.value = Math.min(next.step, next.counter.target);
      addSessionProgress(next, next.counter.value);
      next.pendingReset = next.counter.value === next.counter.target;
      return next;
    }

    if (next.counter.value >= next.counter.target) {
      next.pendingReset = true;
      return next;
    }

    boundedIncrement(next);
    next.pendingReset = next.counter.value === next.counter.target;
    return next;
  }

  const secondaryComplete = next.secondary.target !== null
    && next.secondary.value >= next.secondary.target;
  if (secondaryComplete) return next;

  if (next.pendingReset) {
    next.counter.value = Math.min(next.step, next.counter.target);
    addSessionProgress(next, next.counter.value);
    next.pendingReset = false;
    if (next.counter.value === next.counter.target) completeNestedCycle(next);
    return next;
  }

  if (next.counter.value >= next.counter.target) {
    return next;
  }

  boundedIncrement(next);
  if (next.counter.value === next.counter.target) completeNestedCycle(next);
  return next;
}

export function undo(state) {
  const next = normalizeState(state);

  if (next.mode === 'countdown') {
    if (next.counter.target === null) return next;
    const value = Math.min(next.counter.target, next.counter.value + next.step);
    const amount = value - next.counter.value;
    next.counter.value = value;
    subtractSessionProgress(next, amount);
    return next;
  }

  const reversesNestedCompletion = next.mode === 'nested'
    && (next.pendingReset
      || (next.counter.target !== null
        && next.counter.value === next.counter.target
        && next.secondary.target !== null
        && next.secondary.value === next.secondary.target));

  if (reversesNestedCompletion) {
    next.secondary.value = Math.max(0, next.secondary.value - 1);
  }

  const amount = Math.min(next.step, next.counter.value);
  next.counter.value -= amount;
  subtractSessionProgress(next, amount);
  next.pendingReset = false;
  return next;
}

export function reset(state) {
  const next = normalizeState(state);
  next.counter.value = next.mode === 'countdown' && next.counter.target !== null
    ? next.counter.target
    : 0;
  next.secondary.value = 0;
  next.session.total = 0;
  next.session.startedAt = Date.now();
  next.pendingReset = false;
  return next;
}

export function setMode(state, mode) {
  const next = normalizeState(state);
  if (!MODE_SET.has(mode)) return next;
  if (mode === next.mode) {
    if (mode !== 'endless' && next.counter.target === null) {
      next.counter.target = DEFAULT_PRIMARY_TARGET;
      if (mode === 'countdown') next.counter.value = DEFAULT_PRIMARY_TARGET;
    }
    if (mode === 'nested' && next.secondary.target === null) {
      next.secondary.target = DEFAULT_SECONDARY_TARGET;
    }
    return normalizeState(next);
  }

  const leavesPendingNestedCycle = next.mode === 'nested' && next.pendingReset;

  next.mode = mode;
  if (mode === 'endless') {
    next.counter.target = null;
    if (leavesPendingNestedCycle) next.counter.value = 0;
  } else {
    if (next.counter.target === null) next.counter.target = DEFAULT_PRIMARY_TARGET;
    if (mode === 'nested' && next.secondary.target === null) {
      next.secondary.target = DEFAULT_SECONDARY_TARGET;
    }
    if (mode === 'countdown') {
      next.counter.value = next.counter.target;
    } else if (leavesPendingNestedCycle && mode !== 'auto' && mode !== 'nested') {
      next.counter.value = 0;
    } else {
      next.counter.value = Math.min(next.counter.value, next.counter.target);
    }
  }
  const completesInDestination = (mode === 'auto' || mode === 'nested')
    && next.counter.target !== null
    && next.counter.value >= next.counter.target;
  next.pendingReset = false;
  if (completesInDestination && mode === 'auto') {
    next.pendingReset = true;
  } else if (completesInDestination && mode === 'nested') {
    const secondaryComplete = next.secondary.target !== null
      && next.secondary.value >= next.secondary.target;
    if (!secondaryComplete) completeNestedCycle(next);
  }
  return normalizeState(next);
}

export function setPrimaryTarget(state, target) {
  const next = normalizeState(state);
  const pendingReset = next.pendingReset;
  const hadTarget = next.counter.target !== null;
  next.counter.target = positiveInteger(target, next.mode === 'endless' ? null : 1);
  const completesAtTarget = !pendingReset
    && next.counter.target !== null
    && next.counter.value >= next.counter.target;

  if (next.counter.target !== null && next.mode !== 'endless') {
    if (next.mode === 'countdown' && !hadTarget) {
      next.counter.value = next.counter.target;
    } else {
      next.counter.value = Math.min(next.counter.value, next.counter.target);
    }
  }
  next.pendingReset = pendingReset;
  if (completesAtTarget && next.mode === 'auto') {
    next.pendingReset = true;
  } else if (completesAtTarget && next.mode === 'nested') {
    const secondaryComplete = next.secondary.target !== null
      && next.secondary.value >= next.secondary.target;
    if (!secondaryComplete) completeNestedCycle(next);
  }
  return normalizeState(next);
}

export function setSecondaryTarget(state, target) {
  const next = normalizeState(state);
  const completedCycle = next.pendingReset
    || (next.mode === 'nested'
      && next.counter.target !== null
      && next.counter.value === next.counter.target
      && next.secondary.target !== null
      && next.secondary.value === next.secondary.target);
  next.secondary.target = positiveInteger(target, next.mode === 'nested' ? 1 : null);
  if (next.secondary.target !== null) {
    next.secondary.value = Math.min(next.secondary.value, next.secondary.target);
  }
  next.pendingReset = completedCycle;
  return normalizeState(next);
}

export function setStep(state, step) {
  const next = normalizeState(state);
  next.step = positiveInteger(step, 1);
  return next;
}

export function updatePreferences(state, patch) {
  const next = normalizeState(state);
  const source = patch && typeof patch === 'object' ? patch : {};

  if (THEMES.has(source.theme)) next.preferences.theme = source.theme;
  for (const key of ['tapVibration', 'targetVibration', 'keepAwake', 'animation']) {
    if (typeof source[key] === 'boolean') next.preferences[key] = source[key];
  }
  return next;
}
