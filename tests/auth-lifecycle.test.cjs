const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const safety = fs.readFileSync(path.join(root, 'tracker-safety.js'), 'utf8');
const pages = Object.fromEntries(['index.html', 'index_mobile.html'].map(file => [file, fs.readFileSync(path.join(root, file), 'utf8')]));

// Exercise the actual page modules. The SDK boundary supplies an already
// restored session; Firebase's own storage migration is not reimplemented here.
function fixture(file, restoredUser = { uid: 'existing-owner', email: 'owner@example.test' }) {
  const elements = new Map(), authCalls = [], overrides = [], subscriptions = [], storageMutations = [];
  const element = id => {
    if (!elements.has(id)) {
      const classes = new Set();
      elements.set(id, {
        value: '', checked: false, disabled: false, style: {}, innerHTML: '', textContent: '', dataset: {},
        classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name),
          toggle(name, force) { if (force === undefined ? !classes.has(name) : force) classes.add(name); else classes.delete(name); } },
        addEventListener() {}, appendChild() {}, focus() {}, click() {}, closest() { return null; }, contains() { return false; }
      });
    }
    return elements.get(id);
  };
  const auth = { currentUser: restoredUser };
  const context = {
    URL, URLSearchParams, Date, Blob, console: { error() {}, log() {} },
    setTimeout: () => 1, clearTimeout() {}, navigator: {},
    location: { search: '', hostname: 'example.test', origin: 'https://example.test', pathname: '/job-tracker/' },
    history: { replaceState() {} }, addEventListener() {},
    document: { activeElement: null, visibilityState: 'visible', getElementById: element, querySelector: element,
      querySelectorAll: () => [], createElement: element, addEventListener() {} },
    initializeApp: config => ({ name: '[DEFAULT]', options: config }), getFirestore: () => ({}),
    getAuth: app => { authCalls.push(app); return auth; },
    setPersistence: async (instance, persistence) => { overrides.push({ instance, persistence }); },
    browserLocalPersistence: { type: 'LOCAL' },
    GoogleAuthProvider: class { setCustomParameters() {} },
    onAuthStateChanged: (instance, callback) => { context.authCallback = callback; },
    getRedirectResult: async instance => { assert.equal(instance, auth); return null; },
    signInWithPopup: async () => {}, signInWithRedirect: async () => {},
    fbSignOut: async instance => { instance.currentUser = null; },
    collection: (...args) => args.slice(1), query: ref => ref, orderBy: () => null,
    doc: (...args) => args.slice(1),
    setDoc: async () => {}, updateDoc: async () => {}, addDoc: async () => ({}), deleteDoc: async () => {},
    getDocs: async () => ({ docs: [] }),
    getDoc: async () => ({ exists: () => true, data: () => ({ approved: true }) }),
    serverTimestamp: () => ({}),
    onSnapshot: (ref, callback, error) => {
      const subscription = { ref, callback, error, cancelled: false };
      subscriptions.push(subscription);
      return () => { subscription.cancelled = true; };
    },
    localStorage: { setItem: (...args) => storageMutations.push(args), removeItem: (...args) => storageMutations.push(args), clear: () => storageMutations.push('clear') },
    sessionStorage: { setItem: (...args) => storageMutations.push(args), removeItem: (...args) => storageMutations.push(args), clear: () => storageMutations.push('clear') }
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(safety, context);
  const source = pages[file].match(/<script type="module">([\s\S]*?)<\/script>/)[1].replace(/^import .*;\r?\n/gm, '');
  vm.runInContext(source, context);
  return { context, auth, authCalls, overrides, subscriptions, storageMutations, element, run: js => vm.runInContext(js, context) };
}

test('desktop and mobile delegate existing sessions to the same SDK default without forcing a storage move', () => {
  const restored = { uid: 'existing-owner', email: 'owner@example.test' };
  const desktop = fixture('index.html', restored), mobile = fixture('index_mobile.html', restored);
  for (const page of [desktop, mobile]) {
    assert.equal(page.authCalls.length, 1);
    assert.equal(page.auth.currentUser, restored);
    assert.equal(page.overrides.length, 0, 'page must not move the session out of the store watched by the other entrypoint');
    assert.equal(page.storageMutations.length, 0, 'page must not clear or copy SDK-owned session keys');
  }
  assert.deepEqual(JSON.parse(JSON.stringify(desktop.authCalls[0])), JSON.parse(JSON.stringify(mobile.authCalls[0])));
  const authImport = source => source.match(/from "(https:[^"]+firebase-auth\.js)"/)[1];
  assert.equal(authImport(pages['index.html']), authImport(pages['index_mobile.html']));
});

test('mobile access requires explicit approved true, not merely an existing allowlist record', async () => {
  const f = fixture('index_mobile.html');
  for (const [exists, data, expected] of [[false, {}, false], [true, {}, false], [true, { approved: false }, false], [true, { approved: 'true' }, false], [true, { approved: true }, true]]) {
    f.context.getDoc = async () => ({ exists: () => exists, data: () => data });
    assert.equal(await f.run("isAllowed({uid:'member',email:'member@example.test'})"), expected);
  }
});

test('a delayed mobile allowlist result cannot reopen the prior account', async () => {
  const f = fixture('index_mobile.html');
  let resolveA;
  const pendingA = new Promise(resolve => { resolveA = resolve; });
  f.context.getDoc = async ref => ref.at(-1) === 'account-a' ? pendingA : { exists: () => true, data: () => ({ approved: true }) };
  f.element('view').innerHTML = 'Old private records';
  const first = f.context.authCallback({ uid: 'account-a', email: 'a@example.test' });
  assert.equal(f.element('view').innerHTML, '');
  assert.equal(f.element('app-screen').classList.contains('hidden'), true);
  await Promise.resolve(); await Promise.resolve();
  await f.context.authCallback({ uid: 'account-b', email: 'b@example.test' });
  resolveA({ exists: () => true, data: () => ({ approved: true }) });
  await first;
  assert.equal(f.run('state.user.uid'), 'account-b');
  assert.equal(f.subscriptions.length, 1);
  assert.deepEqual(Array.from(f.subscriptions[0].ref), ['users', 'account-b', 'jobs']);
});

test('sign-out invalidates pending mobile auth work and old snapshots', async () => {
  const f = fixture('index_mobile.html');
  await f.context.authCallback({ uid: 'account-a', email: 'a@example.test' });
  const old = f.subscriptions[0];
  await f.context.authCallback(null);
  old.callback({ docs: [{ id: 'private-old', data: () => ({ company: 'Old account' }) }] });
  assert.equal(old.cancelled, true);
  assert.equal(f.run('state.jobs.length'), 0);
  assert.equal(f.element('view').innerHTML, '');
  assert.equal(f.element('login-screen').classList.contains('hidden'), false);
});

test('mobile binds record identity to the snapshot document id', async () => {
  const f = fixture('index_mobile.html');
  await f.context.authCallback({ uid: 'account-a', email: 'a@example.test' });
  f.run("state.tab = 'add'");
  f.subscriptions[0].callback({ docs: [{ id: 'actual-document', data: () => ({ firestoreId: 'different-document', company: 'Example' }) }] });
  assert.equal(f.run('state.jobs[0].firestoreId'), 'actual-document');
});
