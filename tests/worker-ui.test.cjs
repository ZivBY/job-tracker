const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const suggestion = { company: 'Example', suggestedStage: 2, emailFrom: 'Recruiter', emailSubject: 'Interview', reason: 'Invitation' };
function fixture(file = 'index.html', search = '') {
  const elements = new Map(), calls = [], writes = [], timers = [];
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', checked: false, disabled: false, style: {}, dataset: {}, innerHTML: '', textContent: '',
      options: [{ text: 'Full-time', value: 'Full-time' }], classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
      addEventListener() {}, appendChild() {}, focus() {}, closest() { return null; } });
    return elements.get(id);
  };
  const user = { uid: 'owner-a', email: 'owner@example.test', getIdToken: async () => 'fixture-id-token' };
  const context = { URL, URLSearchParams, Date, Blob, AbortController, console: { error() {}, log() {} },
    setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {}, navigator: {}, addEventListener() {},
    location: { search, origin: 'https://example.test', hostname: 'example.test', pathname: '/job-tracker/', href: '' }, history: { replaceState() {} },
    document: { activeElement: null, getElementById: element, querySelector: element, querySelectorAll: () => [], createElement: element, addEventListener() {} },
    initializeApp: () => ({}), getFirestore: () => ({}), getAuth: () => ({ currentUser: user }),
    GoogleAuthProvider: class { setCustomParameters() {} }, onAuthStateChanged: (auth, cb) => { context.authCallback = cb; },
    getRedirectResult: async () => null, signInWithPopup: async () => {}, signInWithRedirect: async () => {}, fbSignOut: async () => {},
    collection: (...args) => args.slice(1), doc: (...args) => args.slice(1), query: ref => ref, orderBy() {}, where() {},
    getDoc: async () => ({ exists: () => false }), getDocs: async () => ({ docs: [] }), onSnapshot: () => () => {},
    setDoc: async (ref, data) => { writes.push({ ref: Array.from(ref), data: JSON.parse(JSON.stringify(data)) }); },
    updateDoc: async () => {}, deleteDoc: async () => {}, addDoc: async () => {}, serverTimestamp: () => 1,
    testUser: user,
    fetch: async (url, options) => { calls.push({ url, options, body: JSON.parse(options.body) }); return response({ job: { company: 'Extracted Company', role: 'Role' } }); }
  };
  context.window = context; vm.createContext(context);
  for (const helper of ['tracker-safety.js', 'worker-client.js']) vm.runInContext(fs.readFileSync(path.join(root, helper), 'utf8'), context);
  const source = fs.readFileSync(path.join(root, file), 'utf8').match(/<script type="module">([\s\S]*?)<\/script>/)[1].replace(/^import .*;\r?\n/gm, '');
  vm.runInContext(source, context);
  const run = code => vm.runInContext(code, context);
  run(file === 'index.html' ? 'currentUser = testUser; isReadOnly = false;' : 'state.user = testUser; state.readOnly = false; state.tab = "add";');
  const handle = fn => { context.fetch = async (url, options) => { calls.push({ url, options, body: JSON.parse(options.body) }); return fn(url, options); }; };
  return { element, run, context, calls, writes, timers, handle, user };
}
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function tick() { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }

test('both entrypoints extract using Bearer authentication and structured job responses', async () => {
  for (const file of ['index.html', 'index_mobile.html']) {
    const f = fixture(file); f.element('jd-text').value = 'A job description';
    await f.run('extractFromText()');
    assert.equal(f.calls.length, 1); assert.match(f.calls[0].url, /\/extract$/);
    assert.equal(f.calls[0].options.headers.Authorization, 'Bearer fixture-id-token');
    assert.deepEqual(f.calls[0].body, { text: 'A job description' });
    assert.equal(f.element('f-company').value, 'Extracted Company');
    assert.equal(f.writes.length, 0, 'extraction is only a reviewable draft');
  }
});
test('both entrypoints ignore extraction responses after an account switch', async () => {
  for (const file of ['index.html', 'index_mobile.html']) {
    const f = fixture(file), d = deferred(); f.handle(() => d.promise); f.element('jd-text').value = 'description';
    const pending = f.run('extractFromText()'); await tick();
    f.run(file === 'index.html' ? 'currentUser = null; ++authRevision;' : 'state.user = null; ++authRevision;');
    f.element('f-company').value = 'Current account draft'; f.element('jd-status').textContent = 'Current status';
    d.resolve(response({ job: { company: 'Old account result' } })); await pending;
    assert.equal(f.element('f-company').value, 'Current account draft'); assert.equal(f.element('jd-status').textContent, 'Current status');
    assert.equal(f.writes.length, 0);
  }
});
test('both entrypoints block repeated extraction and readonly requests', async () => {
  for (const file of ['index.html', 'index_mobile.html']) {
    const f = fixture(file), d = deferred(); f.handle(() => d.promise); f.element('jd-text').value = 'description';
    const first = f.run('extractFromText()'); await tick(); await f.run('extractFromText()'); assert.equal(f.calls.length, 1);
    d.resolve(response({ job: { company: 'Result' } })); await first;
    f.run(file === 'index.html' ? 'isReadOnly = true;' : 'state.readOnly = true;'); await f.run('extractFromText()'); assert.equal(f.calls.length, 1);
  }
});
test('closing the desktop Add form discards a pending extraction instead of filling the next draft', async () => {
  const f = fixture(), d = deferred(); f.handle(() => d.promise); f.element('jd-text').value = 'description';
  const pending = f.run('extractFromText()'); await tick(); f.run('resetApplicationForm()');
  f.element('f-company').value = 'New draft'; d.resolve(response({ job: { company: 'Old result' } })); await pending;
  assert.equal(f.element('f-company').value, 'New draft'); assert.equal(f.element('jd-btn').disabled, false);
});
test('maintenance response preserves drafts and shows the same safe explanation on desktop and mobile', async () => {
  for (const file of ['index.html', 'index_mobile.html']) {
    const f = fixture(file); f.handle(async () => response({ error: 'security_maintenance', message: 'untrusted detail' }, 503));
    f.element('jd-text').value = 'description'; f.element('f-company').value = 'Existing draft';
    await f.run('extractFromText()');
    assert.equal(f.element('f-company').value, 'Existing draft'); assert.match(f.element('jd-status').textContent, /temporarily paused/);
    assert.doesNotMatch(f.element('jd-status').textContent, /untrusted detail/);
  }
});
test('Gmail return query never scans or reports an unverified successful connection', async () => {
  const f = fixture('index.html', '?gmail=connected');
  assert.equal(f.calls.length, 0); assert.equal(f.writes.length, 0);
  f.timers.at(-1)(); assert.match(f.element('toast').textContent, /verify the connection/);
  f.handle(async () => response({ connected: false, reconnectRequired: true })); await f.run('showGmailPanel()');
  assert.equal(f.calls.length, 1); assert.match(f.calls[0].url, /\/gmail\/status$/);
  assert.equal(f.element('gmail-connect-btn').textContent, 'Reconnect Gmail'); assert.equal(f.run('gmailConnected'), false);
});
test('Gmail linking requires explicit consent and ignores an old-account redirect result', async () => {
  const f = fixture(), d = deferred(); f.handle(() => d.promise);
  await f.run('connectGmail()'); assert.equal(f.calls.length, 0);
  f.element('gmail-link-consent').checked = true;
  const pending = f.run('connectGmail()'); await tick();
  assert.deepEqual(f.calls[0].body, { consentToLink: true }); assert.equal(f.element('gmail-link-consent').checked, false);
  f.run('currentUser = null; ++authRevision;'); d.resolve(response({ authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=test' })); await pending;
  assert.equal(f.context.location.href, '');
});
test('each Gmail scan needs fresh opt-in, sends minimal company context and never applies job updates', async () => {
  const f = fixture(); f.run("gmailConnected = true; jobs = [{firestoreId:'private-record-id',company:'Example',stage:1}];");
  f.handle(async () => response({ suggestions: [suggestion] }));
  await f.run('scanGmail()'); assert.equal(f.calls.length, 0);
  f.element('gmail-scan-consent').checked = true; await f.run('scanGmail()');
  assert.deepEqual(f.calls[0].body, { companies: [{ company: 'Example', currentStage: 1 }], consentToAiProcessing: true });
  assert.equal(f.element('gmail-scan-consent').checked, false); assert.equal(f.run('jobs[0].stage'), 1);
  assert.equal(f.writes.length, 1); assert.deepEqual(f.writes[0].ref, ['users', 'owner-a', 'gmailSync', 'latest']);
  assert.equal(f.writes[0].data.suggestions[0].applied, false);
  await f.run('scanGmail()'); assert.equal(f.calls.length, 1);
});
test('an old-account Gmail scan cannot render or save suggestions under the next account', async () => {
  const f = fixture(), d = deferred(); f.handle(() => d.promise); f.run('gmailConnected = true;'); f.element('gmail-scan-consent').checked = true;
  const pending = f.run('scanGmail()'); await tick();
  f.run("currentUser = {uid:'owner-b',getIdToken:async()=> 'other'}; ++authRevision; resetGmailState();");
  d.resolve(response({ suggestions: [suggestion] })); await pending;
  assert.equal(f.writes.length, 0); assert.equal(f.element('gmail-suggestions').innerHTML, ''); assert.equal(f.element('gmail-status').textContent, '');
});
test('late saved Gmail history cannot appear after sign-out', async () => {
  const f = fixture(), d = deferred(); f.handle(async () => response({ connected: true, reconnectRequired: false }));
  f.context.getDoc = () => d.promise;
  const pending = f.run('showGmailPanel()'); await tick(); await tick();
  f.run('currentUser = null; ++authRevision; resetGmailState();');
  d.resolve({ exists: () => true, data: () => ({ suggestions: [suggestion], scannedAt: 'old' }) }); await pending;
  assert.equal(f.element('gmail-suggestions').innerHTML, '');
});
test('disconnect failure never claims Google access was revoked', async () => {
  const f = fixture(); f.run('gmailConnected = true;');
  f.handle(async () => response({ error: { code: 'revocation_failed', message: 'provider secrets' } }, 502));
  await f.run('disconnectGmail()');
  assert.equal(f.run('gmailConnected'), false); assert.match(f.element('gmail-status').textContent, /revocation could not be confirmed/);
  assert.equal(f.element('gmail-revoke-retry-btn').style.display, 'block');
  assert.equal(f.element('gmail-connect-btn').disabled, true);
  assert.doesNotMatch(f.element('gmail-status').textContent, /provider secrets|Google access revoked/);
});
test('pending Google revocation remains recoverable after panel reopen and blocks reconnect', async () => {
  const f = fixture();
  f.handle(async url => response(url.endsWith('/gmail/status') ? { connected: false, reconnectRequired: true, revocationPending: true } : { success: true, revoked: true }));
  await f.run('showGmailPanel()');
  assert.equal(f.element('gmail-revoke-retry-btn').style.display, 'block'); assert.equal(f.element('gmail-revoke-retry-btn').disabled, false);
  assert.equal(f.element('gmail-connect-btn').disabled, true);
  f.element('gmail-link-consent').checked = true; await f.run('connectGmail()'); assert.equal(f.calls.length, 1);
  await f.run('disconnectGmail()');
  assert.match(f.calls[1].url, /\/gmail\/disconnect$/); assert.equal(f.element('gmail-revoke-retry-btn').style.display, 'none');
  assert.equal(f.element('gmail-connect-btn').disabled, false); assert.match(f.element('gmail-status').textContent, /Google access revoked/);
});
test('manual Google recovery is server-gated, requires fresh owner confirmation and never claims API verification', async () => {
  const f = fixture(); let available = false;
  f.handle(async url => response(url.endsWith('/gmail/status')
    ? { connected: false, reconnectRequired: true, revocationPending: true, manualRevocationRequired: available }
    : { success: true, revoked: false, confirmation: 'owner' }));
  await f.run('showGmailPanel()');
  assert.equal(f.element('gmail-manual-recovery').style.display, 'none');
  f.element('gmail-manual-revoke-confirm').checked = true; await f.run('disconnectGmail(true)');
  assert.equal(f.calls.length, 1, 'a forced checkbox cannot override the server availability flag');
  available = true; await f.run('showGmailPanel()');
  assert.equal(f.element('gmail-manual-recovery').style.display, 'block');
  assert.equal(f.element('gmail-connect-btn').disabled, true);
  assert.equal(f.element('gmail-manual-revoke-confirm').checked, false);
  await f.run('disconnectGmail(true)'); assert.equal(f.calls.length, 2, 'unchecked confirmation must not send a request');
  f.element('gmail-manual-revoke-confirm').checked = true; await f.run('disconnectGmail(true)');
  assert.equal(f.calls[2].options.headers.Authorization, 'Bearer fixture-id-token');
  assert.deepEqual(f.calls[2].body, { confirmManualRevocation: true });
  assert.equal(f.element('gmail-manual-revoke-confirm').checked, false); assert.equal(f.element('gmail-manual-recovery').style.display, 'none');
  assert.match(f.element('gmail-status').textContent, /based on your confirmation/);
  assert.match(f.element('gmail-status').textContent, /not independently verified/);
  assert.doesNotMatch(f.element('gmail-status').textContent, /Google access revoked/); assert.equal(f.writes.length, 0);
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /href="https:\/\/myaccount\.google\.com\/connections" target="_blank" rel="noopener noreferrer"/);
});
test('server rejects premature recovery without clearing pending state or automatically confirming', async () => {
  const f = fixture(); let available = false;
  f.handle(async url => url.endsWith('/gmail/status')
    ? response({ connected: false, reconnectRequired: true, revocationPending: true, manualRevocationRequired: available })
    : response({ error: { code: available ? 'request_in_progress' : 'revocation_pending' } }, 409));
  await f.run('showGmailPanel()'); await f.run('disconnectGmail()');
  assert.equal(f.element('gmail-manual-recovery').style.display, 'none'); assert.equal(f.element('gmail-connect-btn').disabled, true);
  assert.equal(f.calls.filter(c => c.body.confirmManualRevocation).length, 0);
  available = true; await f.run('showGmailPanel()'); f.element('gmail-manual-revoke-confirm').checked = true;
  await f.run('disconnectGmail(true)');
  assert.equal(f.element('gmail-manual-revoke-confirm').checked, false); assert.equal(f.element('gmail-connect-btn').disabled, true);
  assert.match(f.element('gmail-status').textContent, /already in progress/);
  assert.doesNotMatch(f.element('gmail-status').textContent, /Connection cleared|access revoked/); assert.equal(f.writes.length, 0);
});
test('manual recovery response cannot alter the next account after sign-out', async () => {
  const f = fixture(), d = deferred();
  f.handle(async url => url.endsWith('/gmail/status') ? response({ connected: false, reconnectRequired: true, revocationPending: true, manualRevocationRequired: true }) : d.promise);
  await f.run('showGmailPanel()'); f.element('gmail-manual-revoke-confirm').checked = true;
  const pending = f.run('disconnectGmail(true)'); await tick();
  f.run('currentUser = null; ++authRevision; resetGmailState();');
  d.resolve(response({ success: true, revoked: false, confirmation: 'owner' })); await pending;
  assert.equal(f.element('gmail-status').textContent, ''); assert.equal(f.element('gmail-manual-recovery').style.display, 'none'); assert.equal(f.writes.length, 0);
});
