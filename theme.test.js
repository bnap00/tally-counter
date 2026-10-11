import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import * as counter from './counter.js';
import * as persistence from './persistence.js';

const source = (name) => readFile(new URL(name, import.meta.url), 'utf8');

async function loadApp(storage = new Map(), dark = false) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, {
      value: '', dataset: {}, style: { setProperty() {} },
      classList: { toggle() {}, add() {}, remove() {} },
      listeners: new Map(), setAttribute() {}, querySelectorAll: () => [],
      addEventListener(type, listener) { this.listeners.set(type, listener); },
      focus() {}, showModal() { this.open = true; }, close() { this.open = false; },
    });
    return elements.get(id);
  };
  const media = {
    matches: dark, listeners: new Map(),
    addEventListener(type, listener) { this.listeners.set(type, listener); },
  };
  const windowListeners = new Map();
  const document = {
    documentElement: { dataset: {} }, visibilityState: 'visible',
    querySelector: element, addEventListener() {},
  };
  const js = (await source('app.js')).replace(/import\s*\{[\s\S]*?\}\s*from\s*['"][^'"]+['"];?/g, '');
  runInNewContext(js, {
    ...counter, ...persistence, document, navigator: {}, Intl, Date,
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
    requestAnimationFrame: (callback) => callback(),
    window: {
      matchMedia: () => media, setInterval() {}, setTimeout() {}, clearTimeout() {},
      addEventListener: (type, listener) => windowListeners.set(type, listener),
    },
  });
  return {
    elements, document, media, windowListeners,
    change(id, value) {
      element(id).value = value;
      element(id).listeners.get('change')();
    },
    click(id) { element(id).listeners.get('click')(); },
  };
}

test('manual black theme persists through counting and reload regardless of system preference', async () => {
  const storage = new Map();
  const app = await loadApp(storage);
  assert.equal(app.document.documentElement.dataset.theme, 'system');
  app.change('#theme', 'black');
  assert.equal(app.document.documentElement.dataset.theme, 'black');
  assert.equal(app.elements.get('#theme-color').content, '#000000');
  app.click('#counter-button');
  assert.equal(app.document.documentElement.dataset.theme, 'black');
  assert.equal(JSON.parse(storage.get('tally-state-v1')).state.preferences.theme, 'black');
  for (const mode of ['target', 'auto', 'nested', 'countdown', 'endless']) {
    app.change('#mode', mode);
    app.click('#counter-button');
    app.click('#undo-button');
    app.click('#confirm-reset-button');
    app.elements.get('#animation').checked = false;
    app.elements.get('#animation').listeners.get('change')();
    assert.equal(app.document.documentElement.dataset.theme, 'black', mode);
  }
  const reloaded = await loadApp(storage, true);
  assert.equal(reloaded.document.documentElement.dataset.theme, 'black');
  assert.equal(reloaded.elements.get('#theme').value, 'black');
  reloaded.media.matches = false;
  reloaded.media.listeners.get('change')();
  assert.equal(reloaded.elements.get('#theme-color').content, '#000000');
  for (const theme of ['light', 'dark', 'system']) {
    reloaded.change('#theme', theme);
    assert.equal(reloaded.document.documentElement.dataset.theme, theme);
    assert.equal(reloaded.elements.get('#theme-color').content, theme === 'dark' ? '#1d1c1a' : '#eee9df');
  }
});
