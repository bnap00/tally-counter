const CACHE_PREFIX = 'tally-shell-';
const CACHE_NAME = `${CACHE_PREFIX}v10`;
const NAVIGATION_TIMEOUT_MS = 3000;
const SHELL_ASSETS = [
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
const SHELL_URLS = new Set(
  SHELL_ASSETS.map((asset) => new URL(asset, self.location.href).href),
);
const APP_PATHNAMES = new Set(
  ['./', './index.html'].map((path) => new URL(path, self.location.href).pathname),
);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((cacheNames) => Promise.all(
        cacheNames
          .filter((cacheName) => cacheName.startsWith(CACHE_PREFIX) && cacheName !== CACHE_NAME)
          .map((cacheName) => caches.delete(cacheName)),
      ))
      .then(() => self.clients.claim()),
  );
});

async function cacheFirstNavigation(request) {
  const cache = await caches.open(CACHE_NAME);
  // Keep HTML and static assets from the same installed release while updates wait.
  const cached = await cache.match('./index.html');
  if (cached) return cached;

  const controller = new AbortController();
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new Error('Navigation request timed out'));
    }, NAVIGATION_TIMEOUT_MS);
  });

  try {
    const response = await Promise.race([
      fetch(request, { signal: controller.signal }),
      timeout,
    ]);
    // A cache miss may use the network, but must not mutate this release's shell.
    return response.ok ? response : Response.error();
  } catch {
    return Response.error();
  } finally {
    clearTimeout(timeoutId);
  }
}

async function cacheFirstStatic(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch {
    return Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
    if (!APP_PATHNAMES.has(url.pathname)) return;
    event.respondWith(cacheFirstNavigation(request));
    return;
  }
  if (!SHELL_URLS.has(url.href)) return;

  event.respondWith(cacheFirstStatic(request));
});
