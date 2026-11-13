const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
const html = (body, options = {}) => new Response(body, {
  ...options, headers: { 'content-type': 'text/html', ...options.headers }
});

function worker(scope = 'https://example.test/job-tracker/') {
  const listeners = new Map();
  const stores = new Map();
  const fetches = [];
  let skipped = false;
  let claimed = false;
  let network = async request => request.url.endsWith('.js') ? new Response('public script', { headers: { 'content-type': 'text/javascript' } }) : html('network');
  let failPut = false;
  let failOpen = false;
  const keyOf = value => typeof value === 'string' ? value : value.url;
  function cache(name) {
    if (!stores.has(name)) stores.set(name, new Map());
    const entries = stores.get(name);
    return {
      match: async key => entries.get(keyOf(key))?.clone(),
      put: async (key, response) => {
        if (failPut) throw new Error('Quota exceeded');
        entries.set(keyOf(key), response.clone());
      }
    };
  }
  vm.runInNewContext(source, {
    URL, Request, Response, Set,
    self: {
      registration: { scope },
      addEventListener: (name, fn) => listeners.set(name, fn),
      skipWaiting: async () => { skipped = true; },
      clients: { claim: async () => { claimed = true; } }
    },
    caches: {
      open: async name => {
        if (failOpen) throw new Error('Storage unavailable');
        return cache(name);
      },
      keys: async () => [...stores.keys()],
      delete: async name => stores.delete(name)
    },
    fetch: async (request, init) => {
      fetches.push({ request, init });
      return network(request, init);
    }
  });
  return {
    scope, stores, fetches,
    setNetwork: fn => { network = fn; },
    failWrites: () => { failPut = true; },
    failOpen: () => { failOpen = true; },
    seed: (name, route, response) => cache(name).put(new URL(route, scope).href, response),
    cached: (route, name = 'job-tracker-v12') => cache(name).match(new URL(route, scope).href),
    async lifecycle(type) {
      const pending = [];
      listeners.get(type)({ waitUntil: promise => pending.push(promise) });
      await Promise.all(pending);
      return { skipped, claimed };
    },
    async request(route, options = {}) {
      const pending = [];
      let response;
      listeners.get('fetch')({
        request: {
          url: new URL(route, scope).href,
          method: options.method || 'GET',
          mode: options.mode || 'navigate',
          headers: new Headers(options.headers)
        },
        respondWith: promise => { response = promise; },
        waitUntil: promise => pending.push(promise)
      });
      if (!response) return undefined;
      const result = await response;
      await Promise.all(pending);
      return result;
    }
  };
}

test('install uses registration scope and reloads public shells/assets', async () => {
  for (const scope of ['https://example.test/job-tracker/', 'http://localhost:8042/']) {
    const w = worker(scope);
    const result = await w.lifecycle('install');
    assert.equal(result.skipped, true);
    const requests = w.fetches.map(call => call.request);
    assert.ok(requests.some(request => request.url === scope));
    assert.ok(requests.some(request => request.url === scope + 'index_mobile.html'));
    assert.ok(requests.some(request => request.url === scope + 'tracker-safety.js'));
    assert.equal(await (await w.cached('tracker-safety.js')).text(), 'public script');
    assert.ok(requests.some(request => request.url === scope + 'worker-client.js'));
    assert.equal(await (await w.cached('worker-client.js')).text(), 'public script');
    assert.ok(requests.every(request => request.url.startsWith(scope) && request.cache === 'reload'));
    assert.ok(requests.every(request => !new URL(request.url).search));
    assert.equal(await (await w.cached('')).text(), 'network');
  }
});

test('install rejects private shell responses instead of persisting them', async () => {
  const w = worker();
  w.setNetwork(async () => html('private response', { headers: { 'cache-control': 'private' } }));
  await assert.rejects(w.lifecycle('install'), /could not be cached/);
  assert.equal(await w.cached(''), undefined);
});

test('activation removes tracker caches and preserves other same-origin apps', async () => {
  const w = worker();
  await w.seed('job-tracker-v10', '', html('old'));
  await w.seed('job-tracker-v11', '', html('previous local worker'));
  await w.seed('job-tracker-v12', '', html('current'));
  await w.seed('other-project-cache', '', html('unrelated'));
  const result = await w.lifecycle('activate');
  assert.equal(result.claimed, true);
  assert.deepEqual([...w.stores.keys()].sort(), ['job-tracker-v12', 'other-project-cache']);
});

test('navigation always fetches fresh HTML and replaces the offline copy without a worker bump', async () => {
  const w = worker();
  await w.seed('job-tracker-v12', '', html('old deployment'));
  w.setNetwork(async () => html('new deployment'));
  assert.equal(await (await w.request('')).text(), 'new deployment');
  assert.equal(w.fetches[0].init.cache, 'no-cache');
  assert.equal(await (await w.cached('')).text(), 'new deployment');
  w.setNetwork(async () => { throw new Error('offline'); });
  assert.equal(await (await w.request('')).text(), 'new deployment');
});

test('offline fallback preserves mobile and versioned routes instead of substituting desktop', async () => {
  const w = worker();
  await w.seed('job-tracker-v12', '', html('desktop'));
  await w.seed('job-tracker-v12', 'index_mobile.html', html('mobile'));
  await w.seed('job-tracker-v12', 'index_v5.1.html', html('preview'));
  w.setNetwork(async () => { throw new Error('offline'); });
  assert.equal(await (await w.request('index_mobile.html')).text(), 'mobile');
  assert.equal(await (await w.request('index_v5.1.html')).text(), 'preview');
  assert.equal((await w.request('index_v8.html')).status, 503);
  assert.equal(await (await w.request('index.html')).text(), 'desktop');
});

test('share/auth query responses and identifiers are not cached; offline uses only public shell', async () => {
  const w = worker();
  await w.seed('job-tracker-v12', 'index_mobile.html', html('public mobile shell'));
  w.setNetwork(async () => html('query response'));
  assert.equal(await (await w.request('index_mobile.html?view=private-uid')).text(), 'query response');
  assert.equal(await (await w.cached('index_mobile.html')).text(), 'public mobile shell');
  assert.equal(await w.cached('index_mobile.html?view=private-uid'), undefined);
  w.setNetwork(async () => { throw new Error('offline'); });
  assert.equal(await (await w.request('index_mobile.html?view=private-uid')).text(), 'public mobile shell');
});

test('does not intercept private APIs, external origins, other apps, POST, or authorization requests', async () => {
  const w = worker();
  for (const [route, options] of [
    ['api/jobs', {}], ['https://firestore.googleapis.com/private', {}],
    ['https://jd-proxy.example.test/', {}], ['/another-app/', {}],
    ['', { method: 'POST' }], ['', { headers: { authorization: 'Bearer example' } }],
    ['unknown.html', {}], ['icon-192.png?user=private', { mode: 'cors' }]
  ]) assert.equal(await w.request(route, options), undefined, route);
  assert.equal(w.fetches.length, 0);
  assert.equal(w.stores.size, 0);
});

test('private, no-store, redirected, and non-HTML page responses never replace public shells', async () => {
  const w = worker();
  await w.seed('job-tracker-v12', '', html('public shell'));
  const redirected = html('redirect target');
  Object.defineProperty(redirected, 'redirected', { value: true });
  for (const response of [
    html('private', { headers: { 'cache-control': 'private, max-age=60' } }),
    html('no store', { headers: { 'cache-control': 'no-store' } }), redirected,
    new Response('{"private":true}', { headers: { 'content-type': 'application/json' } })
  ]) {
    w.setNetwork(async () => response);
    assert.equal(await w.request(''), response);
    assert.equal(await (await w.cached('')).text(), 'public shell');
  }
});

test('server outage uses offline shell, but HTTP 404 remains visible and uncached', async () => {
  const w = worker();
  await w.seed('job-tracker-v12', '', html('public shell'));
  w.setNetwork(async () => html('outage', { status: 503 }));
  assert.equal(await (await w.request('')).text(), 'public shell');
  w.setNetwork(async () => html('removed', { status: 404 }));
  assert.equal((await w.request('')).status, 404);
  assert.equal(await (await w.cached('')).text(), 'public shell');
});

test('cache quota failure cannot discard an otherwise successful navigation', async () => {
  const w = worker();
  w.failWrites();
  w.setNetwork(async () => html('fresh content'));
  assert.equal(await (await w.request('')).text(), 'fresh content');
});

test('unavailable cache storage still allows online navigation and static assets', async () => {
  const w = worker();
  w.failOpen();
  w.setNetwork(async () => html('online response'));
  assert.equal(await (await w.request('')).text(), 'online response');
  assert.equal(await (await w.request('icon-192.png', { mode: 'cors' })).text(), 'online response');
});

test('only allowlisted static assets use cache-first', async () => {
  const w = worker();
  w.setNetwork(async () => new Response('icon bytes', { headers: { 'content-type': 'image/png' } }));
  assert.equal(await (await w.request('icon-192.png', { mode: 'cors' })).text(), 'icon bytes');
  assert.equal(await (await w.request('icon-192.png', { mode: 'cors' })).text(), 'icon bytes');
  assert.equal(w.fetches.length, 1);
});

test('unversioned helper revalidates with new HTML instead of serving stale executable code', async () => {
  for (const helper of ['tracker-safety.js', 'worker-client.js']) {
  const w = worker();
  await w.seed('job-tracker-v12', helper, new Response('old helper'));
  w.setNetwork(async () => new Response('new helper', { headers: { 'content-type': 'text/javascript' } }));
  assert.equal(await (await w.request(helper, { mode: 'no-cors' })).text(), 'new helper');
  assert.equal(w.fetches[0].init.cache, 'no-cache');
  assert.equal(await (await w.cached(helper)).text(), 'new helper');
  w.setNetwork(async () => { throw new Error('offline'); });
  assert.equal(await (await w.request(helper, { mode: 'no-cors' })).text(), 'new helper');
  }
});

test('HTML error responses cannot poison the helper cache', async () => {
  const w = worker();
  await w.seed('job-tracker-v12', 'tracker-safety.js', new Response('valid helper'));
  w.setNetwork(async () => html('wrong MIME type'));
  await w.request('tracker-safety.js', { mode: 'no-cors' });
  assert.equal(await (await w.cached('tracker-safety.js')).text(), 'valid helper');
});
