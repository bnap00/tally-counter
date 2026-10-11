import { normalizeState } from './counter.js';

// App-only display preferences stay independent of counter transitions.
export function normalizeAppState(input, theme = input?.preferences?.theme) {
  const state = normalizeState(input);
  if (['system', 'light', 'dark', 'black'].includes(theme)) state.preferences.theme = theme;
  return state;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseStoredEnvelope(stored) {
  if (typeof stored !== 'string') return null;

  try {
    const parsed = JSON.parse(stored);
    if (!isRecord(parsed)) return null;

    const looksLikeEnvelope = Object.hasOwn(parsed, 'revision') || Object.hasOwn(parsed, 'state');
    if (!looksLikeEnvelope) return { revision: 0, state: parsed };
    if (!Number.isSafeInteger(parsed.revision) || parsed.revision < 0 || !isRecord(parsed.state)) {
      return null;
    }
    return { revision: parsed.revision, state: parsed.state };
  } catch {
    return null;
  }
}

export function newerStoredEnvelope(stored, currentRevision) {
  const envelope = parseStoredEnvelope(stored);
  return envelope !== null && envelope.revision > currentRevision ? envelope : null;
}

export function nextStoredEnvelope(state, currentRevision) {
  return { revision: currentRevision + 1, state };
}

export function runWithExclusiveLock(locks, name, callback) {
  if (typeof locks?.request !== 'function') return callback();
  return locks.request(name, { mode: 'exclusive' }, callback);
}
