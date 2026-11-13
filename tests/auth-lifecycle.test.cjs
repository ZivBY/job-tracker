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
function fixture(file, restoredUser = { uid: 'existing-owner', email: 'owner@example.test' }, search = '') {
  const elements = new Map(), authCalls = [], overrides = [], subscriptions = [], storageMutations = [], writes = [];
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
    location: { search, hostname: 'example.test', origin: 'https://example.test', pathname: file === 'index_mobile.html' ? '/job-tracker/index_mobile.html' : '/job-tracker/' },
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
    collection: (...args) => args.slice(1),
    query: (ref, ...constraints) => constraints.filter(Boolean).length ? { ref, constraints: constraints.filter(Boolean) } : ref,
    where: (field, operator, value) => ({ field, operator, value }), orderBy: () => null,
    doc: (...args) => args.slice(1),
    setDoc: async (ref, data) => { writes.push({ ref: Array.from(ref), data: JSON.parse(JSON.stringify(data)) }); },
    updateDoc: async () => {}, addDoc: async () => ({}), deleteDoc: async () => {},
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
  vm.runInContext(safety, context); vm.runInContext(fs.readFileSync(path.join(root, 'worker-client.js'), 'utf8'), context);
  const source = pages[file].match(/<script type="module">([\s\S]*?)<\/script>/)[1].replace(/^import .*;\r?\n/gm, '');
  vm.runInContext(source, context);
  return { context, auth, authCalls, overrides, subscriptions, storageMutations, writes, element, run: js => vm.runInContext(js, context) };
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

test('each entrypoint registers only the signed-in UID with a normalized email', async () => {
  for (const file of Object.keys(pages)) {
    const f = fixture(file);
    await f.context.authCallback({ uid: 'own-uid', email: 'Person.Name@Example.Test' });
    assert.deepEqual(f.writes, [{ ref: ['userDirectory', 'own-uid'], data: { uid: 'own-uid', email: 'person.name@example.test' } }]);
  }
});

function adminFixture() {
  const f = fixture('index.html');
  f.run("currentUser = { uid: 'admin', email: ADMIN_EMAIL }; isReadOnly = false;");
  return f;
}

function directoryDocument(id, email, uid = id) {
  return { id, data: () => ({ uid, email }) };
}

test('admin approval ignores poisoned legacy mappings and uses the verified directory document ID', async () => {
  const f = adminFixture(), queries = [];
  f.element('admin-email-input').value = 'Person.Name@Example.Test';
  f.context.getDoc = async () => { throw new Error('legacy single-document lookup must not be used'); };
  f.context.getDocs = async request => {
    if (Array.isArray(request)) return { empty: true, docs: [] };
    queries.push(JSON.parse(JSON.stringify(request)));
    return { docs: [directoryDocument('verified-uid', 'person.name@example.test')] };
  };
  await f.context.adminAddUser();
  assert.deepEqual(queries, [{ ref: ['userDirectory'], constraints: [{ field: 'email', operator: '==', value: 'person.name@example.test' }] }]);
  assert.deepEqual(f.writes, [{ ref: ['allowlist', 'verified-uid'], data: { email: 'person.name@example.test', approved: true } }]);
});

test('dotted and underscore email addresses do not collide in directory approvals', async () => {
  const f = adminFixture();
  const identities = new Map([['a.b@example.test', 'dotted-user'], ['a_b@example.test', 'underscore-user']]);
  f.context.getDocs = async request => {
    if (Array.isArray(request)) return { empty: true, docs: [] };
    const email = request.constraints[0].value;
    return { docs: [directoryDocument(identities.get(email), email)] };
  };
  for (const email of identities.keys()) {
    f.element('admin-email-input').value = email;
    await f.context.adminAddUser();
  }
  assert.deepEqual(f.writes.map(write => write.ref), [['allowlist', 'dotted-user'], ['allowlist', 'underscore-user']]);
});

test('missing, ambiguous, wrong-email, and forged-UID registrations cannot grant access', async () => {
  const email = 'candidate@example.test';
  const cases = [
    [],
    [directoryDocument('first', email), directoryDocument('second', email)],
    [directoryDocument('claimed-id', email, 'victim-id')],
    [directoryDocument('wrong-email', 'another@example.test')]
  ];
  for (const docs of cases) {
    const f = adminFixture();
    f.element('admin-email-input').value = email;
    f.context.getDocs = async () => ({ docs });
    await f.context.adminAddUser();
    assert.equal(f.writes.length, 0);
    assert.equal(f.element('admin-add-btn').disabled, false);
    if (!docs.length) assert.match(f.element('admin-status').textContent, /sign in again/);
  }
});

test('a pending directory lookup cannot approve after the admin signs out', async () => {
  const f = adminFixture();
  let finish;
  f.element('admin-email-input').value = 'candidate@example.test';
  f.context.getDocs = () => new Promise(resolve => { finish = resolve; });
  const approval = f.context.adminAddUser();
  await f.context.authCallback(null);
  finish({ docs: [directoryDocument('candidate-uid', 'candidate@example.test')] });
  await approval;
  assert.equal(f.writes.length, 0);
  assert.equal(f.element('admin-add-btn').disabled, false);
});

test('legacy share URLs never load records for anonymous, owner, or other signed-in users', async () => {
  const owner = { uid: 'owner', email: 'owner@example.test' };
  const other = { uid: 'other', email: 'other@example.test' };
  for (const file of Object.keys(pages)) {
    for (const [search, user] of [['?view=owner', null], ['?view=owner', owner], ['?view=owner', other], ['?view=', owner], ['?view=owner&source=old-link', owner]]) {
      const f = fixture(file, user, search);
      await f.context.authCallback(user);
      assert.equal(f.subscriptions.length, 0, file + ' must not query a tracker from a public link');
      assert.equal(f.writes.length, 0, file + ' public-link screen does not register or mutate an account');
      assert.equal(f.element('own-tracker-link').href, f.context.location.origin + f.context.location.pathname);
      assert.equal(f.context.location.search, search, 'show an explicit navigation link without silently rewriting the current URL');
      if (file === 'index.html') {
        assert.equal(f.element('sharing-unavailable-screen').style.display, 'block');
        assert.equal(f.element('app').style.display, 'none');
      } else {
        assert.equal(f.element('sharing-unavailable-screen').classList.contains('hidden'), false);
        assert.equal(f.element('app-screen').classList.contains('hidden'), true);
      }
    }
  }
});

test('share controls explain owner-only access without generating or copying a UID URL', async () => {
  const desktop = adminFixture(), mobile = fixture('index_mobile.html');
  let copies = 0;
  for (const f of [desktop, mobile]) f.context.navigator.clipboard = { writeText: async () => { copies++; } };
  desktop.context.showShareModal();
  mobile.run("state.user = { uid: 'private-owner' }; handleAction('share', {});");
  assert.equal(copies, 0);
  assert.equal(desktop.element('share-modal').style.display, 'block');
  assert.match(mobile.element('toast').textContent, /Public sharing is unavailable\. Only you can view your tracker\./);
  assert.doesNotMatch(mobile.element('toast').textContent, /copied|private-owner/i);
  assert.equal(typeof desktop.context.copyShareUrl, 'undefined');
  for (const source of Object.values(pages)) {
    assert.doesNotMatch(source, /["']\?view=["']\s*\+/);
    assert.doesNotMatch(source, /Anyone with this link can view/);
  }
});
