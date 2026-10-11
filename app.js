import {
  advance,
  createState,
  reset,
  setMode,
  setPrimaryTarget,
  setSecondaryTarget,
  setStep,
  undo,
  updatePreferences,
} from './counter.js';
import {
  normalizeAppState,
  newerStoredEnvelope,
  nextStoredEnvelope,
  parseStoredEnvelope,
  runWithExclusiveLock,
} from './persistence.js';

const STORAGE_KEY = 'tally-state-v1';
const modeLabels = {
  endless: 'Endless',
  target: 'Target',
  auto: 'Auto reset',
  nested: 'Cycles',
  countdown: 'Countdown',
};
const numberFormat = new Intl.NumberFormat();
const themeColors = { light: '#eee9df', dark: '#1d1c1a', black: '#000000' };
const colorScheme = window.matchMedia('(prefers-color-scheme: dark)');

const app = document.querySelector('#app');
const counterButton = document.querySelector('#counter-button');
const currentValue = document.querySelector('#current-value');
const modeStatus = document.querySelector('#mode-status');
const targetStatus = document.querySelector('#target-status');
const targetValue = document.querySelector('#target-value');
const cycleStatus = document.querySelector('#cycle-status');
const sessionTotal = document.querySelector('#session-total');
const elapsedTime = document.querySelector('#elapsed-time');
const undoButton = document.querySelector('#undo-button');
const resetButton = document.querySelector('#reset-button');
const resetConfirmation = document.querySelector('#reset-confirmation');
const confirmResetButton = document.querySelector('#confirm-reset-button');
const cancelResetButton = document.querySelector('#cancel-reset-button');
const settingsButton = document.querySelector('#settings-button');
const settingsDialog = document.querySelector('#settings-dialog');
const closeSettingsButton = document.querySelector('#close-settings-button');
const modeControl = document.querySelector('#mode');
const primaryTargetControl = document.querySelector('#primary-target');
const secondaryTargetControl = document.querySelector('#secondary-target');
const secondaryTargetRow = document.querySelector('#secondary-target-row');
const stepControl = document.querySelector('#step');
const themeControl = document.querySelector('#theme');
const tapVibrationControl = document.querySelector('#tap-vibration');
const targetVibrationControl = document.querySelector('#target-vibration');
const animationControl = document.querySelector('#animation');
const keepAwakeControl = document.querySelector('#keep-awake');
const presetTargets = document.querySelector('#preset-targets');
const liveStatus = document.querySelector('#live-status');
const themeColorMeta = document.querySelector('#theme-color');

function loadStoredState() {
  try {
    const envelope = parseStoredEnvelope(localStorage.getItem(STORAGE_KEY));
    return envelope === null
      ? { revision: 0, state: createState() }
      : { revision: envelope.revision, state: normalizeAppState(envelope.state) };
  } catch {
    return { revision: 0, state: createState() };
  }
}

const storedState = loadStoredState();
let state = storedState.state;
let revision = storedState.revision;
let dirty = false;
let wakeLock = null;
let wakeLockRequest = null;
let wakeLockRequestToken = 0;
let motionTimer = 0;

function refreshFromStorage() {
  try {
    const envelope = newerStoredEnvelope(localStorage.getItem(STORAGE_KEY), revision);
    if (envelope === null) return false;

    state = normalizeAppState(envelope.state);
    revision = envelope.revision;
    dirty = false;
    render();
    return true;
  } catch {
    return false;
  }
}

function persist() {
  if (!dirty) return false;

  try {
    const envelope = nextStoredEnvelope(state, revision);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope));
    revision = envelope.revision;
    dirty = false;
    return true;
  } catch {
    // Counting remains available when storage is unavailable or full.
    return false;
  }
}

function isPrimaryComplete(value = state) {
  if (value.counter.target === null) return false;
  return value.mode === 'countdown'
    ? value.counter.value === 0
    : value.counter.value === value.counter.target;
}

function isSecondaryComplete(value = state) {
  return value.mode === 'nested'
    && value.secondary.target !== null
    && value.secondary.value === value.secondary.target;
}

function formInteger(control) {
  const value = control.valueAsNumber;
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 1;
}

function syncThemeColor() {
  const resolvedTheme = state.preferences.theme === 'system'
    ? (colorScheme.matches ? 'dark' : 'light')
    : state.preferences.theme;
  themeColorMeta.content = themeColors[resolvedTheme];
}

function progressFor(value) {
  const target = value.counter.target;
  if (target === null || target === 0) return 0;
  if (value.mode === 'countdown') return (target - value.counter.value) / target;
  return value.counter.value / target;
}

function describeAction() {
  const current = numberFormat.format(state.counter.value);
  const target = state.counter.target === null ? '' : numberFormat.format(state.counter.target);
  const step = numberFormat.format(state.step);

  if (state.mode === 'endless') return `Add ${step}. Current value ${current}.`;
  if (state.mode === 'countdown') {
    return state.counter.value === 0
      ? `Countdown complete. ${current} remaining.`
      : `Subtract ${step}. ${current} of ${target} remaining.`;
  }
  if (state.mode === 'auto' && state.pendingReset) {
    return `Start the next count. Target complete at ${target}.`;
  }
  if (state.mode === 'nested' && state.pendingReset) {
    const cycles = numberFormat.format(state.secondary.value);
    return `Start the next cycle. ${cycles} cycles complete.`;
  }
  if (isSecondaryComplete()) return 'Cycle target complete.';
  if (isPrimaryComplete()) return `Target complete. ${current} of ${target}.`;
  return `Add ${step}. ${current} of ${target}.`;
}

function formatElapsed() {
  const seconds = Math.max(0, Math.floor((Date.now() - state.session.startedAt) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

function renderElapsed() {
  elapsedTime.textContent = formatElapsed();
}

function render() {
  const complete = isPrimaryComplete() || isSecondaryComplete();
  const held = state.pendingReset;
  const target = state.counter.target;
  const nested = state.mode === 'nested';
  const endless = state.mode === 'endless';
  const modeLabel = modeLabels[state.mode];
  const formattedCurrent = numberFormat.format(state.counter.value);

  currentValue.textContent = formattedCurrent;
  currentValue.classList.toggle('value-long', formattedCurrent.length > 6);
  currentValue.classList.toggle('value-very-long', formattedCurrent.length > 12);
  sessionTotal.textContent = numberFormat.format(state.session.total);
  modeStatus.textContent = complete ? `${modeLabel} · Complete` : modeLabel;
  counterButton.setAttribute('aria-label', describeAction());
  app.style.setProperty('--progress', String(Math.max(0, Math.min(1, progressFor(state)))));
  app.dataset.complete = String(complete);
  app.dataset.pending = String(held);

  targetStatus.hidden = endless;
  targetValue.textContent = target === null ? '—' : numberFormat.format(target);
  cycleStatus.hidden = !nested;
  cycleStatus.textContent = state.secondary.target === null
    ? `${numberFormat.format(state.secondary.value)} cycles`
    : `Cycle ${numberFormat.format(state.secondary.value)} of ${numberFormat.format(state.secondary.target)}`;

  const cannotUndo = state.mode === 'countdown'
    ? target === null || state.counter.value >= target
    : state.counter.value === 0 && !state.pendingReset;
  undoButton.disabled = cannotUndo;
  undoButton.textContent = state.mode === 'countdown'
    ? `Restore ${numberFormat.format(state.step)}`
    : `Subtract ${numberFormat.format(state.step)}`;
  undoButton.setAttribute('aria-label', state.mode === 'countdown'
    ? `Restore ${numberFormat.format(state.step)}`
    : `Subtract ${numberFormat.format(state.step)}`);

  modeControl.value = state.mode;
  primaryTargetControl.value = target ?? '';
  primaryTargetControl.disabled = endless;
  secondaryTargetControl.value = state.secondary.target ?? '';
  secondaryTargetRow.hidden = !nested;
  stepControl.value = state.step;
  themeControl.value = state.preferences.theme;
  tapVibrationControl.checked = state.preferences.tapVibration;
  targetVibrationControl.checked = state.preferences.targetVibration;
  animationControl.checked = state.preferences.animation;
  keepAwakeControl.checked = state.preferences.keepAwake;
  for (const button of presetTargets.querySelectorAll('button')) button.disabled = endless;

  document.documentElement.dataset.theme = state.preferences.theme;
  syncThemeColor();
  app.classList.toggle('motion-disabled', !state.preferences.animation);
  renderElapsed();
}

function announce(message) {
  liveStatus.textContent = '';
  requestAnimationFrame(() => {
    liveStatus.textContent = message;
  });
}

function playMotion(completed) {
  if (!state.preferences.animation) return;
  window.clearTimeout(motionTimer);
  counterButton.classList.remove('is-tapping', 'is-completing');
  void counterButton.offsetWidth;
  counterButton.classList.add(completed ? 'is-completing' : 'is-tapping');
  motionTimer = window.setTimeout(() => {
    counterButton.classList.remove('is-tapping', 'is-completing');
  }, 140);
}

function vibrate(kind) {
  if (!('vibrate' in navigator)) return;

  if (state.preferences.targetVibration && kind === 'secondary') {
    navigator.vibrate([28, 36, 28, 36, 52]);
  } else if (state.preferences.targetVibration && kind === 'primary') {
    navigator.vibrate([18, 32, 30]);
  } else if (state.preferences.tapVibration && kind === 'ordinary') {
    navigator.vibrate(8);
  }
}

function commit(transition, feedback, theme) {
  return runWithExclusiveLock(navigator.locks, STORAGE_KEY, () => {
    refreshFromStorage();
    const before = state;
    const next = normalizeAppState(transition(before), theme ?? before.preferences.theme);
    const changed = JSON.stringify(next) !== JSON.stringify(before);
    state = next;
    if (changed) dirty = true;
    render();
    if (changed) persist();
    feedback?.({ before, next, changed });
    return { before, next, changed };
  });
}

function persistDirtyState() {
  return runWithExclusiveLock(navigator.locks, STORAGE_KEY, () => {
    refreshFromStorage();
    persist();
  });
}

function advanceOutcome(before, after) {
  const secondaryIncreased = after.mode === 'nested'
    && after.secondary.value > before.secondary.value;
  const secondaryCompleted = secondaryIncreased
    && after.secondary.target !== null
    && after.secondary.value === after.secondary.target;
  const autoTargetOneCycle = after.mode === 'auto'
    && after.counter.target === 1
    && before.pendingReset
    && after.pendingReset;
  const newlyComplete = !isPrimaryComplete(before) && isPrimaryComplete(after);
  const primaryCompleted = secondaryIncreased || autoTargetOneCycle || newlyComplete;
  const progressed = after.counter.value !== before.counter.value
    || after.secondary.value !== before.secondary.value
    || after.session.total !== before.session.total;

  if (secondaryCompleted) {
    return { kind: 'secondary', message: 'Cycle target complete.' };
  }
  if (primaryCompleted) {
    const message = after.mode === 'countdown' ? 'Countdown complete.' : 'Target complete.';
    return { kind: 'primary', message };
  }
  if (!progressed) return { kind: 'none', message: null };
  return {
    kind: 'ordinary',
    message: `Current value ${numberFormat.format(after.counter.value)}.`,
  };
}

function advanceCounter() {
  return commit(advance, ({ before, next }) => {
    const outcome = advanceOutcome(before, next);
    if (outcome.kind === 'none') liveStatus.textContent = '';
    if (outcome.message) announce(outcome.message);
    if (outcome.kind !== 'none') {
      playMotion(outcome.kind !== 'ordinary');
      vibrate(outcome.kind);
    }
  });
}

function closeResetConfirmation(restoreFocus = false) {
  resetConfirmation.hidden = true;
  resetButton.setAttribute('aria-expanded', 'false');
  if (restoreFocus) resetButton.focus();
}

function openResetConfirmation() {
  resetConfirmation.hidden = false;
  resetButton.setAttribute('aria-expanded', 'true');
  confirmResetButton.focus();
}

function shouldKeepWakeLock() {
  return state.preferences.keepAwake && document.visibilityState === 'visible';
}

async function syncWakeLock() {
  if (!shouldKeepWakeLock()) {
    wakeLockRequestToken += 1;
    const lock = wakeLock;
    wakeLock = null;
    if (lock) await lock.release().catch(() => {});
    return;
  }
  if (wakeLock || wakeLockRequest || !navigator.wakeLock) return;

  const token = ++wakeLockRequestToken;
  const request = navigator.wakeLock.request('screen');
  wakeLockRequest = request;
  try {
    const lock = await request;
    if (token !== wakeLockRequestToken || !shouldKeepWakeLock()) {
      await lock.release().catch(() => {});
      return;
    }

    wakeLock = lock;
    lock.addEventListener('release', () => {
      if (wakeLock !== lock) return;
      wakeLock = null;
      if (shouldKeepWakeLock()) {
        window.setTimeout(() => { void syncWakeLock(); }, 0);
      }
    }, { once: true });
  } catch {
    // Wake lock is optional and may be denied by the browser.
  } finally {
    if (wakeLockRequest === request) wakeLockRequest = null;
    if (token !== wakeLockRequestToken && shouldKeepWakeLock() && !wakeLock) {
      window.setTimeout(() => { void syncWakeLock(); }, 0);
    }
  }
}

counterButton.addEventListener('click', () => {
  void advanceCounter();
});

undoButton.addEventListener('click', () => {
  void commit(undo, ({ before, next }) => {
    const verb = before.mode === 'countdown' ? 'Restored' : 'Subtracted';
    announce(`${verb}. Current value ${numberFormat.format(next.counter.value)}.`);
  });
});

resetButton.addEventListener('click', () => {
  if (resetConfirmation.hidden) openResetConfirmation();
  else closeResetConfirmation(true);
});

confirmResetButton.addEventListener('click', () => {
  closeResetConfirmation();
  void commit(reset, () => {
    announce('Session reset.');
    counterButton.focus();
  });
});

cancelResetButton.addEventListener('click', () => closeResetConfirmation(true));

settingsButton.addEventListener('click', () => {
  closeResetConfirmation();
  settingsDialog.showModal();
});
closeSettingsButton.addEventListener('click', () => settingsDialog.close());

modeControl.addEventListener('change', () => {
  const mode = modeControl.value;
  void commit((current) => setMode(current, mode), ({ next }) => {
    announce(`${modeLabels[next.mode]} mode.`);
  });
});

primaryTargetControl.addEventListener('change', () => {
  const target = formInteger(primaryTargetControl);
  void commit((current) => setPrimaryTarget(current, target), () => {
    announce('Primary target updated.');
  });
});

secondaryTargetControl.addEventListener('change', () => {
  const target = formInteger(secondaryTargetControl);
  void commit((current) => setSecondaryTarget(current, target), () => {
    announce('Cycle target updated.');
  });
});

stepControl.addEventListener('change', () => {
  const step = formInteger(stepControl);
  void commit((current) => setStep(current, step), () => {
    announce('Step updated.');
  });
});

presetTargets.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-target]');
  if (!button || button.disabled) return;
  const target = Number(button.dataset.target);
  const label = button.textContent.trim();
  void commit((current) => setPrimaryTarget(current, target), () => {
    announce(`Target ${label}.`);
  });
});

themeControl.addEventListener('change', () => {
  const theme = themeControl.value;
  void commit((current) => updatePreferences(current, { theme }), undefined, theme);
});

for (const [control, preference] of [
  [tapVibrationControl, 'tapVibration'],
  [targetVibrationControl, 'targetVibration'],
  [animationControl, 'animation'],
  [keepAwakeControl, 'keepAwake'],
]) {
  control.addEventListener('change', () => {
    const checked = control.checked;
    void commit((current) => updatePreferences(current, { [preference]: checked }), () => {
      if (preference === 'keepAwake') void syncWakeLock();
    });
  });
}

document.addEventListener('keydown', (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;

  const globalShortcut = event.key === ' '
    || event.key === 'Enter'
    || event.key === '-'
    || event.key === 'Backspace'
    || event.key.toLowerCase() === 'r';
  if (settingsDialog.open) {
    const inDialogControl = event.target.closest?.('input, select, textarea, button, [contenteditable="true"]');
    if (!inDialogControl && globalShortcut) event.preventDefault();
    return;
  }

  if (event.key === 'Escape' && !resetConfirmation.hidden) {
    event.preventDefault();
    closeResetConfirmation(true);
    return;
  }

  const inControl = event.target.closest('input, select, textarea, button, [contenteditable="true"]');
  if (inControl) return;

  if (event.key === ' ' || event.key === 'Enter') {
    event.preventDefault();
    void advanceCounter();
  } else if (event.key === '-' || event.key === 'Backspace') {
    event.preventDefault();
    if (!undoButton.disabled) undoButton.click();
  } else if (event.key.toLowerCase() === 'r') {
    event.preventDefault();
    openResetConfirmation();
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && dirty) void persistDirtyState();
  void syncWakeLock();
});

window.addEventListener('storage', (event) => {
  if (event.key !== STORAGE_KEY) return;
  const envelope = newerStoredEnvelope(event.newValue, revision);
  if (envelope === null) return;

  state = normalizeAppState(envelope.state);
  revision = envelope.revision;
  dirty = false;
  render();
  void syncWakeLock();
});

settingsDialog.addEventListener('close', () => settingsButton.focus());

colorScheme.addEventListener('change', () => {
  if (state.preferences.theme === 'system') syncThemeColor();
});

window.addEventListener('load', () => {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./service-worker.js').catch(() => {});
  }
});

render();
void syncWakeLock();
window.setInterval(renderElapsed, 1000);
