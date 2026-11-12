const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

process.env.TZ = 'America/Los_Angeles';
const html = fs.readFileSync(path.join(__dirname, '..', 'index_mobile.html'), 'utf8');

function sourceFunction(name) {
  const start = html.search(new RegExp('^(?:async )?function ' + name + '\\(', 'm'));
  assert.notEqual(start, -1, name + ' exists');
  const tail = html.slice(start);
  const next = tail.slice(1).search(/^(?:async )?function \w+\(/m);
  return next < 0 ? tail : tail.slice(0, next + 1);
}

function harness(names, overrides = {}) {
  const writes = [];
  const inputs = { 'f-company': 'Example Co', 'f-role': 'Operations Lead', 'f-stage': '1', 'f-applied-date': '2026-10-01', 'f-salary': '$180k' };
  const button = { disabled: false, textContent: '' };
  const state = { jobs: [], user: { uid: 'test-user' }, readOnly: false, expandedCompletedRounds: new Set(), addDraft: { 'f-company': 'Example Co' }, extractedPostDate: '2026-09-20', extractedSalary: '$180k', addingJob: false };
  const context = vm.createContext({
    state, writes, inputs, Date, Math, Set, Number, console: { error() {} },
    STAGES: ['Interested', 'Applied', 'Screen', 'Interview', 'Final round', 'Offer'], PALETTE: ['green'],
    value: id => inputs[id] || '', serverTimestamp: () => 1000,
    collection: (...parts) => parts, db: {},
    addDoc: async (ref, data) => { writes.push(data); },
    saveField: async (id, fields) => { writes.push(fields); return true; },
    render() {}, showToast() {}, setJdStatus() {},
    document: { querySelector: () => button, activeElement: null },
    ...overrides
  });
  for (const name of names) vm.runInContext(sourceFunction(name), context);
  return { context, state: context.state, writes, inputs, button };
}

const dateFunctions = ['isValidDateOnly', 'parseDateValue', 'startOfDay', 'fmtDateTime', 'formatEventDate', 'eventIsUpcoming'];

test('mobile module still parses after changes', () => {
  const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
  assert.doesNotThrow(() => new vm.Script(script.replace(/^import .*;\r?$/gm, '')));
});

test('double tap creates only one write and successful save clears extraction draft', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const written = [];
  const { context, state, button } = harness(['addJob', 'setAddButtonState', 'isValidDateOnly'], {
    addDoc: async (ref, data) => { written.push(data); await pending; }
  });
  const first = context.addJob();
  await context.addJob();
  assert.equal(written.length, 1);
  assert.equal(button.disabled, true);
  assert.equal(written[0].stageData[1].appliedDate, '2026-10-01');
  finish();
  await first;
  assert.equal(state.addingJob, false);
  assert.equal(button.disabled, false);
  assert.equal(state.extractedPostDate, null);
  assert.equal(state.extractedSalary, '');
  assert.equal(Object.keys(state.addDraft).length, 0);
});

test('failed add retains its draft and permits retry', async () => {
  let fail = true;
  const { context, state, button } = harness(['addJob', 'setAddButtonState', 'isValidDateOnly'], {
    addDoc: async () => { if (fail) throw new Error('offline'); }
  });
  await context.addJob();
  assert.equal(state.addDraft['f-company'], 'Example Co');
  assert.equal(state.extractedPostDate, '2026-09-20');
  assert.equal(button.disabled, false);
  fail = false;
  await context.addJob();
  assert.equal(Object.keys(state.addDraft).length, 0);
});

test('background extraction updates the retained draft without requiring Add DOM', () => {
  const { context, state } = harness(['fillForm'], { setValue() { throw new Error('should not touch hidden form'); } });
  state.tab = 'list';
  context.fillForm({ company: 'New Company', role: 'Director', salary: '$200k', postedDate: '2026-10-01' });
  assert.equal(state.addDraft['f-company'], 'New Company');
  assert.equal(state.addDraft['f-salary'], '$200k');
  context.fillForm({ company: 'Another Company', role: 'Manager' });
  assert.equal(state.addDraft['f-salary'], '');
  assert.equal(state.extractedPostDate, null);
});

test('unknown application dates remain unknown and invalid dates cannot be saved', async () => {
  const { context, inputs, writes } = harness(['addJob', 'setAddButtonState', 'isValidDateOnly']);
  inputs['f-applied-date'] = '2026-02-30';
  await context.addJob();
  assert.equal(writes.length, 0);
  inputs['f-applied-date'] = '';
  await context.addJob();
  assert.equal(writes[0].stageData[1].appliedDate, '');
});

test('terminal interview status can be undone without reopening other terminal rounds', async () => {
  const { context, state, writes } = harness(['setRoundStatus']);
  state.jobs = [{ firestoreId: 'job', rejected: true, endedAt: 10, interviewRounds: [{ status: 'rejected' }] }];
  await context.setRoundStatus('job', 0, 'rejected');
  assert.equal(writes[0].rejected, false);
  assert.equal(writes[0].declined, false);
  assert.equal(writes[0].endedAt, null);
  state.jobs[0].interviewRounds.push({ status: 'withdrew' });
  await context.setRoundStatus('job', 0, 'rejected');
  assert.equal(writes[1].declined, true);
  assert.equal(writes[1].endedAt, 10);
});

test('same-stage selection does not rewrite history or stale age', async () => {
  const { context, state, writes } = harness(['advanceStage']);
  state.jobs = [{ firestoreId: 'job', stage: 3, stageHistory: [{ stage: 3, ts: 100 }], interviewRounds: [] }];
  await context.advanceStage('job', 3);
  assert.equal(writes.length, 0);
  await context.advanceStage('job', 4);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].stageHistory.length, 2);
});

test('date-only deadline stays on its Pacific calendar day with no invented time', () => {
  const { context } = harness([...dateFunctions, 'pushEvent']);
  const events = [];
  context.pushEvent(events, {}, '2026-11-12', 'Offer deadline', 'deadline');
  assert.equal(events[0].date.getDate(), 12);
  assert.equal(events[0].date.getHours(), 0);
  assert.equal(events[0].allDay, true);
  assert.equal(context.formatEventDate(events[0]), 'Nov 12');
  assert.equal(context.eventIsUpcoming(events[0], new Date('2026-11-12T18:00:00').getTime()), true);
  assert.equal(context.eventIsUpcoming(events[0], new Date('2026-11-13T00:00:00').getTime()), false);
});

test('funnel excludes Interested and preserves historical success after rejection', () => {
  const { context } = harness(['reachedStage', 'buildProfileFunnel']);
  const funnel = context.buildProfileFunnel([{ stage: 0 }, { stage: 3, rejected: true }, { stage: 1, stageHistory: [{ stage: 5 }] }]);
  assert.equal(funnel[0].value, 2);
  assert.equal(funnel[2].value, 2);
  assert.equal(funnel[4].value, 1);
  assert.equal(context.buildProfileFunnel([])[0].pct, 0);
});

test('30-day profile does not substitute lifetime counts or fabricated trends', () => {
  const view = { innerHTML: '' };
  const { context, state } = harness([...dateFunctions, 'applicationTimestamp', 'reachedStage', 'averageDaysToReply', 'buildProfileFunnel', 'renderProfile'], {
    els: { view }, setHeader() {}, activeJobs: () => [], initials: () => 'U', getFirstName: () => 'User', esc: String,
    profileStat: (label, value, note) => `${label}: ${value} (${note})`, funnelRow: () => ''
  });
  const now = new Date();
  const recent = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  state.jobs = [{ stage: 1, stageData: { 1: { appliedDate: recent } } }, { stage: 1, stageData: { 1: { appliedDate: recent } } }, ...Array.from({ length: 5 }, () => ({ stage: 3, stageData: { 1: { appliedDate: '2020-01-01' } } }))];
  context.renderProfile();
  assert.match(view.innerHTML, /Applications: 2/);
  assert.match(view.innerHTML, /Reached screening: 0%/);
  assert.doesNotMatch(view.innerHTML, /250%|\+12pp|-2\.1|Daily 9 AM/);
});

test('snapshots defer Add draft and focused editor replacement', () => {
  const focused = { matches: () => true };
  const { context, state } = harness(['shouldDeferSnapshotRender'], { document: { activeElement: focused }, els: { view: { contains: () => true } } });
  state.tab = 'add';
  assert.equal(context.shouldDeferSnapshotRender(), true);
  state.tab = 'detail';
  assert.equal(context.shouldDeferSnapshotRender(), true);
  context.document.activeElement = null;
  assert.equal(context.shouldDeferSnapshotRender(), false);
});

test('read-only prep toggles never mutate the shared job', async () => {
  const { context, state, writes } = harness(['togglePrepTask']);
  state.readOnly = true;
  state.jobs = [{ firestoreId: 'job', prepChecklist: {} }];
  await context.togglePrepTask('job', 'research');
  assert.equal(Object.keys(state.jobs[0].prepChecklist).length, 0);
  assert.equal(writes.length, 0);
});

test('company domain uses a supplied web URL and never invents a website', () => {
  const { context } = harness(['companyDomain'], { URL });
  assert.equal(context.companyDomain({ company: 'Example Co' }), 'Website not provided');
  assert.equal(context.companyDomain({ url: 'javascript:alert(1)' }), 'Website not provided');
  assert.equal(context.companyDomain({ url: 'invalid-url' }), 'Website not provided');
  assert.equal(context.companyDomain({ url: 'https://www.example.com/jobs/123' }), 'example.com');
});

test('location preserves supplied geography and never assumes a country', () => {
  const { context } = harness(['shortLocation']);
  assert.equal(context.shortLocation('Remote'), 'Remote');
  assert.equal(context.shortLocation('Remote, Canada'), 'Remote, Canada');
  assert.equal(context.shortLocation('San Francisco, CA'), 'San Francisco, CA');
  assert.equal(context.shortLocation(''), 'Location not provided');
  assert.doesNotMatch(sourceFunction('renderProfile'), /SF Bay|<span class="pill">Remote<\/span>/);
});

test('backfilled application date remains distinct from the date added to tracker', () => {
  const { context } = harness([...dateFunctions, 'applicationTimestamp', 'timelineForJob'], { getEvents: () => [] });
  const enteredAt = new Date('2026-11-12T12:00:00').getTime();
  const timeline = context.timelineForJob({ firestoreId: 'job', stage: 1, role: 'Director',
    stageData: { 1: { appliedDate: '2026-10-08' } },
    stageHistory: [{ stage: 1, ts: enteredAt }], createdAt: { toMillis: () => enteredAt } });
  const applied = timeline.find(item => item.title === 'Applied');
  assert.equal(applied.date, 'Oct 8');
  assert.ok(timeline.find(item => item.title === 'Added to tracker'));
  assert.ok(timeline.find(item => item.title.startsWith('Stage recorded:')));
  assert.equal(timeline.filter(item => item.title === 'Applied').length, 1);
});

test('follow-up generation computes the event collection once for a large job list', () => {
  let eventReads = 0;
  const jobs = Array.from({ length: 1000 }, (_, i) => ({ firestoreId: String(i), company: 'Company ' + i, stage: 1, url: 'https://example.com/' + i, notes: 'Saved' }));
  const { context } = harness(['getActions', 'startOfDay'], {
    activeJobs: () => jobs,
    getEvents: () => { eventReads++; return []; },
    stageEnteredAt: () => Date.now() - 14 * 86400000,
    eventIsUpcoming: () => true
  });
  const actions = context.getActions();
  assert.equal(actions.length, 1000);
  assert.equal(eventReads, 1);
});
