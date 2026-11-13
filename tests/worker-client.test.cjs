const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('../worker-client.js');
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
function fixture() {
  let resolve;
  const pending = new Promise(r => { resolve = r; });
  const calls = [], state = { user: { uid: 'owner-a', getIdToken: async () => 'signed-fixture-token' }, revision: 1, readOnly: false };
  let handler = async () => response({ job: { company: 'Company', role: 'Role' } });
  const client = createClient({ origin: 'https://worker.example.test', session: () => state,
    fetch: async (url, options) => { calls.push({ url, options }); return handler(url, options); } });
  return { client, state, calls, pending, resolve, handle(fn) { handler = fn; } };
}
test('Worker requests use a fresh Firebase token and no caller UID, cookies, cache or referrer', async () => {
  const f = fixture();
  assert.equal((await f.client.request('/extract', { text: 'A job description' })).job.company, 'Company');
  const { url, options } = f.calls[0];
  assert.equal(url, 'https://worker.example.test/extract');
  assert.equal(options.headers.Authorization, 'Bearer signed-fixture-token');
  assert.deepEqual(JSON.parse(options.body), { text: 'A job description' });
  assert.equal(options.credentials, 'omit'); assert.equal(options.cache, 'no-store'); assert.equal(options.referrerPolicy, 'no-referrer');
});
test('anonymous, read-only, token-failed, and caller-UID requests never reach the Worker', async () => {
  for (const change of [s => { s.user = null; }, s => { s.readOnly = true; }, s => { s.user.getIdToken = async () => { throw new Error('sensitive SDK detail'); }; }]) {
    const f = fixture(); change(f.state);
    await assert.rejects(f.client.request('/extract', { text: 'description' }), { code: 'unauthenticated' });
    assert.equal(f.calls.length, 0);
  }
  const f = fixture();
  await assert.rejects(f.client.request('/gmail/status', { uid: 'someone-else' }), { code: 'invalid_request' });
  await assert.rejects(f.client.request('/unknown', {}), { code: 'invalid_request' });
  assert.equal(f.calls.length, 0);
});
test('switching accounts while the token loads prevents sending either account request', async () => {
  const f = fixture(); f.state.user.getIdToken = () => f.pending;
  const request = f.client.request('/gmail/status');
  f.state.user = { uid: 'owner-b', getIdToken: async () => 'other' }; f.state.revision++;
  f.resolve('old-token');
  await assert.rejects(request, { code: 'stale_session' }); assert.equal(f.calls.length, 0);
});
test('a response from an earlier auth revision is discarded even for the same UID', async () => {
  const f = fixture(); f.handle(() => f.pending);
  const request = f.client.request('/extract', { text: 'description' });
  await Promise.resolve(); f.state.revision++;
  f.resolve(response({ job: { company: 'Old private data' } }));
  await assert.rejects(request, { code: 'stale_session' });
});
test('maintenance and provider errors use safe messages and do not retry paid calls', async () => {
  for (const [body, status, code] of [[{ error: 'security_maintenance' }, 503, 'security_maintenance'], [{ error: { code: 'upstream_error', message: 'secret-provider-detail' } }, 502, 'upstream_error'], [{}, 401, 'unauthenticated']]) {
    const f = fixture(); f.handle(async () => response(body, status));
    await assert.rejects(f.client.request('/extract', { text: 'description' }), e => e.code === code && !e.message.includes('secret-provider-detail'));
    assert.equal(f.calls.length, 1);
  }
});
test('malformed extraction, model stages and disconnect results cannot become successful UI data', async () => {
  for (const [route, data] of [['/extract', { content: [{ text: 'raw model output' }] }], ['/extract', { job: { company: {}, url: 'javascript:alert(1)' } }], ['/gmail/scan', { suggestions: [{ suggestedStage: 50 }] }], ['/gmail/disconnect', {}]]) {
    const f = fixture(); f.handle(async () => response(data));
    await assert.rejects(f.client.request(route, {}), { code: 'invalid_response' });
  }
});
test('OAuth navigation only accepts an HTTPS Google account authorization URL', async () => {
  for (const url of ['https://attacker.test/oauth', 'https://accounts.google.com.attacker.test/', 'javascript:alert(1)', 'https://x@accounts.google.com/']) {
    const f = fixture(); f.handle(async () => response({ authUrl: url }));
    await assert.rejects(f.client.request('/gmail/auth', { consentToLink: true }), { code: 'invalid_response' });
  }
  const f = fixture(); f.handle(async () => response({ authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=fixture' }));
  assert.match((await f.client.request('/gmail/auth', { consentToLink: true })).authUrl, /^https:\/\/accounts\.google\.com\//);
});
test('reconnect-required status cannot be treated as connected and unknown model fields are dropped', async () => {
  const f = fixture(); f.handle(async () => response({ connected: true, reconnectRequired: true }));
  assert.deepEqual(await f.client.request('/gmail/status'), { connected: false, reconnectRequired: true, revocationPending: false, manualRevocationRequired: false });
  f.handle(async () => response({ suggestions: [{ company: 'Company', suggestedStage: 2, emailFrom: 'Recruiter', emailSubject: 'Next step', reason: 'Invitation', uid: 'forged', applied: true }] }));
  const s = (await f.client.request('/gmail/scan', { consentToAiProcessing: true })).suggestions[0];
  assert.equal(s.uid, undefined); assert.equal(s.applied, undefined);
});
test('owner-confirmed removal stays distinct from verified Google revocation', async () => {
  const f = fixture(); f.handle(async () => response({ success: true, revoked: false, confirmation: 'owner' }));
  await assert.rejects(f.client.request('/gmail/disconnect', {}), { code: 'invalid_response' });
  assert.deepEqual(await f.client.request('/gmail/disconnect', { confirmManualRevocation: true }), { success: true, revoked: false, confirmation: 'owner' });
  f.handle(async () => response({ success: true, revoked: true, confirmation: 'owner' }));
  await assert.rejects(f.client.request('/gmail/disconnect', { confirmManualRevocation: true }), { code: 'invalid_response' });
  f.handle(async () => response({ connected: false, manualRevocationRequired: 'yes' }));
  await assert.rejects(f.client.request('/gmail/status'), { code: 'invalid_response' });
});
