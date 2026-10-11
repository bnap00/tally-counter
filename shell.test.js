import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { inflateSync } from 'node:zlib';

const requiredFiles = ['index.html', 'style.css', 'app.js'];

async function source(file) {
  return readFile(new URL(file, import.meta.url), 'utf8');
}

async function binary(file) {
  return readFile(new URL(file, import.meta.url));
}

function pngDimensions(buffer) {
  assert.deepEqual(
    buffer.subarray(0, 8),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    'missing PNG signature',
  );
  assert.equal(buffer.subarray(12, 16).toString('ascii'), 'IHDR', 'missing PNG IHDR');
  return [buffer.readUInt32BE(16), buffer.readUInt32BE(20)];
}

function decodeRgbaPng(buffer) {
  const [width, height] = pngDimensions(buffer);
  const idat = [];
  let bitDepth;
  let colorType;

  for (let offset = 8; offset < buffer.length;) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      bitDepth = data[8];
      colorType = data[9];
    }
    if (type === 'IDAT') idat.push(data);
    offset += length + 12;
    if (type === 'IEND') break;
  }

  assert.equal(bitDepth, 8, 'maskable PNG must use 8-bit channels');
  assert.ok(colorType === 2 || colorType === 6, 'maskable PNG must use RGB or RGBA pixels');

  const packed = inflateSync(Buffer.concat(idat));
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const decoded = Buffer.alloc(stride * height);
  const paeth = (left, above, upperLeft) => {
    const estimate = left + above - upperLeft;
    const leftDistance = Math.abs(estimate - left);
    const aboveDistance = Math.abs(estimate - above);
    const upperLeftDistance = Math.abs(estimate - upperLeft);
    if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
    return aboveDistance <= upperLeftDistance ? above : upperLeft;
  };

  for (let y = 0; y < height; y += 1) {
    const filter = packed[y * (stride + 1)];
    for (let x = 0; x < stride; x += 1) {
      const packedValue = packed[y * (stride + 1) + x + 1];
      const output = y * stride + x;
      const left = x >= channels ? decoded[output - channels] : 0;
      const above = y > 0 ? decoded[output - stride] : 0;
      const upperLeft = y > 0 && x >= channels ? decoded[output - stride - channels] : 0;
      const predictor = [
        0,
        left,
        above,
        Math.floor((left + above) / 2),
        paeth(left, above, upperLeft),
      ][filter];
      assert.notEqual(predictor, undefined, `unsupported PNG filter ${filter}`);
      decoded[output] = (packedValue + predictor) & 0xff;
    }
  }

  if (channels === 4) return { width, height, pixels: decoded };

  const pixels = Buffer.alloc(width * height * 4);
  for (let source = 0, target = 0; source < decoded.length; source += 3, target += 4) {
    decoded.copy(pixels, target, source, source + 3);
    pixels[target + 3] = 255;
  }
  return { width, height, pixels };
}

function createWorkerHarness(worker, options = {}) {
  const origin = 'https://tally.test/';
  const listeners = new Map();
  const stores = new Map();
  const fetchCalls = [];
  let claimed = false;

  const cacheKey = (request) => new URL(
    typeof request === 'string' ? request : request.url,
    origin,
  ).href;
  const createCache = (entries = []) => {
    const responses = new Map(entries.map(([request, response]) => [cacheKey(request), response]));
    return {
      addAll: async (assets) => {
        for (const asset of assets) {
          responses.set(cacheKey(asset), new Response(`precache:${asset}`));
        }
      },
      match: async (request) => responses.get(cacheKey(request))?.clone(),
      put: async (request, response) => responses.set(cacheKey(request), response.clone()),
    };
  };

  for (const [name, entries] of Object.entries(options.initialCaches ?? {})) {
    stores.set(name, createCache(entries));
  }

  runInNewContext(worker, {
    AbortController,
    URL,
    Response,
    caches: {
      delete: async (cacheName) => stores.delete(cacheName),
      keys: async () => [...stores.keys()],
      open: async (cacheName) => {
        if (!stores.has(cacheName)) stores.set(cacheName, createCache());
        return stores.get(cacheName);
      },
    },
    clearTimeout: options.clearTimeout ?? clearTimeout,
    fetch: (request, init) => {
      fetchCalls.push({ request, init });
      return options.fetch?.(request, init) ?? Promise.resolve(new Response('network'));
    },
    self: {
      addEventListener: (type, listener) => listeners.set(type, listener),
      clients: { claim: async () => { claimed = true; } },
      location: new URL(`${origin}service-worker.js`),
    },
    setTimeout: options.setTimeout ?? setTimeout,
  });

  return {
    async install() {
      let lifetime;
      listeners.get('install')({ waitUntil: (promise) => { lifetime = promise; } });
      await lifetime;
    },
    async activate() {
      let lifetime;
      listeners.get('activate')({ waitUntil: (promise) => { lifetime = promise; } });
      await lifetime;
    },
    async cachedText(cacheName, request) {
      const response = await stores.get(cacheName)?.match(request);
      return response?.text();
    },
    dispatchFetch(request) {
      let response;
      let responded = false;
      listeners.get('fetch')({
        request,
        respondWith: (promise) => {
          responded = true;
          response = Promise.resolve(promise);
        },
      });
      return { get responded() { return responded; }, get response() { return response; } };
    },
    fetchCalls,
    get claimed() { return claimed; },
    stores,
  };
}

function rgbVariable(css, selector, name) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const block = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 's'))?.[1] ?? '';
  const value = block.match(new RegExp(`--${name}:\\s*rgb\\((\\d+)\\s+(\\d+)\\s+(\\d+)\\)`));
  assert.ok(value, `missing --${name} RGB value in ${selector}`);
  return value.slice(1).map(Number);
}

function contrastRatio(first, second) {
  const luminance = (rgb) => rgb
    .map((channel) => channel / 255)
    .map((channel) => channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4)
    .reduce((total, channel, index) => total + channel * [0.2126, 0.7152, 0.0722][index], 0);
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test('provides the complete dependency-free application shell', async () => {
  const [html, css, js] = await Promise.all(requiredFiles.map(source));

  for (const id of [
    'app',
    'mode-status',
    'counter-button',
    'current-value',
    'target-status',
    'target-value',
    'cycle-status',
    'settings-button',
    'undo-button',
    'reset-button',
    'reset-confirmation',
    'confirm-reset-button',
    'cancel-reset-button',
    'settings-dialog',
    'settings-form',
    'close-settings-button',
    'mode',
    'primary-target',
    'secondary-target',
    'step',
    'theme',
    'tap-vibration',
    'target-vibration',
    'animation',
    'keep-awake',
    'preset-targets',
    'session-total',
    'elapsed-time',
    'live-status',
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  }

  assert.match(html, /<main\b[^>]*id=["']app["']/i);
  assert.match(html, /<button\b[^>]*id=["']counter-button["'][^>]*aria-label=/i);
  assert.match(html, /<dialog\b[^>]*id=["']settings-dialog["']/i);
  assert.match(html, /id=["']reset-confirmation["'][^>]*role=["']group["']/i);
  assert.match(html, /id=["']live-status["'][^>]*aria-live=["']polite["']/i);
  assert.match(html, /<link\b[^>]*rel=["']manifest["'][^>]*href=["']\.\/manifest\.webmanifest["']/i);
  assert.match(html, /<link\b[^>]*rel=["']stylesheet["'][^>]*href=["']\.\/style\.css["']/i);
  assert.match(html, /<script\b[^>]*type=["']module["'][^>]*src=["']\.\/app\.js["']/i);
  assert.match(html, /name=["']viewport["']/i);
  assert.match(html, /name=["']theme-color["']/i);
  assert.match(html, /aria-keyshortcuts=["'][^"']*(Enter|Space)/i);

  for (const control of ['mode', 'primary-target', 'secondary-target', 'step', 'theme']) {
    assert.match(html, new RegExp(`<label\\b[^>]*for=["']${control}["']`, 'i'));
  }
  for (const preset of ['10', '25', '50', '100', '500', '1000']) {
    assert.match(html, new RegExp(`data-target=["']${preset}["']`));
  }

  assert.match(js, /from\s+["']\.\/counter\.js["']/);
  for (const engineExport of [
    'advance',
    'createState',
    'normalizeAppState',
    'reset',
    'setMode',
    'setPrimaryTarget',
    'setSecondaryTarget',
    'setStep',
    'undo',
    'updatePreferences',
  ]) {
    assert.match(js, new RegExp(`\\b${engineExport}\\b`), `app.js must use ${engineExport}`);
  }
  assert.match(js, /tally-state-v1/);
  assert.match(js, /Intl\.NumberFormat/);
  assert.match(js, /localStorage/);
  assert.match(js, /visibilitychange/);
  assert.match(js, /serviceWorker\.register\(["']\.\/service-worker\.js["']\)/);
  assert.match(js, /navigator\.wakeLock/);
  assert.match(js, /navigator\.vibrate/);
  assert.match(js, /document\.documentElement\.dataset\.theme/);

  assert.match(css, /100dvh/);
  assert.match(css, /env\(safe-area-inset-(top|right|bottom|left)/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /prefers-color-scheme:\s*dark/);
  assert.match(css, /html\[data-theme=["']light["']\]/);
  assert.match(css, /html\[data-theme=["']dark["']\]/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /font-variant-numeric:\s*tabular-nums/);
  assert.match(css, /--progress/);

  assert.doesNotMatch(css, /gradient\s*\(/i);
  assert.doesNotMatch(css, /purple|violet|#[a-f\d]{0,2}(?:0[0-9a-f]|[1-9a-f][0-9a-f])(?:8[0-9a-f]|9[0-9a-f]|a[0-9a-f]|b[0-9a-f]|c[0-9a-f]|d[0-9a-f]|e[0-9a-f]|f[0-9a-f])/i);
  assert.doesNotMatch(html, /https?:\/\//i);
  assert.doesNotMatch(html, /\b(react|vue|angular|svelte|jquery|bootstrap|tailwind)\b/i);
  assert.doesNotMatch(html, /<script\b(?![^>]*src=["']\.\/app\.js["'])/i);
});

test('lets Escape close reset confirmation when its buttons have focus', async () => {
  const js = await source('app.js');
  const escapeHandler = js.indexOf("event.key === 'Escape'");
  const formControlGuard = js.indexOf("const inControl =");

  assert.notEqual(escapeHandler, -1, 'missing Escape handling');
  assert.notEqual(formControlGuard, -1, 'missing form-control shortcut guard');
  assert.ok(
    escapeHandler < formControlGuard,
    'Escape handling must run before focused form controls skip global shortcuts',
  );
});

test('coordinates versioned cross-tab storage without stale or redundant writes', async () => {
  const js = await source('app.js');
  const commitBlock = js.slice(js.indexOf('function commit('), js.indexOf('function advanceOutcome'));

  assert.match(js, /from ['"]\.\/persistence\.js['"]/);
  assert.match(js, /runWithExclusiveLock/);
  assert.match(js, /let revision\s*=/);
  assert.match(js, /let dirty\s*=\s*false/);
  assert.match(js, /function refreshFromStorage\(\)/);
  assert.match(commitBlock, /runWithExclusiveLock\(navigator\.locks,\s*STORAGE_KEY/);
  assert.match(js, /newerStoredEnvelope\(localStorage\.getItem\(STORAGE_KEY\),\s*revision\)/);
  assert.ok(commitBlock.indexOf('refreshFromStorage()') < commitBlock.indexOf('transition(before)'));
  assert.match(js, /nextStoredEnvelope\(state,\s*revision\)/);
  assert.match(js, /window\.addEventListener\(['"]storage['"]/);
  assert.match(js, /newerStoredEnvelope\(event\.newValue,\s*revision\)/);
  assert.match(js, /document\.visibilityState\s*===\s*['"]hidden['"]\s*&&\s*dirty/);
  assert.doesNotMatch(js, /localStorage\.setItem\(STORAGE_KEY,\s*JSON\.stringify\(state\)\)/);
});

test('isolates global shortcuts while the native settings dialog is open', async () => {
  const js = await source('app.js');
  const settingsHandler = js.slice(
    js.indexOf("settingsButton.addEventListener('click'"),
    js.indexOf("closeSettingsButton.addEventListener('click'"),
  );
  const keyHandler = js.slice(
    js.indexOf("document.addEventListener('keydown'"),
    js.indexOf("document.addEventListener('visibilitychange'"),
  );

  assert.ok(settingsHandler.indexOf('closeResetConfirmation()') < settingsHandler.indexOf('settingsDialog.showModal()'));
  assert.match(keyHandler, /const globalShortcut\s*=/);
  assert.match(keyHandler, /if\s*\(settingsDialog\.open\)\s*\{[\s\S]*?const inDialogControl\s*=[\s\S]*?if\s*\(!inDialogControl\s*&&\s*globalShortcut\)\s*event\.preventDefault\(\)[\s\S]*?return/s);
  assert.ok(keyHandler.indexOf('settingsDialog.open') < keyHandler.indexOf("event.key === 'Escape'"));
});

test('scales long formatted values to remain visible on small screens', async () => {
  const [css, js] = await Promise.all([source('style.css'), source('app.js')]);

  assert.match(js, /currentValue\.classList\.toggle\(['"]value-long['"]/);
  assert.match(js, /currentValue\.classList\.toggle\(['"]value-very-long['"]/);
  assert.match(css, /#current-value\.value-long\s*\{/);
  assert.match(css, /#current-value\.value-very-long\s*\{/);
  assert.match(css, /\.session-readings strong\s*\{[^}]*overflow-wrap:\s*anywhere/s);
});

test('makes the full central stage clickable while keeping the instrument restrained', async () => {
  const [html, css] = await Promise.all([source('index.html'), source('style.css')]);
  const stage = html.match(/<section\b[^>]*class=["']counter-stage["'][^>]*>([\s\S]*?)<\/section>/i)?.[1] ?? '';

  assert.match(stage, /<button\b[^>]*id=["']counter-button["']/i);
  assert.ok(stage.indexOf('</button>') < stage.indexOf('id="target-status"'));
  assert.match(css, /\.counter-stage\s*\{[^}]*--instrument-size:/s);
  assert.match(css, /#counter-button\s*\{[^}]*width:\s*100%[^}]*height:\s*100dvh/s);
  assert.match(css, /\.progress-ring\s*\{[^}]*width:\s*var\(--instrument-size\)[^}]*height:\s*var\(--instrument-size\)/s);
  assert.match(css, /\.edge-reading,\s*\.cycle-status\s*\{[^}]*pointer-events:\s*none/s);
});

test('uses the counter as a viewport interaction layer behind pointer-transparent chrome', async () => {
  const css = await source('style.css');
  const controlRouting = css.match(/\.edge-bar button,\s*\.lower-deck button,\s*\.reset-confirmation\s*\{([^}]*)\}/s)?.[1] ?? '';

  assert.match(css, /#counter-button\s*\{[^}]*position:\s*fixed[^}]*inset:\s*0[^}]*width:\s*100%[^}]*height:\s*100dvh[^}]*z-index:\s*0/s);
  assert.match(css, /\.counter-stage\s*\{[^}]*pointer-events:\s*none/s);
  assert.match(css, /\.edge-bar,\s*\.lower-deck\s*\{[^}]*pointer-events:\s*none/s);
  assert.match(controlRouting, /pointer-events:\s*auto/);
  assert.match(controlRouting, /z-index:\s*3/);
  assert.match(css, /dialog\s*\{[^}]*pointer-events:\s*auto/s);
});

test('fits every safe-integer digit at the 280px minimum viewport', async () => {
  const css = await source('style.css');
  const veryLongBlocks = [...css.matchAll(/#current-value\.value-very-long\s*\{([^}]*)\}/g)];

  assert.match(css, /min-width:\s*280px/);
  assert.match(css, /--value-padding:\s*clamp\(0\.625rem,\s*3vmin,\s*2rem\)/);
  assert.match(css, /\.value-wrap\s*\{[^}]*padding:\s*var\(--value-padding\)/s);
  assert.ok(veryLongBlocks.length >= 1, 'missing very-long number sizing');
  assert.match(veryLongBlocks[0][1], /font-size:\s*min\(calc\(var\(--instrument-size\)\s*\/\s*13\),\s*3rem\)/);
  assert.match(veryLongBlocks[0][1], /max-width:\s*none/);
  assert.match(veryLongBlocks[0][1], /overflow:\s*visible/);
  assert.match(veryLongBlocks[0][1], /font-variant-numeric:\s*tabular-nums/);
});

test('contains every settings control at 280px and 320px', async () => {
  const css = await source('style.css');
  const sizing = css.match(/dialog,\s*#settings-form\s*\{([^}]*)\}/s)?.[1] ?? '';
  const form = [...css.matchAll(/#settings-form\s*\{([^}]*)\}/gs)]
    .map((match) => match[1])
    .find((block) => /overflow-y:\s*auto/.test(block)) ?? '';
  const narrowStart = css.indexOf('@media (max-width: 320px)');
  const nextMediaStart = css.indexOf('@media ', narrowStart + 1);
  const narrow = narrowStart === -1
    ? ''
    : css.slice(narrowStart, nextMediaStart === -1 ? css.length : nextMediaStart);

  assert.match(sizing, /box-sizing:\s*border-box/);
  assert.match(sizing, /min-width:\s*0/);
  assert.match(sizing, /max-width:\s*100%/);
  assert.match(form, /overflow-x:\s*hidden/);
  assert.match(narrow, /\.settings-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)[^}]*min-width:\s*0/s);
  assert.match(narrow, /\.settings-grid\s*>\s*\*\s*\{[^}]*min-width:\s*0[^}]*max-width:\s*100%/s);
  assert.match(narrow, /\.presets\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(narrow, /\.field-row\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
  assert.match(narrow, /\.switches\s*\{[^}]*min-width:\s*0[^}]*max-width:\s*100%/s);
});

test('keeps landscape safe-integer visuals inside the center grid track', async () => {
  const css = await source('style.css');
  const landscapeStart = css.indexOf('@media (orientation: landscape) and (min-width: 640px) and (max-height: 540px)');
  const nextMediaStart = css.indexOf('@media ', landscapeStart + 1);
  const landscape = landscapeStart === -1
    ? ''
    : css.slice(landscapeStart, nextMediaStart === -1 ? css.length : nextMediaStart);

  assert.match(css, /#counter-button\s*\{[^}]*position:\s*fixed[^}]*inset:\s*0/s);
  assert.match(landscape, /#app,\s*#counter-button\s*\{[^}]*grid-template-columns:\s*minmax\(8rem,\s*0\.7fr\)\s*minmax\(0,\s*1\.8fr\)\s*minmax\(10rem,\s*0\.8fr\)[^}]*gap:\s*1rem/s);
  assert.match(landscape, /#counter-button\s*\{[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\)[^}]*padding:\s*1rem/s);
  assert.match(landscape, /\.counter-stage\s*\{[^}]*container-type:\s*inline-size[^}]*--instrument-size:\s*min\(100cqi,\s*82dvh,\s*30rem\)/s);
  assert.match(landscape, /\.progress-ring\s*\{[^}]*position:\s*static[^}]*grid-column:\s*2[^}]*grid-row:\s*1/s);
  assert.match(landscape, /\.value-wrap\s*\{[^}]*grid-column:\s*2[^}]*grid-row:\s*1/s);
  assert.match(landscape, /#current-value\.value-very-long\s*\{[^}]*font-size:\s*min\(calc\(var\(--instrument-size\)\s*\/\s*16\),\s*2rem\)/s);
});

test('uses a non-collapsing compact landscape below 640px', async () => {
  const css = await source('style.css');
  const compactStart = css.indexOf('@media (orientation: landscape) and (max-width: 639px) and (max-height: 540px)');
  const nextMediaStart = css.indexOf('@media ', compactStart + 1);
  const compact = compactStart === -1
    ? ''
    : css.slice(compactStart, nextMediaStart === -1 ? css.length : nextMediaStart);

  assert.match(compact, /#app,\s*#counter-button\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)[^}]*grid-template-rows:\s*2\.5rem\s*minmax\(0,\s*1fr\)\s*5\.5rem[^}]*gap:\s*0\.5rem[^}]*padding:\s*0\.5rem/s);
  assert.match(compact, /\.counter-stage\s*\{[^}]*container-type:\s*inline-size[^}]*--instrument-size:\s*min\(38vw,\s*42dvh,\s*8rem\)/s);
  assert.match(compact, /\.progress-ring\s*\{[^}]*position:\s*static[^}]*grid-column:\s*1[^}]*grid-row:\s*2/s);
  assert.match(compact, /\.value-wrap\s*\{[^}]*grid-column:\s*1[^}]*grid-row:\s*2/s);
  assert.match(compact, /#current-value\.value-very-long\s*\{[^}]*font-size:\s*min\(calc\(var\(--instrument-size\)\s*\/\s*14\),\s*0\.75rem\)/s);
  assert.match(compact, /\.edge-bar\s*\{[^}]*grid-template-columns:\s*3rem\s*minmax\(0,\s*1fr\)\s*3rem[^}]*min-height:\s*2\.5rem/s);
  assert.match(compact, /\.lower-deck\s*\{[^}]*min-height:\s*5\.5rem[^}]*max-width:\s*100%/s);
  assert.match(compact, /\.session-readings,\s*\.secondary-actions\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(compact, /#settings-button,\s*\.secondary-actions button\s*\{[^}]*pointer-events:\s*auto/s);
});

test('keeps exact maximum footer values and reset confirmation within 280px', async () => {
  const css = await source('style.css');
  const footer = [...css.matchAll(/\.lower-deck\s*\{([^}]*)\}/gs)]
    .map((match) => match[1])
    .find((block) => /display:\s*grid/.test(block)) ?? '';
  const footerRows = css.match(/\.session-readings,\s*\.secondary-actions\s*\{([^}]*)\}/s)?.[1] ?? '';
  const actionButtons = css.match(/\.secondary-actions \.text-button\s*\{([^}]*)\}/s)?.[1] ?? '';
  const tinyWidthStart = css.indexOf('@media (max-width: 320px)');
  const nextMediaStart = css.indexOf('@media ', tinyWidthStart + 1);
  const tinyWidth = tinyWidthStart === -1
    ? ''
    : css.slice(tinyWidthStart, nextMediaStart === -1 ? css.length : nextMediaStart);

  assert.match(footer, /min-width:\s*0/);
  assert.match(footer, /max-width:\s*100%/);
  assert.match(footerRows, /display:\s*grid/);
  assert.match(footerRows, /grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(actionButtons, /min-width:\s*0/);
  assert.match(actionButtons, /max-width:\s*100%/);
  assert.match(actionButtons, /overflow-wrap:\s*anywhere/);
  assert.match(actionButtons, /white-space:\s*normal/);
  assert.match(tinyWidth, /\.session-readings p\s*\{[^}]*display:\s*grid/s);
  assert.match(tinyWidth, /\.reset-confirmation\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)[^}]*max-width:\s*100%/s);
  assert.match(tinyWidth, /\.reset-confirmation button\s*\{[^}]*min-width:\s*0[^}]*max-width:\s*100%/s);
});

test('coerces target and step form values before engine setters', async () => {
  const js = await source('app.js');

  assert.match(js, /function formInteger\(control\)/);
  assert.match(js, /Number\.isFinite\(value\)[\s\S]*?value\s*>=\s*1[\s\S]*?:\s*1/);
  assert.match(js, /primaryTargetControl\.addEventListener\(['"]change['"][\s\S]*?const target = formInteger\(primaryTargetControl\)[\s\S]*?setPrimaryTarget\(current,\s*target\)/);
  assert.match(js, /secondaryTargetControl\.addEventListener\(['"]change['"][\s\S]*?const target = formInteger\(secondaryTargetControl\)[\s\S]*?setSecondaryTarget\(current,\s*target\)/);
  assert.match(js, /stepControl\.addEventListener\(['"]change['"][\s\S]*?const step = formInteger\(stepControl\)[\s\S]*?setStep\(current,\s*step\)/);
});

test('black AMOLED is an explicit choice with pure black surfaces and accessible foregrounds', async () => {
  const [html, css] = await Promise.all([source('index.html'), source('style.css')]);
  assert.match(html, /<option value="black">Black \(AMOLED\)<\/option>/);
  const selector = 'html[data-theme="black"]';
  for (const name of ['paper', 'paper-raised', 'accent-soft', 'on-accent']) {
    assert.deepEqual(rgbVariable(css, selector, name), [0, 0, 0]);
  }
  const black = [0, 0, 0];
  for (const name of ['ink', 'muted', 'completion', 'accent']) {
    assert.ok(contrastRatio(rgbVariable(css, selector, name), black) >= 4.5, name);
  }
  assert.ok(contrastRatio(rgbVariable(css, selector, 'focus'), black) >= 3);
  assert.match(css, /html\[data-theme="black"\]\s*\{[^}]*color-scheme:\s*dark/s);
  assert.match(css, /html\[data-theme="black"\] #confirm-reset-button\s*\{[^}]*background:\s*var\(--paper\)[^}]*color:\s*var\(--ink\)/s);
  assert.match(css, /html\[data-theme="black"\] button:active\s*\{[^}]*background:\s*var\(--paper\)/s);
  assert.match(css, /html\[data-theme="black"\] dialog::backdrop\s*\{[^}]*background:\s*rgb\(0 0 0 \/ 0\.58\)/s);
  const systemBlock = css.match(/@media \(prefers-color-scheme: dark\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.doesNotMatch(systemBlock, /data-theme="black"/);
});

test('completion and reset colors meet WCAG AA in both themes', async () => {
  const css = await source('style.css');

  for (const selector of ['html[data-theme="light"]', 'html[data-theme="dark"]']) {
    const paper = rgbVariable(css, selector, 'paper');
    const ink = rgbVariable(css, selector, 'ink');
    const completion = rgbVariable(css, selector, 'completion');
    const accent = rgbVariable(css, selector, 'accent');
    const accentSoft = rgbVariable(css, selector, 'accent-soft');
    const onAccent = rgbVariable(css, selector, 'on-accent');

    assert.ok(contrastRatio(completion, paper) >= 4.5, `${selector} completion contrast`);
    assert.ok(contrastRatio(ink, accentSoft) >= 4.5, `${selector} reset contrast`);
    assert.ok(contrastRatio(onAccent, accent) >= 4.5, `${selector} confirm contrast`);
  }

  assert.match(css, /#app\[data-complete=["']true["']\][^}]*var\(--completion\)/s);
  assert.match(css, /#confirm-reset-button\s*\{[^}]*color:\s*var\(--on-accent\)/s);
});

test('serializes wake-lock requests and recovers from release races', async () => {
  const js = await source('app.js');
  const requestIndex = js.indexOf("navigator.wakeLock.request('screen')");
  const postRequest = js.slice(requestIndex, requestIndex + 1400);

  assert.match(js, /let wakeLockRequest = null/);
  assert.match(js, /let wakeLockRequestToken = 0/);
  assert.match(js, /function shouldKeepWakeLock\(\)/);
  assert.match(postRequest, /shouldKeepWakeLock\(\)/);
  assert.match(postRequest, /\.release\(\)/);
  assert.match(postRequest, /addEventListener\(['"]release['"][\s\S]*?syncWakeLock\(\)/);
});

test('drives feedback from advance outcomes and suppresses stopped taps', async () => {
  const js = await source('app.js');
  const outcomeBlock = js.slice(
    js.indexOf('function advanceOutcome'),
    js.indexOf('function advanceCounter'),
  );

  assert.match(js, /function advanceOutcome\(before, after\)/);
  assert.match(js, /secondaryIncreased/);
  assert.match(js, /autoTargetOneCycle/);
  assert.match(js, /const outcome = advanceOutcome\(before, next\)/);
  assert.match(js, /outcome\.kind === ['"]none['"]/);
  assert.doesNotMatch(outcomeBlock, /after\.pendingReset\s*!==\s*before\.pendingReset/);
  assert.doesNotMatch(js, /function vibrate\(before\)/);
});

test('keeps browser theme color synchronized with the resolved theme', async () => {
  const [html, js] = await Promise.all([source('index.html'), source('app.js')]);

  assert.match(html, /<meta\b[^>]*id=["']theme-color["'][^>]*name=["']theme-color["']/i);
  assert.match(js, /matchMedia\(['"]\(prefers-color-scheme: dark\)['"]\)/);
  assert.match(js, /themeColorMeta\.content\s*=/);
  assert.match(js, /colorScheme\.addEventListener\(['"]change['"]/);
});

test('ships a valid standalone manifest with installable icons', async () => {
  const manifest = JSON.parse(await source('manifest.webmanifest'));

  assert.equal(manifest.name, 'Tally');
  assert.equal(manifest.short_name, 'Tally');
  assert.equal(typeof manifest.description, 'string');
  assert.ok(manifest.description.length > 0 && manifest.description.length <= 80);
  assert.equal(manifest.start_url, './');
  assert.equal(manifest.scope, './');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.orientation, 'any');
  assert.equal(manifest.background_color, '#eee9df');
  assert.equal(manifest.theme_color, '#242320');

  assert.ok(Array.isArray(manifest.icons));
  assert.deepEqual(
    manifest.icons.map(({ src, sizes, type, purpose }) => ({ src, sizes, type, purpose })),
    [
      { src: './icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: './icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: './icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: './icons/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: './icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  );
});

test('precache worker lists the complete dependency-free v10 shell', async () => {
  const worker = await source('service-worker.js');
  const expectedAssets = [
    './',
    './index.html',
    './style.css',
    './counter.js',
    './persistence.js',
    './app.js',
    './manifest.webmanifest',
    './icons/icon.svg',
    './icons/icon-192.png',
    './icons/icon-512.png',
    './icons/icon-maskable.svg',
    './icons/icon-maskable-192.png',
    './icons/icon-maskable-512.png',
  ];

  assert.match(worker, /const CACHE_PREFIX\s*=\s*['"]tally-/);
  assert.match(worker, /const CACHE_NAME\s*=\s*`\$\{CACHE_PREFIX\}v10`/);
  for (const asset of expectedAssets) {
    assert.ok(worker.includes(`'${asset}'`) || worker.includes(`"${asset}"`), `missing ${asset}`);
  }
  assert.match(worker, /addEventListener\(['"]install['"]/);
  assert.match(worker, /cache\.addAll\(/);
  assert.doesNotMatch(worker, /skipWaiting\s*\(/, 'updates must wait for existing tabs to close');
  assert.doesNotMatch(worker, /workbox|importScripts\s*\(/i);
  const harness = createWorkerHarness(worker);
  await harness.install();
  for (const asset of expectedAssets) {
    assert.equal(await harness.cachedText('tally-shell-v10', asset), `precache:${asset}`);
  }
});

test('worker ignores cross-origin, non-GET, and same-origin unlisted requests', async () => {
  const worker = await source('service-worker.js');
  const harness = createWorkerHarness(worker);
  const requests = [
    { method: 'GET', mode: 'cors', url: 'https://tally.test/README.md' },
    { method: 'GET', mode: 'cors', url: 'https://tally.test/api/counters' },
    { method: 'GET', mode: 'cors', url: 'https://tally.test/private' },
    { method: 'POST', mode: 'cors', url: 'https://tally.test/style.css' },
    { method: 'GET', mode: 'cors', url: 'https://cdn.example/style.css' },
  ];
  const events = requests.map((request) => harness.dispatchFetch(request));

  await Promise.all(events.filter((event) => event.responded).map((event) => event.response));
  assert.ok(events.every((event) => !event.responded), 'ignored requests must not call respondWith');
  assert.equal(harness.fetchCalls.length, 0, 'ignored requests must not reach fetch');
  assert.equal(harness.stores.size, 0, 'ignored requests must not open or populate caches');
});

test('non-app navigations are not intercepted and cannot replace cached index', async () => {
  const worker = await source('service-worker.js');
  const harness = createWorkerHarness(worker, {
    initialCaches: {
      'tally-shell-v10': [['./index.html', new Response('known app index')]],
    },
    fetch: async (request) => new Response(`route:${new URL(request.url).pathname}`),
  });
  const requests = [
    { method: 'GET', mode: 'navigate', url: 'https://tally.test/README.md' },
    { method: 'GET', mode: 'navigate', url: 'https://tally.test/private?source=test' },
    { method: 'GET', mode: 'navigate', url: 'https://tally.test/anything/else' },
  ];
  const events = requests.map((request) => harness.dispatchFetch(request));

  await Promise.all(events.filter((event) => event.responded).map((event) => event.response));
  assert.ok(events.every((event) => !event.responded), 'non-app navigations must not call respondWith');
  assert.equal(harness.fetchCalls.length, 0, 'non-app navigations must bypass worker fetch');
  assert.equal(await harness.cachedText('tally-shell-v10', './index.html'), 'known app index');
});

test('listed static assets remain cache-first', async () => {
  const worker = await source('service-worker.js');
  const harness = createWorkerHarness(worker, {
    initialCaches: {
      'tally-shell-v10': [['./style.css', new Response('cached current stylesheet')]],
    },
    fetch: async () => new Response('network stylesheet'),
  });
  const event = harness.dispatchFetch({
    method: 'GET',
    mode: 'cors',
    url: 'https://tally.test/style.css',
  });

  assert.equal(event.responded, true);
  assert.equal(await (await event.response).text(), 'cached current stylesheet');
  assert.equal(harness.fetchCalls.length, 0);
});

test('old worker serves a coherent cached shell while a new deployment waits', async () => {
  const worker = await source('service-worker.js');
  const harness = createWorkerHarness(worker, {
    initialCaches: {
      'tally-shell-v10': [
        ['./index.html', new Response('old HTML')],
        ['./app.js', new Response('old JS')],
        ['./style.css', new Response('old CSS')],
      ],
      'tally-shell-v11': [['./index.html', new Response('waiting HTML')]],
    },
    fetch: async (request) => new Response(`new deployment:${request.url}`),
  });

  for (const [path, mode, expected] of [
    ['/', 'navigate', 'old HTML'],
    ['/index.html?reload=1', 'navigate', 'old HTML'],
    ['/app.js', 'cors', 'old JS'],
    ['/style.css', 'cors', 'old CSS'],
  ]) {
    const event = harness.dispatchFetch({ method: 'GET', mode, url: `https://tally.test${path}` });
    assert.equal(await (await event.response).text(), expected);
  }
  assert.equal(harness.fetchCalls.length, 0, 'a complete installed shell must not consult the new deployment');
  assert.equal(await harness.cachedText('tally-shell-v10', './index.html'), 'old HTML');
  assert.equal(harness.stores.has('tally-shell-v11'), true, 'waiting cache must remain untouched');
});

test('successful navigation is cache-first and preserves cached index', async () => {
  const worker = await source('service-worker.js');
  const harness = createWorkerHarness(worker, {
    initialCaches: {
      'tally-shell-v10': [['./index.html', new Response('cached index')]],
    },
    fetch: async () => new Response('fresh index'),
  });
  const event = harness.dispatchFetch({
    method: 'GET',
    mode: 'navigate',
    url: 'https://tally.test/',
  });

  assert.equal(await (await event.response).text(), 'cached index');
  assert.equal(await harness.cachedText('tally-shell-v10', './index.html'), 'cached index');
  assert.equal(harness.fetchCalls.length, 0);
});

test('navigation with no cached index uses network without caching arbitrary HTML', async () => {
  const worker = await source('service-worker.js');
  const harness = createWorkerHarness(worker, {
    fetch: async () => new Response('fresh index'),
  });
  const event = harness.dispatchFetch({
    method: 'GET', mode: 'navigate', url: 'https://tally.test/',
  });

  assert.equal(await (await event.response).text(), 'fresh index');
  assert.equal(harness.fetchCalls.length, 1);
  assert.equal(await harness.cachedText('tally-shell-v10', './index.html'), undefined);
});

test('offline navigation serves cached index without fetching', async () => {
  const worker = await source('service-worker.js');
  const harness = createWorkerHarness(worker, {
    initialCaches: {
      'tally-shell-v10': [['./index.html', new Response('cached index')]],
    },
    fetch: async () => Promise.reject(new Error('offline')),
  });
  const event = harness.dispatchFetch({
    method: 'GET',
    mode: 'navigate',
    url: 'https://tally.test/',
  });

  assert.equal(await (await event.response).text(), 'cached index');
});

test('server failure cannot replace an installed cached index', async () => {
  const worker = await source('service-worker.js');
  const harness = createWorkerHarness(worker, {
    initialCaches: {
      'tally-shell-v10': [['./index.html', new Response('cached index')]],
    },
    fetch: async () => new Response('server error', { status: 500 }),
  });
  const event = harness.dispatchFetch({
    method: 'GET',
    mode: 'navigate',
    url: 'https://tally.test/',
  });

  assert.equal(await (await event.response).text(), 'cached index');
  assert.equal(await harness.cachedText('tally-shell-v10', './index.html'), 'cached index');
});

test('query-string app navigations use cached index when offline', async () => {
  const worker = await source('service-worker.js');
  const harness = createWorkerHarness(worker, {
    initialCaches: {
      'tally-shell-v10': [['./index.html', new Response('cached index')]],
    },
    fetch: async () => Promise.reject(new Error('offline')),
  });
  const requests = [
    { method: 'GET', mode: 'navigate', url: 'https://tally.test/?source=test' },
    { method: 'GET', mode: 'navigate', url: 'https://tally.test/index.html?source=test#counter' },
  ];

  for (const request of requests) {
    const event = harness.dispatchFetch(request);
    assert.equal(event.responded, true, `${request.url} must be intercepted`);
    assert.equal(await (await event.response).text(), 'cached index');
  }
});

test('navigation with an empty cache times out and aborts the network request', async () => {
  const worker = await source('service-worker.js');
  let timeoutCallback;
  let clearedTimer;
  const harness = createWorkerHarness(worker, {
    fetch: async () => new Promise(() => {}),
    setTimeout: (callback, delay) => {
      assert.ok(delay >= 2500 && delay <= 3500, `unexpected navigation timeout ${delay}`);
      timeoutCallback = callback;
      return 42;
    },
    clearTimeout: (timer) => { clearedTimer = timer; },
  });
  const event = harness.dispatchFetch({
    method: 'GET',
    mode: 'navigate',
    url: 'https://tally.test/',
  });

  await new Promise(setImmediate);
  assert.ok(timeoutCallback, 'navigation must start a timeout');
  timeoutCallback();
  assert.equal((await event.response).type, 'error');
  assert.equal(clearedTimer, 42, 'navigation timer must be cleared');
  assert.equal(harness.fetchCalls[0].init.signal.aborted, true);
});

test('navigation with an empty cache returns an error for offline or failed network responses', async () => {
  const worker = await source('service-worker.js');
  for (const fetch of [
    async () => { throw new Error('offline'); },
    async () => new Response('server error', { status: 500 }),
  ]) {
    const harness = createWorkerHarness(worker, { fetch });
    const event = harness.dispatchFetch({
      method: 'GET', mode: 'navigate', url: 'https://tally.test/',
    });
    assert.equal((await event.response).type, 'error');
    assert.equal(harness.fetchCalls.length, 1);
    assert.equal(await harness.cachedText('tally-shell-v10', './index.html'), undefined);
  }
});

test('activation removes all prior app caches without deleting unrelated caches', async () => {
  const worker = await source('service-worker.js');
  const initialCaches = {
    'other-app-v1': [['./style.css', new Response('unrelated stylesheet')]],
    'tally-shell-v10': [['./index.html', new Response('current index')]],
  };
  for (let version = 1; version <= 9; version += 1) {
    initialCaches[`tally-shell-v${version}`] = [['./style.css', new Response(`stale v${version}`)]];
  }
  const harness = createWorkerHarness(worker, { initialCaches });

  await harness.activate();

  for (let version = 1; version <= 9; version += 1) {
    assert.equal(harness.stores.has(`tally-shell-v${version}`), false);
  }
  assert.equal(harness.stores.has('other-app-v1'), true);
  assert.equal(await harness.cachedText('tally-shell-v10', './index.html'), 'current index');
  assert.equal(harness.claimed, true);
});

test('includes a padded neutral tally SVG and exact-size PNG icons', async () => {
  const [svg, icon192, icon512] = await Promise.all([
    source('icons/icon.svg'),
    binary('icons/icon-192.png'),
    binary('icons/icon-512.png'),
  ]);

  assert.match(svg, /<svg\b[^>]*viewBox=["']0 0 512 512["']/);
  assert.match(svg, /<rect\b[^>]*x=["']32["'][^>]*y=["']32["'][^>]*width=["']448["'][^>]*height=["']448["'][^>]*rx=["']96["'][^>]*fill=["']#242320["']/);
  assert.equal((svg.match(/<path\b/g) ?? []).length, 4, 'icon must contain four tally paths');
  assert.match(svg, /id=["']increment["']/);
  assert.match(svg, /#eee9df/i);
  assert.deepEqual(pngDimensions(icon192), [192, 192]);
  assert.deepEqual(pngDimensions(icon512), [512, 512]);
});

test('maskable icons are opaque, full-bleed, exact-size, and safe-zone clipped', async () => {
  const [svg, icon192, icon512] = await Promise.all([
    source('icons/icon-maskable.svg'),
    binary('icons/icon-maskable-192.png'),
    binary('icons/icon-maskable-512.png'),
  ]);

  assert.match(svg, /<svg\b[^>]*viewBox=["']0 0 512 512["']/);
  assert.match(svg, /<rect\b[^>]*width=["']512["'][^>]*height=["']512["'][^>]*fill=["']#242320["']/);
  assert.match(svg, /<clipPath\b[^>]*id=["']safe-circle["'][^>]*>\s*<circle\b[^>]*cx=["']256["'][^>]*cy=["']256["'][^>]*r=["']200["']/s);
  assert.match(svg, /<g\b[^>]*id=["']essential-tally["'][^>]*clip-path=["']url\(#safe-circle\)["']/);
  assert.equal((svg.match(/<path\b/g) ?? []).length, 4);

  for (const [buffer, size] of [[icon192, 192], [icon512, 512]]) {
    const image = decodeRgbaPng(buffer);
    assert.deepEqual([image.width, image.height], [size, size]);

    let transparentPixel = -1;
    for (let offset = 3; offset < image.pixels.length; offset += 4) {
      if (image.pixels[offset] !== 255) {
        transparentPixel = offset;
        break;
      }
    }
    assert.equal(transparentPixel, -1, `${size}px maskable icon must be fully opaque`);

    const pixel = (x, y) => [...image.pixels.subarray((y * size + x) * 4, (y * size + x) * 4 + 4)];
    for (const [x, y] of [[0, 0], [size - 1, 0], [0, size - 1], [size - 1, size - 1]]) {
      assert.deepEqual(pixel(x, y), [36, 35, 32, 255], `${size}px icon must bleed to every corner`);
    }
  }
});

test('documents local offline use and includes standard repository metadata', async () => {
  const [readme, license, gitignore] = await Promise.all([
    source('README.md'),
    source('LICENSE'),
    source('.gitignore'),
  ]);

  assert.ok(readme.trimEnd().split('\n').length < 80, 'README must stay under 80 lines');
  assert.match(readme, /offline-first/i);
  assert.match(readme, /python3 -m http\.server 8000/);
  assert.match(readme, /node --test counter\.test\.js persistence\.test\.js shell\.test\.js/);
  assert.match(readme, /local-only|stays on (?:your )?device/i);
  assert.match(readme, /no runtime dependencies/i);
  assert.match(readme, /MIT/);

  assert.match(license, /^MIT License\n/);
  assert.match(license, /Copyright \(c\) 2026/);
  assert.match(license, /Permission is hereby granted, free of charge/);
  assert.match(license, /THE SOFTWARE IS PROVIDED "AS IS"/);

  assert.match(gitignore, /^\.DS_Store$/m);
  assert.match(gitignore, /^coverage\/?$/m);
  assert.match(gitignore, /^\*\.swp$/m);
  assert.match(gitignore, /^\*~$/m);
});
