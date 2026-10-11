import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

async function keyboardHarness() {
  const source = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const start = source.indexOf("document.addEventListener('keydown'");
  const end = source.indexOf("document.addEventListener('visibilitychange'", start);
  assert.ok(start >= 0 && end > start);
  let handler;
  const actions = [];
  const settingsDialog = { open: false };
  runInNewContext(source.slice(start, end), {
    document: { addEventListener(type, callback) { handler = callback; } },
    settingsDialog,
    resetConfirmation: { hidden: true },
    undoButton: { disabled: false, click() { actions.push('undo'); } },
    advanceCounter() { actions.push('advance'); },
    openResetConfirmation() { actions.push('reset'); },
    closeResetConfirmation() { actions.push('cancel'); },
  });
  return {
    actions, settingsDialog,
    dispatch(key, flags = {}) {
      let prevented = false;
      handler({ key, target: { closest() { return null; } },
        preventDefault() { prevented = true; }, ...flags });
      return prevented;
    },
  };
}

test('modified and composition keys never trigger counter shortcuts or suppress browser commands', async () => {
  const app = await keyboardHarness();
  for (const open of [false, true]) {
    app.settingsDialog.open = open;
    for (const flag of ['ctrlKey', 'metaKey', 'altKey', 'isComposing']) {
      for (const key of ['r', 'R', 'Enter', ' ', '-', 'Backspace']) {
        assert.equal(app.dispatch(key, { [flag]: true }), false, `${flag} ${key}`);
        assert.deepEqual(app.actions, []);
      }
    }
  }
});

test('ordinary unmodified counter shortcuts continue to work', async () => {
  const app = await keyboardHarness();
  for (const key of [' ', 'Enter', '-', 'Backspace', 'r']) {
    assert.equal(app.dispatch(key), true);
  }
  assert.deepEqual(app.actions, ['advance', 'advance', 'undo', 'undo', 'reset']);
});
