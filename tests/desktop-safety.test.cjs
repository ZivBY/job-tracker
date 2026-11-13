const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
  .match(/<script type="module">([\s\S]*?)<\/script>/)[1].replace(/^import .*;\r?\n/gm, '');
const safety = fs.readFileSync(path.join(root, 'tracker-safety.js'), 'utf8');
const baseJob = (id = 'j1') => ({ firestoreId: id, company: 'Acme', role: 'Director', stage: 1,
  type: 'Full-time', color: '#635BFF', emoji: 'A', stageData: {}, stageNotes: {}, stageHistory: [],
  interviewRounds: [{ type: '', date: '', with: '', notes: '' }], attachments: [{ label: '', url: '' }], contacts: [{ name: '', title: '' }] });

function fixture() {
  const elements = new Map(), events = {}, writes = [], additions = [], historyWrites = [], downloads = [];
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', checked: false, disabled: false, style: {}, innerHTML: '', textContent: '', children: [],
      classList: { add() {}, remove() {} }, appendChild(child) { this.children.push(child); }, focus() {}, click() {}, closest() { return null; } });
    return elements.get(id);
  };
  let nextTimer = 0, nextId = 0;
  class FixtureURL extends URL {
    static createObjectURL(blob) { downloads.push(blob); return 'blob:fixture'; }
    static revokeObjectURL() {}
  }
  const context = { console, URL: FixtureURL, URLSearchParams, Blob, Date, setTimeout: () => ++nextTimer, clearTimeout() {},
    location: { search: '', origin: 'https://example.test', pathname: '/job-tracker/' },
    navigator: {}, confirm: () => false, history: { replaceState() {} }, addEventListener: (name, callback) => { events[name] = callback; },
    document: { activeElement: null, visibilityState: 'visible', getElementById: element,
      createElement: tag => element(tag + ++nextId), querySelectorAll: () => [], addEventListener() {} },
    initializeApp: () => ({}), getFirestore: () => ({}), getAuth: () => ({}), GoogleAuthProvider: class {},
    onAuthStateChanged: (auth, callback) => { context.authCallback = callback; }, signInWithPopup: async () => {}, fbSignOut: async () => {},
    collection: (...args) => args, query: (...args) => args, orderBy: (...args) => args,
    doc: (...args) => ({ args, id: args.length === 1 ? 'new-' + ++nextId : args.at(-1) }),
    onSnapshot: (query, callback) => { context.snapshot = callback; return () => {}; },
    serverTimestamp: () => ({ seconds: 100 }), updateDoc: async (ref, fields) => { writes.push({ ref, fields: JSON.parse(JSON.stringify(fields)) }); },
    setDoc: async (ref, data) => { additions.push({ ref, data: JSON.parse(JSON.stringify(data)) }); },
    getDoc: async () => ({ exists: () => true, data: () => ({ suggestions: [{ suggestedStage: 2 }] }) }),
    getDocs: async () => ({ docs: [] }), deleteDoc: async () => {}, fetch: async () => { throw new Error('No external network in tests'); }
  };
  context.window = context;
  vm.createContext(context); vm.runInContext(safety, context); vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'worker-client.js'), 'utf8'), context); vm.runInContext(source, context);
  const run = js => vm.runInContext(js, context);
  const setJobs = jobs => run('jobs = ' + JSON.stringify(jobs));
  run("currentUser = { uid: 'owner', email: ADMIN_EMAIL, getIdToken: async () => 'fixture-token' }; isReadOnly = false;");
  for (const [id, value] of Object.entries({ 'f-company': 'New Company', 'f-role': 'New Role', 'f-stage': '1', 'f-type': 'Full-time', 'f-applied-date': '2026-10-08' })) element(id).value = value;
  return { context, run, setJobs, element, writes, additions, historyWrites, downloads, events };
}

test('rendering escapes stored fields, rejects executable URLs, and preserves raw data', () => {
  const f = fixture(), job = baseJob();
  job.role = '<img src=x onerror="bad()">'; job.notes = '</textarea><script>bad()</script>';
  job.color = 'red;position:fixed'; job.url = 'javascript:bad()'; job.attachments = [{ label: '" onfocus="bad()', url: 'data:text/html,bad' }];
  f.setJobs([job]); f.run("openNotes.add('j1'); render(); renderOverview();");
  const html = f.element('jobs-list').innerHTML;
  assert.ok(html.includes('&lt;img src=x onerror=&quot;bad()&quot;&gt;'));
  assert.ok(!html.includes('<script>bad()'));
  assert.ok(!html.includes('href="javascript:'));
  assert.ok(!html.includes('href="data:'));
  assert.ok(!html.includes('position:fixed'));
  assert.equal(f.run('jobs[0].role'), job.role);
  assert.ok(f.element('overview-list').innerHTML.includes('&lt;img'));
});

test('legacy documents without company or role render harmless defaults', () => {
  const f = fixture(); f.setJobs([{ firestoreId: 'legacy', archived: true }]);
  f.run("currentFilter = 'archived'; render();");
  assert.ok(f.element('jobs-list').innerHTML.includes('Untitled role'));
  assert.ok(f.element('jobs-list').innerHTML.includes('Unknown company'));
  assert.ok(!f.element('jobs-list').innerHTML.includes('undefined'));
});

test('profile documents are excluded from applications but retained in complete backups', async () => {
  const f = fixture();
  const documents = [
    { id: '__profile', data: () => ({ name: 'Profile by reserved ID' }) },
    { id: 'profile-alias', data: () => ({ _type: 'profile', name: 'Profile by type' }) },
    { id: 'legacy-job', data: () => ({ company: 'Legacy company', role: 'Legacy role', stage: 1 }) }
  ];
  f.run("loadJobs('owner')"); f.context.snapshot({ docs: documents });
  assert.equal(f.run('jobs.length'), 1);
  assert.equal(f.run('jobs[0].firestoreId'), 'legacy-job');
  assert.ok(!f.element('jobs-list').innerHTML.includes('Untitled role'));
  f.context.getDocs = async () => ({ docs: documents });
  await f.context.downloadBackup();
  const backup = JSON.parse(await f.downloads[0].text());
  assert.equal(backup.jobs.length, 3);
  assert.ok(backup.jobs.some(record => record.firestoreId === '__profile'));
  assert.ok(backup.jobs.some(record => record._type === 'profile'));
});

test('rapid edits keep both fields in stage data, notes, rounds, attachments and contacts', async () => {
  const f = fixture(); f.setJobs([baseJob()]);
  f.run(`updateStageField('j1',1,'appliedDate','2026-10-08'); updateStageField('j1',1,'resumeVersion','Resume A');
    updateStageNote('j1',1,'Applied note'); updateStageNote('j1',2,'Screen note');
    updateRound('j1',0,'with','Recruiter'); updateRound('j1',0,'date','2026-11-13T12:00');
    updateAtt('j1',0,'label','Resume'); updateAtt('j1',0,'url','https://example.test/resume');
    updateCont('j1',0,'name','Sam'); updateCont('j1',0,'title','Recruiter');`);
  assert.equal(await f.run('flushAllSaves()'), true);
  assert.equal(f.writes.length, 1);
  const fields = f.writes[0].fields;
  assert.equal(fields['stageData.1.appliedDate'], '2026-10-08');
  assert.equal(fields['stageData.1.resumeVersion'], 'Resume A');
  assert.equal(fields['stageNotes.1'], 'Applied note');
  assert.equal(fields['stageNotes.2'], 'Screen note');
  assert.equal(fields.interviewRounds[0].with, 'Recruiter');
  assert.equal(fields.interviewRounds[0].date, '2026-11-13T12:00');
  assert.deepEqual(fields.attachments[0], { label: 'Resume', url: 'https://example.test/resume' });
  assert.deepEqual(fields.contacts[0], { name: 'Sam', title: 'Recruiter' });
});

test('pending drafts survive snapshots and failed writes, then retry successfully', async () => {
  const f = fixture(); f.setJobs([baseJob()]);
  f.context.updateDoc = async () => { throw new Error('permission-denied'); };
  f.run("updateNote('j1','Keep this note'); loadJobs('owner');");
  f.context.snapshot({ docs: [{ id: 'j1', data: () => ({ ...baseJob(), notes: 'old server note' }) }] });
  assert.equal(f.run('jobs[0].notes'), 'Keep this note');
  assert.equal(await f.run('flushAllSaves()'), false);
  assert.equal(f.run("pendingFields.get('owner:j1').notes"), 'Keep this note');
  let warned = false; f.events.beforeunload({ preventDefault() { warned = true; } }); assert.equal(warned, true);
  f.context.updateDoc = async () => {};
  assert.equal(await f.run('flushAllSaves()'), true);
  assert.equal(f.run('draftFields.size'), 0);
});

test('failed Gmail update is never marked applied or reported as saved', async () => {
  const f = fixture(); f.setJobs([baseJob()]);
  f.run("gmailRenderedSuggestions = [{company:'Acme',suggestedStage:2}]; gmailHistoryStamp = 'fixture-scan';");
  f.context.getDoc = async () => ({ exists: () => true, data: () => ({ scannedAt: 'fixture-scan', suggestions: [{ company: 'Acme', suggestedStage: 2 }] }) });
  f.context.updateDoc = async () => { throw new Error('write failed'); };
  await f.run("applyGmailSuggestion('j1',2,0)");
  assert.equal(f.additions.length, 0);
  assert.ok(f.element('toast').textContent.startsWith('Save failed'));
});

test('failed add keeps form, retries same document, and captures the supplied application date', async () => {
  const f = fixture(); const attempts = [];
  f.context.setDoc = async (ref, job) => { attempts.push({ id: ref.id, job }); if (attempts.length === 1) throw new Error('offline'); };
  await f.context.addJob();
  assert.equal(f.element('f-company').value, 'New Company');
  assert.ok(f.element('jd-status').textContent.includes('still in this form'));
  let warned = false; f.events.beforeunload({ preventDefault() { warned = true; } }); assert.equal(warned, true);
  await f.context.addJob();
  assert.equal(attempts.length, 2); assert.equal(attempts[0].id, attempts[1].id);
  assert.equal(attempts[1].job.stageData[1].appliedDate, '2026-10-08');
  assert.equal(f.element('f-company').value, '');
});

test('double click creates one write and duplicate applications are rejected', async () => {
  const f = fixture(); let finish; let calls = 0;
  f.context.setDoc = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  const first = f.context.addJob(); await f.context.addJob(); assert.equal(calls, 1); finish(); await first;
  f.setJobs([{ ...baseJob(), company: 'New Company', role: 'New Role' }]);
  f.element('f-company').value = 'New Company'; f.element('f-role').value = 'New Role';
  await f.context.addJob(); assert.equal(calls, 1); assert.ok(f.element('jd-status').textContent.includes('already recorded'));
});

test('read-only handlers do not change state or write', async () => {
  const f = fixture(); f.setJobs([baseJob()]); f.run('isReadOnly = true');
  await f.context.W._adv('j1', 1, 3); await f.context.W._roundStatus('j1', 0, 'rejected');
  await f.context.addJob(); await f.context.adminRemoveUser('someone'); await f.context.downloadBackup();
  assert.equal(f.run('jobs[0].stage'), 1); assert.equal(f.writes.length, 0); assert.equal(f.additions.length, 0); assert.equal(f.downloads.length, 0);
});

test('a similar title without a URL can be a separate application after explicit confirmation', async () => {
  const f = fixture(); f.setJobs([{ ...baseJob(), company: 'New Company', role: 'New Role', loc: 'San Francisco' }]);
  f.element('f-loc').value = 'New York';
  let confirmations = 0; f.context.confirm = () => { confirmations++; return true; };
  await f.context.addJob();
  assert.equal(confirmations, 1); assert.equal(f.additions.length, 1); assert.equal(f.additions[0].data.loc, 'New York');
});

test('duplicate URL matching strips tracking only and preserves source/ref identifiers', async () => {
  const f = fixture(), match = f.context.TrackerSafety.applicationMatch;
  const a = { company: 'Acme', role: 'Director', url: 'https://example.test/job?ref=one&source=primary&utm_source=email' };
  assert.equal(match(a, { ...a, url: 'https://example.test/job?ref=one&source=primary&gh_src=tracking' }), 'exact-url');
  assert.equal(match(a, { ...a, url: 'https://example.test/job?ref=two&source=primary' }), null);
  assert.equal(match(a, { ...a, url: 'https://example.test/job?ref=one&source=second' }), null);
  f.setJobs([{ ...baseJob(), url: a.url }]);
  f.element('f-url').value = a.url; f.context.confirm = () => { throw new Error('Exact duplicate should not require fuzzy confirmation'); };
  await f.context.addJob();
  assert.equal(f.additions.length, 0); assert.ok(f.element('jd-status').textContent.includes('posting URL is already recorded'));
});

test('tracker and overview render fifty records initially, with working load more', () => {
  const f = fixture(); f.setJobs(Array.from({ length: 1000 }, (_, index) => baseJob('j' + index)));
  f.run('render(); renderOverview();');
  assert.equal((f.element('jobs-list').innerHTML.match(/class="job-card"/g) || []).length, 50);
  assert.equal((f.element('overview-list').innerHTML.match(/class="ov-card"/g) || []).length, 50);
  f.context.loadMoreJobs('tracker');
  assert.equal((f.element('jobs-list').innerHTML.match(/class="job-card"/g) || []).length, 100);
});

test('a snapshot does not replace the currently focused editor', () => {
  const f = fixture(); f.setJobs([baseJob()]); f.element('jobs-list').innerHTML = 'editor with selection';
  f.context.document.activeElement = { matches: () => true, closest: () => ({}) };
  f.run('render()'); assert.equal(f.element('jobs-list').innerHTML, 'editor with selection');
});

test('backdated Applied timers use the entered local calendar date', () => {
  const f = fixture(); f.setJobs([{ ...baseJob(), stageData: { 1: { appliedDate: '2026-10-08' } }, stageHistory: [{ stage: 1, ts: Date.now() }] }]);
  f.run("now = () => new Date('2026-11-12T12:00:00').getTime()");
  assert.equal(f.run('stageEnteredAt(jobs[0])'), new Date('2026-10-08T00:00:00').getTime());
  assert.ok(f.run("fmtDate('2026-10-08')").includes('Oct 8'));
  assert.equal(f.run('stageDuration(jobs[0], 1)'), f.run('totalTime(jobs[0])'));
});

test('switching owners clears an old failed add reference and rendered private records', async () => {
  const f = fixture(); let attemptedRef;
  f.context.setDoc = async ref => { attemptedRef = ref; throw new Error('offline'); };
  await f.context.addJob();
  const oldId = attemptedRef.id;
  f.element('jobs-list').innerHTML = 'old private application';
  f.context.getDoc = async () => ({ exists: () => true, data: () => ({ approved: true }) });
  f.context.setDoc = async () => {};
  await f.context.authCallback({ uid: 'second-owner', email: 'second@example.test', displayName: 'Second' });
  assert.equal(f.run('pendingAddRef'), null);
  assert.equal(f.element('f-company').value, '');
  assert.equal(f.element('jobs-list').innerHTML, '');
  f.element('f-company').value = 'Second Company'; f.element('f-role').value = 'Second Role';
  f.context.setDoc = async ref => { attemptedRef = ref; };
  await f.context.addJob();
  assert.notEqual(attemptedRef.id, oldId);
  assert.ok(JSON.stringify(attemptedRef.args).includes('second-owner'));
});

test('owner backup includes archived and malformed records with schema metadata', async () => {
  const f = fixture();
  f.context.getDocs = async () => ({ docs: [{ id: 'legacy', data: () => ({ archived: true }) }, { id: 'normal', data: () => baseJob() }] });
  await f.context.downloadBackup();
  const backup = JSON.parse(await f.downloads[0].text());
  assert.equal(backup.schemaVersion, 1); assert.equal(backup.ownerUid, 'owner'); assert.equal(backup.jobs.length, 2);
  assert.deepEqual(backup.jobs[0], { archived: true, firestoreId: 'legacy' });
});
