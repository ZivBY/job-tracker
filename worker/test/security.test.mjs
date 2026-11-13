import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, SignJWT } from 'jose';
import { verifyFirebase, verifyGoogleIdentity, checkApproval, createFirebaseKeyResolver, FIREBASE_CERTS } from '../src/auth.mjs';
import { createWorker } from '../src/index.mjs';
import { ApiError, readLimited, requestJson, parseTokenResponse, sha256, GMAIL_SCOPE, errorResponse } from '../src/common.mjs';
import { JOB_SCHEMA, SUGGESTIONS_SCHEMA } from '../src/ai-schemas.mjs';
import { supportedUrl, fetchJobPage, extractJob, validateJob, validateSuggestions, scanGmail, validateScan, emailText } from '../src/features.mjs';

const { publicKey, privateKey } = await generateKeyPair('RS256');
const timestamp = Math.floor(Date.now() / 1000);
const env = { ENABLE_EXTRACTION: 'true', ENABLE_GMAIL: 'true', FIREBASE_PROJECT_ID: 'test-project', FIREBASE_ADMIN_EMAIL: 'admin@example.com', ALLOWED_ORIGIN: 'https://app.example.com', APP_URL: 'https://app.example.com/tracker/', GMAIL_CLIENT_ID: 'test-client', GMAIL_CLIENT_SECRET: 'fake-secret', OAUTH_REDIRECT_URI: 'https://worker.example.com/gmail/callback', ANTHROPIC_MODEL: 'test-model', ANTHROPIC_API_KEY: 'fake-ai-key' };
const claims = { iss: 'https://securetoken.google.com/test-project', aud: 'test-project', sub: 'uid-user-1', iat: timestamp, exp: timestamp + 3600, auth_time: timestamp - 10, email: 'User@example.com', email_verified: true, firebase: { identities: { 'google.com': ['123456'] } } };
const resolver = async header => { assert.equal(header.kid, 'test-key'); return publicKey; };
async function jwt(changes = {}, omissions = [], header = {}) {
  const payload = { ...claims, ...changes }; for (const field of omissions) delete payload[field];
  return new SignJWT(payload).setProtectedHeader({ alg: 'RS256', kid: 'test-key', ...header }).sign(privateKey);
}
const okJson = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const responseBody = async promise => { const response = await promise; return { status: response.status, data: await response.json(), headers: response.headers }; };

test('RSA signature plus exact Firebase claims derive UID/email/provider IDs', async () => {
  const id = await verifyFirebase(await jwt(), env, resolver);
  assert.equal(id.uid, 'uid-user-1'); assert.equal(id.email, 'user@example.com'); assert.deepEqual(id.googleIds, ['123456']);
});
for (const [name, changes, omissions, header] of [
  ['wrong issuer', { iss: 'https://evil.example.com' }], ['wrong audience', { aud: 'other-project' }], ['audience array', { aud: ['test-project', 'other-project'] }],
  ['expired', { exp: timestamp - 1 }], ['future issued-at', { iat: timestamp + 3600 }], ['future auth_time', { auth_time: timestamp + 3600 }], ['missing expiry', {}, ['exp']], ['missing auth_time', {}, ['auth_time']], ['unverified email', { email_verified: false }], ['empty subject', { sub: '' }], ['oversized subject', { sub: 'x'.repeat(129) }], ['path subject', { sub: 'attacker/other' }], ['missing email', {}, ['email']], ['long-lived token', { exp: timestamp + 7200 }], ['attacker key URL', {}, [], { jku: 'https://evil.example.com/jwks' }], ['unknown key', {}, [], { kid: 'other' }]
]) test(`Firebase rejects ${name}`, async () => { await assert.rejects(verifyFirebase(await jwt(changes, omissions, header), env, resolver), error => error.status === 401 && error.code === 'invalid_token'); });
test('Firebase rejects altered signature and symmetric JWT algorithm', async () => {
  const token = await jwt();
  await assert.rejects(verifyFirebase(token.slice(0, -8) + 'AAAAAAAA', env, resolver), { code: 'invalid_token' });
  const hs = await new SignJWT(claims).setProtectedHeader({ alg: 'HS256', kid: 'test-key' }).sign(new TextEncoder().encode('fake-test-secret-with-more-than-32-bytes'));
  await assert.rejects(verifyFirebase(hs, env, resolver), { code: 'invalid_token' });
});
test('certificate resolver ignores attacker-controlled URLs and pins Google endpoint', async () => {
  const calls = []; const resolve = createFirebaseKeyResolver(async url => { calls.push(url); return okJson({}); });
  await assert.rejects(resolve({ alg: 'RS256', kid: 'fake', jku: 'https://evil.example.com' })); assert.equal(calls.length, 0);
  await assert.rejects(resolve({ alg: 'RS256', kid: 'fake' })); assert.deepEqual(calls, [FIREBASE_CERTS]);
  await assert.rejects(resolve({ alg: 'RS256', kid: 'different' })); assert.equal(calls.length, 1, 'unknown kid cannot force unlimited certificate refetches');
});
test('approval uses caller token, checks current approved true and fails closed', async () => {
  const id = { uid: 'uid-user-1', token: 'fake-caller-token', email: 'user@example.com' };
  const calls = [];
  await checkApproval(id, env, async (url, options) => { calls.push([url, options.headers.Authorization]); return okJson({ fields: { approved: { booleanValue: true } } }); });
  assert.match(calls[0][0], /\/allowlist\/uid-user-1$/); assert.equal(calls[0][1], 'Bearer fake-caller-token');
  for (const response of [okJson({}, 404), okJson({ fields: { approved: { booleanValue: false } } }), okJson({}, 403)]) await assert.rejects(checkApproval(id, env, async () => response), { code: 'not_approved' });
  await assert.rejects(checkApproval(id, env, async () => okJson({ secret: 'do-not-echo' }, 500)), error => error.status === 502 && !error.message.includes('do-not-echo'));
});
test('Google ID token binds nonce, stable Google subject, exact client and verified email', async () => {
  const record = { nonce: 'nonce-1', googleIds: ['123456'], email: 'user@example.com' };
  const google = { iss: 'https://accounts.google.com', aud: 'test-client', sub: '123456', nonce: 'nonce-1', email: 'user@example.com', email_verified: true, iat: timestamp, exp: timestamp + 3600 };
  const make = values => new SignJWT({ ...google, ...values }).setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).sign(privateKey);
  assert.equal(await verifyGoogleIdentity(await make({}), record, env, resolver), '123456');
  for (const change of [{ nonce: 'wrong' }, { sub: 'attacker' }, { aud: 'another-client' }, { aud: ['test-client', 'another-client'] }, { email: 'wrong@example.com' }, { email_verified: false }, { azp: 'other-client' }, { exp: timestamp - 1 }]) await assert.rejects(verifyGoogleIdentity(await make(change), record, env, resolver), { code: 'gmail_account_mismatch' });
});

function harness(overrides = {}) {
  const calls = [], records = new Map(), events = [];
  const identity = { uid: 'verified-user', email: 'user@example.com', token: 'fake-token', googleIds: ['123456'] };
  const dependencies = {
    verifyFirebase: async token => { calls.push(['verify', token]); return identity; },
    checkApproval: async () => { calls.push(['approve']); },
    audit: event => events.push(event),
    coordinate: async (_, name, path, body) => {
      calls.push([name, path, body]);
      if (path === '/state/create') { records.set(body.key, body.record); return { created: true }; }
      if (path === '/state/consume') { const record = records.get(body.key); records.delete(body.key); if (!record) throw new ApiError(400, 'invalid_state', 'Invalid state.'); return record; }
      if (path === '/begin') return { epoch: 1 };
      if (path === '/callback/claim') return { id: 'fake-callback-lease' };
      if (path === '/callback/finish') return { connected: body.outcome === 'success' };
      if (path === '/status') return { connected: false, reconnectRequired: true };
      if (path === '/disconnect') return { success: true, revoked: true };
      if (path === '/token') return { accessToken: 'fake-access' };
      return { reserved: true };
    },
    fetcher: async () => { throw new Error('Unexpected external request'); },
    ...overrides
  };
  const worker = createWorker(dependencies);
  const request = (path, body = {}, extra = {}) => new Request(`https://worker.example.com${path}`, { method: 'POST', headers: { Origin: env.ALLOWED_ORIGIN, Authorization: 'Bearer fake-token', 'Content-Type': 'application/json', ...extra.headers }, body: JSON.stringify(body), ...Object.fromEntries(Object.entries(extra).filter(([key]) => key !== 'headers')) });
  return { worker, request, calls, records, events, identity };
}
test('all protected routes reject missing auth before storage or network', async () => {
  const h = harness();
  for (const path of ['/extract', '/gmail/auth', '/gmail/status', '/gmail/scan', '/gmail/disconnect']) {
    const r = await responseBody(h.worker.fetch(h.request(path, {}, { headers: { Authorization: '' } }), env)); assert.equal(r.status, 401);
  }
  assert.deepEqual(h.calls, []);
});
test('no unknown routes, legacy root fallback, wrong methods or hostile origin', async () => {
  const h = harness();
  for (const [request, status] of [[h.request('/'), 404], [h.request('/other'), 404], [new Request('https://worker.example.com/gmail/status'), 405], [h.request('/gmail/status', {}, { method: 'DELETE' }), 405], [h.request('/gmail/status', {}, { headers: { Origin: 'https://attacker.example.com' } }), 403]]) assert.equal((await h.worker.fetch(request, env)).status, status);
  assert.deepEqual(h.calls, []);
});
test('maintenance switches fail closed before credential, storage or network use', async () => {
  const h = harness();
  assert.equal((await h.worker.fetch(h.request('/extract'), { ...env, ENABLE_EXTRACTION: 'false' })).status, 503);
  assert.equal((await h.worker.fetch(h.request('/gmail/status'), { ...env, ENABLE_GMAIL: 'false' })).status, 503);
  assert.deepEqual(h.calls, []);
});
test('UID injection/unknown keys, no consent and ambiguous extraction rejected', async () => {
  const h = harness();
  for (const [path, body] of [['/gmail/status', { uid: 'victim' }], ['/gmail/disconnect', { uid: 'victim' }], ['/gmail/auth', { consentToLink: false }], ['/gmail/scan', { companies: [], consentToAiProcessing: false }], ['/extract', { text: 'x'.repeat(80), url: 'https://jobs.lever.co/example' }]]) assert.equal((await h.worker.fetch(h.request(path, body), env)).status, 400);
  assert.deepEqual(h.calls, []);
});
test('verified UID owns all storage, revoked app approval blocks scan but allows own revoke', async () => {
  const h = harness({ checkApproval: async () => { throw new ApiError(403, 'not_approved', 'Not approved.'); } });
  assert.equal((await h.worker.fetch(h.request('/gmail/status'), env)).status, 403);
  assert.equal((await h.worker.fetch(h.request('/gmail/disconnect'), env)).status, 200);
  assert(h.calls.some(([name, path]) => name === 'grants-v2:verified-user' && path === '/disconnect'));
});
test('OAuth generates unpredictable one-use state, S256 PKCE and OIDC nonce', async () => {
  const h = harness();
  const a = await responseBody(h.worker.fetch(h.request('/gmail/auth', { consentToLink: true }), env));
  const b = await responseBody(h.worker.fetch(h.request('/gmail/auth', { consentToLink: true }), env));
  assert.equal(a.status, 200);
  const url = new URL(a.data.authUrl), second = new URL(b.data.authUrl), state = url.searchParams.get('state');
  assert.match(state, /^[A-Za-z0-9_-]{43}$/); assert.notEqual(state, second.searchParams.get('state')); assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  const record = h.records.get(await sha256(state));
  assert.equal(await sha256(record.verifier), url.searchParams.get('code_challenge')); assert.equal(record.uid, 'verified-user'); assert.equal(record.nonce, url.searchParams.get('nonce')); assert(record.expiresAt - Date.now() <= 300000); assert(url.searchParams.get('scope').includes('openid email'));
  assert(!JSON.stringify(h.events).includes(state));
});
test('OAuth callback requires stored state and only commits matching bound identity', async () => {
  const fetchCalls = [];
  const h = harness({ verifyGoogleIdentity: async (_, record) => { assert.equal(record.googleIds[0], '123456'); return '123456'; }, fetcher: async (url, options) => { fetchCalls.push([url, options]); return url.includes('/token') ? okJson({ access_token: 'fake-new-access', refresh_token: 'fake-new-refresh', expires_in: 3600, token_type: 'Bearer', id_token: 'fake-google-id', scope: GMAIL_SCOPE }) : okJson({ emailAddress: 'user@example.com' }); } });
  const start = await responseBody(h.worker.fetch(h.request('/gmail/auth', { consentToLink: true }), env));
  const state = new URL(start.data.authUrl).searchParams.get('state');
  const callback = () => new Request(`https://worker.example.com/gmail/callback?state=${state}&code=fake-code&iss=https%3A%2F%2Faccounts.google.com`);
  const success = await h.worker.fetch(callback(), env);
  assert.equal(success.headers.get('Location'), 'https://app.example.com/tracker/?gmail=connected');
  assert.equal(fetchCalls[0][1].body.get('code_verifier').length, 43);
  assert(h.calls.some(([name, path, body]) => name === 'grants-v2:verified-user' && path === '/callback/finish' && body.grant.googleSub === '123456'));
  const replay = await h.worker.fetch(callback(), env);
  assert.equal(replay.headers.get('Location'), 'https://app.example.com/tracker/?gmail=error'); assert.equal(fetchCalls.length, 2);
  assert(!JSON.stringify(h.events).includes('fake-code')); assert(!JSON.stringify(h.events).includes(state));
});
test('OAuth callback rejects issuer mix-up before any state or provider access', async () => {
  const h = harness();
  const response = await h.worker.fetch(new Request(`https://worker.example.com/gmail/callback?state=${'a'.repeat(43)}&code=fake&iss=https%3A%2F%2Fevil.example`), env);
  assert.equal(response.headers.get('Location'), 'https://app.example.com/tracker/?gmail=error'); assert.equal(h.calls.length, 0);
});
test('fabricated OAuth states cannot consume valid-callback quota', async () => {
  const h = harness();
  for (let n = 0; n < 12; n++) {
    const state = `${String(n).padStart(2, '0')}${'a'.repeat(41)}`;
    await h.worker.fetch(new Request(`https://worker.example.com/gmail/callback?state=${state}&code=fake`), env);
  }
  assert.equal(h.calls.filter(([, path]) => path === '/state/consume').length, 12);
  assert.equal(h.calls.filter(([, path]) => path === '/rate').length, 0);
});
test('HTML-only Gmail preserves interview detail without attachments, scripts or fetches', () => {
  const encode = value => Buffer.from(value).toString('base64url');
  const html = { mimeType: 'text/html', body: { data: encode('<script>do bad things</script><p>Panel interview Tuesday at 10am.</p><img src="https://tracker.example/pixel">') } };
  assert.equal(emailText(html), 'Panel interview Tuesday at 10am.');
  assert.equal(emailText({ mimeType: 'multipart/alternative', parts: [html, { mimeType: 'text/plain', body: { data: encode('Preferred plain text') } }] }), 'Preferred plain text');
  assert.equal(emailText({ ...html, filename: 'attachment.html' }), '');
  assert.equal(emailText({ ...html, body: { data: encode('X'.repeat(4000)) } }).length, 2000);
});
test('CORS is exact and cache/log metadata contains no caller credential', async () => {
  const h = harness();
  const response = await h.worker.fetch(h.request('/gmail/status'), env);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), env.ALLOWED_ORIGIN); assert.equal(response.headers.get('Cache-Control'), 'no-store'); assert.equal(response.headers.get('Vary'), 'Origin'); assert(!JSON.stringify(h.events).includes('fake-token'));
  const preflight = new Request('https://worker.example.com/gmail/status', { method: 'OPTIONS', headers: { Origin: env.ALLOWED_ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type, authorization' } });
  assert.equal((await h.worker.fetch(preflight, env)).status, 204);
});
test('body size limits enforce streamed bytes, JSON type and no compressed body', async () => {
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(12)); controller.enqueue(new Uint8Array(12)); controller.close(); } });
  await assert.rejects(readLimited(new Response(body), 20), { code: 'body_too_large' });
  await assert.rejects(requestJson(new Request('https://test', { method: 'POST', body: '{}' })), { code: 'unsupported_media_type' });
  await assert.rejects(requestJson(new Request('https://test', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }, body: '{}' })), { code: 'unsupported_media_type' });
});
test('URL allowlist rejects private, alternate protocols, userinfo, ports and deceptive names', () => {
  for (const url of ['http://jobs.lever.co/x', 'https://127.0.0.1/x', 'https://[::1]/', 'https://169.254.169.254/', 'https://localhost/', 'https://jobs.lever.co.evil.example/x', 'https://jobs.lever.co./x', 'https://user:pass@jobs.lever.co/x', 'https://jobs.lever.co:8443/x', 'file:///etc/passwd', 'https://arbitrary-company.example/careers']) assert.throws(() => supportedUrl(url), { code: 'unsupported_url' });
  assert.equal(supportedUrl('https://jobs.lever.co/example/role').hostname, 'jobs.lever.co');
});
test('each redirect is validated before fetching; no credential headers forwarded', async () => {
  const calls = [];
  await assert.rejects(fetchJobPage('https://jobs.lever.co/company/role', async (url, options) => { calls.push([url, options]); return new Response('', { status: 302, headers: { Location: 'https://127.0.0.1/private' } }); }), { code: 'unsupported_url' });
  assert.equal(calls.length, 1); assert.equal(calls[0][1].redirect, 'manual'); assert.equal(calls[0][1].headers.Authorization, undefined);
});
test('redirect loops are bounded and HTML scripts never become model input', async () => {
  let count = 0;
  await assert.rejects(fetchJobPage('https://jobs.lever.co/company', async () => { count++; return new Response('', { status: 302, headers: { Location: '/company' } }); }), { code: 'page_unavailable' }); assert.equal(count, 4);
  const page = await fetchJobPage('https://jobs.lever.co/company', async () => new Response(`<script>secret script</script><p>${'Description '.repeat(20)}</p>`, { headers: { 'Content-Type': 'text/html' } }));
  assert(!page.text.includes('secret script'));
});
const job = { company: 'Example', role: 'Manager', location: 'Remote', type: 'Full-time', url: 'https://evil.example', postedDate: '', salary: '' };
test('job output schema excludes injected keys, invented URLs, invalid dates and arrays', () => {
  assert.equal(validateJob(job, 'https://jobs.lever.co/example').url, 'https://jobs.lever.co/example');
  for (const data of [{ ...job, exploit: true }, { ...job, postedDate: '2026-02-30' }, { ...job, type: 'Unknown' }, { ...job, salary: {} }, []]) assert.throws(() => validateJob(data, ''), { code: 'invalid_ai_response' });
});
test('AI failures/truncation/provider errors cannot masquerade as successful extraction', async () => {
  const body = { text: 'A real job description '.repeat(10) };
  for (const reply of [okJson({ secret: 'upstream-sensitive-detail' }, 500), okJson({ stop_reason: 'max_tokens', content: [{ type: 'text', text: JSON.stringify(job) }] }), okJson({ stop_reason: 'end_turn', content: [{ type: 'text', text: '```json {} ```' }] })]) await assert.rejects(extractJob(body, env, async () => reply), error => !error.message.includes('upstream-sensitive-detail') && error.status === 502);
  const success = await extractJob(body, env, async (_, options) => { const input = JSON.parse(options.body); assert.equal(input.max_tokens, 800); assert(!JSON.stringify(input).includes('fake-ai-key')); return okJson({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(job) }] }); });
  assert.equal(success.job.company, 'Example'); assert.equal(success.job.url, '');
});
test('synthetic extraction requests native JSON grammar and preserves the supplied facts', async () => {
  const synthetic = 'Synthetic Test Company is hiring an Operations Manager in San Francisco, CA. Full-time. Posted November 13, 2026. Salary USD 120,000 to 150,000.';
  const result = await extractJob({ text: synthetic }, env, async (url, options) => {
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    const request = JSON.parse(options.body);
    assert.deepEqual(request.output_config, { format: { type: 'json_schema', schema: JOB_SCHEMA } });
    assert.equal(request.output_format, undefined, 'deprecated beta parameter is not sent');
    assert.equal(options.headers['anthropic-beta'], undefined);
    assert.equal(request.max_tokens, 800);
    assert.equal(JSON.parse(request.messages[0].content).text, synthetic);
    return okJson({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ company: 'Synthetic Test Company', role: 'Operations Manager', location: 'San Francisco, CA', type: 'Full-Time', url: '', postedDate: '2026-11-13', salary: 'USD 120,000 to 150,000' }) }] });
  });
  assert.deepEqual(result.job, { company: 'Synthetic Test Company', role: 'Operations Manager', location: 'San Francisco, CA', type: 'Full-time', url: '', postedDate: '2026-11-13', salary: 'USD 120,000 to 150,000' });
});
test('schema-enforced suggestions preserve evidence and canonicalize only recognized round labels', async () => {
  const calls = [];
  const response = await scanGmail({ companies: [{ company: 'Synthetic Test Company', currentStage: 1 }], consentToAiProcessing: true }, 'fake-access', env, async (url, options) => {
    calls.push(url);
    if (url.includes('/messages?')) return okJson({ messages: [{ id: 'fake-message' }] });
    if (url.includes('/messages/fake-message?')) return okJson({ payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'synthetic-recruiter@example.invalid' }, { name: 'Subject', value: 'Synthetic interview invitation' }], body: { data: Buffer.from('You are invited to a phone screen with Synthetic Test Company.').toString('base64url') } } });
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    const request = JSON.parse(options.body);
    assert.deepEqual(request.output_config, { format: { type: 'json_schema', schema: SUGGESTIONS_SCHEMA } });
    assert.equal(request.max_tokens, 2000);
    return okJson({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify([{ company: 'Synthetic Test Company', suggestedStage: 2, reason: 'Phone screen invitation', emailIndex: 0, interviewRounds: [{ type: 'Phone Screen', notes: 'Invitation received' }] }]) }] });
  });
  assert.equal(calls.length, 3);
  assert.deepEqual(response.suggestions[0], { company: 'Synthetic Test Company', suggestedStage: 2, reason: 'Phone screen invitation', emailFrom: 'synthetic-recruiter@example.invalid', emailSubject: 'Synthetic interview invitation', interviewRounds: [{ type: 'Phone screen', notes: 'Invitation received' }] });
  assert.throws(() => validateJob({ ...job, type: 'Fulltime' }, ''), { code: 'invalid_ai_response', diagnosticReason: 'job_type' });
  assert.throws(() => validateSuggestions([{ company: 'Example', suggestedStage: 2, reason: 'Invitation', emailIndex: 0, interviewRounds: [{ type: 'Unrecognized meeting', notes: '' }] }], [{ from: '', subject: '' }]), { diagnosticReason: 'suggestion_rounds' });
});
test('native schemas exclude unsupported bound keywords and close every object', () => {
  function inspect(schema) {
    for (const keyword of ['minimum', 'maximum', 'multipleOf', 'minLength', 'maxLength', 'maxItems', 'minItems', '$ref']) assert.equal(Object.hasOwn(schema, keyword), false, keyword);
    if (schema.type === 'object') { assert.equal(schema.additionalProperties, false); assert.deepEqual(schema.required, Object.keys(schema.properties)); Object.values(schema.properties).forEach(inspect); }
    if (schema.type === 'array') inspect(schema.items);
  }
  inspect(JOB_SCHEMA); inspect(SUGGESTIONS_SCHEMA);
  assert.throws(() => validateJob({ ...job, role: 'x'.repeat(301) }, ''), { diagnosticReason: 'job_field' }, 'unsupported grammar bounds remain locally enforced');
  assert.throws(() => validateSuggestions(Array.from({ length: 11 }, () => ({})), []), { diagnosticReason: 'suggestion_root' });
});
test('AI protocol failures expose only constant structural diagnostics, with no raw provider content', async () => {
  const sensitive = 'synthetic-private@example.invalid fake-secret-token';
  for (const [data, expected] of [
    [null, 'envelope_shape'],
    [{ stop_reason: 'refusal', content: [{ type: 'text', text: sensitive }] }, 'stop_refusal'],
    [{ stop_reason: 'max_tokens', content: [{ type: 'text', text: sensitive }] }, 'stop_max_tokens'],
    [{ stop_reason: 'unknown-private-value', content: [] }, 'stop_unexpected'],
    [{ stop_reason: 'end_turn', content: [null] }, 'content_shape'],
    [{ stop_reason: 'end_turn', content: [{ type: 'text', text: '```json\n' + JSON.stringify(job) + '\n```' }] }, 'json_syntax'],
    [{ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ ...job, privateField: sensitive }) }] }, 'job_shape'],
    [{ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ ...job, postedDate: '2026-02-30' }) }] }, 'job_date']
  ]) {
    const h = harness({ fetcher: async () => okJson(data) });
    const result = await responseBody(h.worker.fetch(h.request('/extract', { text: 'Synthetic job description '.repeat(6) }), env));
    assert.equal(result.status, 502); assert.equal(result.data.error.code, 'invalid_ai_response');
    assert.equal(result.data.error.diagnosticReason, expected); assert.equal(h.events[0].diagnosticReason, expected);
    const serialized = JSON.stringify({ response: result.data, events: h.events });
    assert(!serialized.includes(sensitive)); assert(!serialized.includes('unknown-private-value')); assert(!serialized.includes('fake-ai-key'));
  }
  const forged = new ApiError(502, 'invalid_ai_response', 'Safe fixed message'); forged.diagnosticReason = sensitive;
  assert.equal((await errorResponse(forged).json()).error.diagnosticReason, undefined, 'diagnostic allowlist blocks arbitrary values');
});
test('Gmail output sender/subject come from source evidence; malformed suggestion rejected', () => {
  const emails = [{ from: 'recruiter@example.com', subject: 'Interview' }];
  const candidate = { company: 'Example', suggestedStage: 3, reason: 'Invitation', emailIndex: 0, interviewRounds: [] };
  assert.equal(validateSuggestions([candidate], emails)[0].emailFrom, emails[0].from);
  for (const value of [{ ...candidate, emailIndex: 3 }, { ...candidate, suggestedStage: 9 }, { ...candidate, emailFrom: 'invented' }]) assert.throws(() => validateSuggestions([value], emails), { code: 'invalid_ai_response' });
});
test('Gmail scope/refresh token schemas fail closed', () => {
  assert.throws(() => parseTokenResponse({ access_token: 'x', token_type: 'Bearer', expires_in: 3600 }, { refreshRequired: true }), { code: 'invalid_token_response' });
  assert.throws(() => parseTokenResponse({ access_token: 'x', token_type: 'Bearer', expires_in: 3600, scope: 'openid' }), { code: 'gmail_scope_missing' });
});
test('scan requires explicit consent and Gmail errors never return empty success', async () => {
  assert.throws(() => validateScan({ companies: [], consentToAiProcessing: false }), { code: 'consent_required' });
  const body = { companies: [], consentToAiProcessing: true };
  await assert.rejects(scanGmail(body, 'fake-access', env, async () => okJson({ error: 'denied' }, 403)), { code: 'reconnect_required' });
  await assert.rejects(scanGmail(body, 'fake-access', env, async () => okJson({ error: 'down' }, 500)), { code: 'gmail_unavailable' });
  assert.deepEqual(await scanGmail(body, 'fake-access', env, async () => okJson({ resultSizeEstimate: 0 })), { suggestions: [] });
});
