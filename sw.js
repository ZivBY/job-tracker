const CACHE_PREFIX = 'job-tracker-';
const CACHE = CACHE_PREFIX + 'v12';
const BASE = new URL(self.registration.scope);
const PAGE_NAMES = new Set([
  '', 'index.html', 'index_mobile.html', 'index_v2.html', 'index_v3.html',
  'index_v4.html', 'index_v4.1.html', 'index_v5.html', 'index_v5.1.html',
  'index_v6.html', 'index_v6.1.html', 'index_v7.html', 'index_v8.html'
]);
const STATIC_NAMES = new Set([
  'manifest.json', 'icon-32.png', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'
]);
// Unversioned executable code must revalidate alongside HTML, not stay in a
// cache-first bucket after an update. Future incompatible helpers should use
// content-hashed filenames in both the page and this asset list.
const SCRIPT_NAMES = new Set(['tracker-safety.js', 'worker-client.js']);
const ASSETS = ['', 'index.html', 'index_mobile.html', ...STATIC_NAMES, ...SCRIPT_NAMES]
  .map(name => new URL(name, BASE).href);

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => Promise.all(ASSETS.map(async url => {
        const response = await fetch(new Request(url, { cache: 'reload' }));
        const name = new URL(url).pathname.slice(BASE.pathname.length);
        if (!cacheable(response, PAGE_NAMES.has(name))) throw new Error('App shell could not be cached');
        if (SCRIPT_NAMES.has(name) && !javascriptResponse(response)) throw new Error('App script could not be cached');
        await cache.put(url, response);
      })))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE)
        .map(key => caches.delete(key))
    )).then(() => self.clients.claim())
  );
});

function cacheable(response, isPage) {
  return response.ok && !response.redirected &&
    !/\b(no-store|private)\b/i.test(response.headers.get('cache-control') || '') &&
    (!isPage || /text\/html/i.test(response.headers.get('content-type') || ''));
}

function javascriptResponse(response) {
  return /(?:javascript|ecmascript)/i.test(response.headers.get('content-type') || '');
}

async function scriptAsset(event, key) {
  const cache = await caches.open(CACHE).catch(() => null);
  const cached = async () => cache && cache.match(key);
  try {
    const response = await fetch(event.request, { cache: 'no-cache' });
    if (response.status >= 500) return (await cached()) || response;
    if (cache && cacheable(response, false) && javascriptResponse(response)) {
      event.waitUntil(cache.put(key, response.clone()).catch(() => {}));
    }
    return response;
  } catch {
    return (await cached()) || new Response('', {
      status: 503, headers: { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' }
    });
  }
}

async function cachedPage(cache, key, name) {
  if (!cache) return;
  const cached = await cache.match(key);
  if (cached) return cached;
  // The directory URL and index.html are the same canonical page. Other
  // layouts keep their own offline copy rather than opening a different UI.
  if (name === '' || name === 'index.html') {
    return cache.match(new URL(name === '' ? 'index.html' : '', BASE).href);
  }
}

async function navigation(event, url, name) {
  const key = new URL(name, BASE).href;
  const cache = await caches.open(CACHE).catch(() => null);
  try {
    // Revalidate HTML even when the worker itself has not changed. The old
    // cache-first policy could otherwise keep a deployment invisible forever.
    const response = await fetch(event.request, { cache: 'no-cache' });
    if (response.status >= 500) return (await cachedPage(cache, key, name)) || response;
    // Share/auth query strings may contain user identifiers. Never persist
    // those responses or URLs; offline visits can use the public page shell.
    if (cache && !url.search && cacheable(response, true)) {
      event.waitUntil(cache.put(key, response.clone()).catch(() => {}));
    }
    return response;
  } catch {
    return (await cachedPage(cache, key, name)) || new Response(
      '<!doctype html><title>Job Tracker is offline</title><p>This page is not available offline yet. Reconnect and try again.</p>',
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } }
    );
  }
}

async function staticAsset(event, key) {
  const cache = await caches.open(CACHE).catch(() => null);
  const cached = cache && await cache.match(key);
  if (cached) return cached;
  const response = await fetch(event.request);
  if (cache && cacheable(response, false)) {
    event.waitUntil(cache.put(key, response.clone()).catch(() => {}));
  }
  return response;
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || request.headers.has('authorization')) return;
  const url = new URL(request.url);
  if (url.origin !== BASE.origin || !url.pathname.startsWith(BASE.pathname)) return;
  const name = url.pathname.slice(BASE.pathname.length);
  if (request.mode === 'navigate' && PAGE_NAMES.has(name)) {
    event.respondWith(navigation(event, url, name));
  } else if (!url.search && SCRIPT_NAMES.has(name)) {
    event.respondWith(scriptAsset(event, url.href));
  } else if (!url.search && STATIC_NAMES.has(name)) {
    event.respondWith(staticAsset(event, url.href));
  }
  // Firebase, the extraction proxy, API paths, other apps, and non-GET
  // requests stay entirely outside this public-shell cache.
});
