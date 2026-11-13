import { ApiError, fail, json, errorResponse, safeAiDiagnostic, config, requestJson, object, str, randomToken, sha256, upstream, requireOk, parseTokenResponse, GMAIL_SCOPE, GOOGLE_TOKEN_URL, GMAIL_BASE } from './common.mjs';
import { verifyFirebase, checkApproval, verifyGoogleIdentity } from './auth.mjs';
import { coordinate } from './coordinator.mjs';
import { validateExtraction, validateScan, extractJob, scanGmail } from './features.mjs';
export { SecurityCoordinator } from './coordinator.mjs';

const ROUTES = Object.freeze({ '/extract': 'extract', '/gmail/auth': 'auth', '/gmail/status': 'status', '/gmail/scan': 'scan', '/gmail/disconnect': 'disconnect', '/gmail/callback': 'callback' });
const GLOBAL = 'global-security-v2';
const userName = uid => `grants-v2:${uid}`;
const maintenance = () => fail(503, 'security_maintenance', 'This feature is temporarily paused while security controls are upgraded.');

export function createWorker(dependencies = {}) {
  const verify = dependencies.verifyFirebase || verifyFirebase;
  const approve = dependencies.checkApproval || checkApproval;
  const verifyGoogle = dependencies.verifyGoogleIdentity || verifyGoogleIdentity;
  const fetcher = dependencies.fetcher || ((...args) => fetch(...args));
  const storage = dependencies.coordinate || coordinate;
  const audit = dependencies.audit || (event => console.log(JSON.stringify(event)));
  async function checkToken(token, env, approval = true) {
    const identity = await verify(token, env);
    if (approval) await approve(identity, env, fetcher);
    return identity;
  }
  async function reserve(env, uid, action) { await storage(env, GLOBAL, '/rate', { uid, action }); }
  async function oauthStart(identity, env) {
    if (!identity.googleIds.length) fail(403, 'google_signin_required', 'Sign in to Job Tracker with Google before connecting Gmail.');
    if (!env.GMAIL_CLIENT_SECRET) fail(503, 'configuration_error', 'Gmail authorization is not configured.');
    const state = randomToken(), verifier = randomToken(), nonce = randomToken();
    const { epoch } = await storage(env, userName(identity.uid), '/begin');
    await storage(env, GLOBAL, '/state/create', { key: await sha256(state), record: { uid: identity.uid, email: identity.email, googleIds: identity.googleIds, token: identity.token, verifier, nonce, epoch, expiresAt: Date.now() + 300000 } });
    const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    auth.search = new URLSearchParams({ client_id: env.GMAIL_CLIENT_ID, redirect_uri: env.OAUTH_REDIRECT_URI, response_type: 'code', scope: `openid email ${GMAIL_SCOPE}`, access_type: 'offline', prompt: 'consent select_account', include_granted_scopes: 'false', login_hint: identity.email, state, nonce, code_challenge: await sha256(verifier), code_challenge_method: 'S256' });
    return { authUrl: auth.href };
  }
  async function oauthCallback(url, env) {
    let fresh, record, lease, googleSub, exchangeStarted = false, exchangeKnownFailed = false;
    try {
      // This is a bounded public entry point. The random single-use state is
      // the only way to recover the authenticated caller context.
      const allowed = ['state', 'code', 'error', 'error_description', 'scope', 'authuser', 'prompt', 'hd', 'iss'];
      if ([...url.searchParams.keys()].some(k => !allowed.includes(k) || url.searchParams.getAll(k).length !== 1) || url.search.length > 8192) fail(400, 'invalid_state', 'Invalid callback.');
      if (url.searchParams.has('iss') && url.searchParams.get('iss') !== 'https://accounts.google.com') fail(400, 'invalid_state', 'Invalid authorization issuer.');
      const state = url.searchParams.get('state');
      if (!/^[A-Za-z0-9_-]{43}$/.test(state || '')) fail(400, 'invalid_state', 'Invalid callback.');
      record = await storage(env, GLOBAL, '/state/consume', { key: await sha256(state) });
      await reserve(env, record.uid, 'callback');
      if (url.searchParams.has('error')) fail(400, 'authorization_denied', 'Google authorization was not completed.');
      const code = str(url.searchParams.get('code'), 4096, 1);
      const identity = await checkToken(record.token, env);
      if (identity.uid !== record.uid || identity.email !== record.email || !identity.googleIds.some(id => record.googleIds.includes(id))) fail(403, 'authorization_cancelled', 'The sign-in context changed.');
      lease = await storage(env, userName(record.uid), '/callback/claim', { epoch: record.epoch });
      exchangeStarted = true;
      const exchange = await upstream(GOOGLE_TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: env.GMAIL_CLIENT_ID, client_secret: env.GMAIL_CLIENT_SECRET, code, code_verifier: record.verifier, redirect_uri: env.OAUTH_REDIRECT_URI, grant_type: 'authorization_code' }) }, { fetcher, limit: 32768 });
      exchangeKnownFailed = exchange.status >= 400 && exchange.status < 500;
      const data = requireOk(exchange, 'oauth_exchange_failed');
      fresh = parseTokenResponse(data, { refreshRequired: true });
      googleSub = await verifyGoogle(data.id_token, record, env);
      const profile = requireOk(await upstream(`${GMAIL_BASE}/profile`, { headers: { Authorization: `Bearer ${fresh.accessToken}` } }, { fetcher, limit: 16384 }), 'gmail_unavailable');
      if (typeof profile.emailAddress !== 'string' || profile.emailAddress.toLowerCase() !== identity.email) fail(403, 'gmail_account_mismatch', 'Select the Google account used for Job Tracker.');
      const finished = await storage(env, userName(identity.uid), '/callback/finish', { id: lease.id, epoch: record.epoch, outcome: 'success', grant: { ...fresh, googleSub, email: identity.email } });
      lease = undefined;
      if (finished.cleanupRequired) await storage(env, userName(record.uid), '/disconnect');
      return { connected: finished.connected, ...(!finished.connected ? { errorCode: 'authorization_cancelled' } : {}) };
    } catch (error) {
      if (lease) {
        let outcome = !exchangeStarted || exchangeKnownFailed ? 'failed' : 'uncertain';
        let grant, revokeToken;
        if (fresh && googleSub) { grant = { ...fresh, googleSub, email: record.email }; outcome = 'failed'; }
        else if (fresh) {
          // Let the coordinator decide whether cleanup is still current. A late
          // mismatched callback must not revoke a newer successful connection.
          revokeToken = fresh.refreshToken; outcome = 'failed';
        }
        try {
          const finished = await storage(env, userName(record.uid), '/callback/finish', { id: lease.id, epoch: record.epoch, outcome, ...(grant ? { grant } : {}), ...(revokeToken ? { revokeToken } : {}) });
          if (finished.cleanupRequired) await storage(env, userName(record.uid), '/disconnect');
        } catch { /* Durable barriers remain for owner retry/recovery. */ }
      }
      return { connected: false, errorCode: error instanceof ApiError ? error.code : 'service_unavailable' };
    }
  }
  return {
    async fetch(request, env) {
      const started = Date.now(); let route = 'unknown', errorCode, diagnosticReason;
      let response;
      try {
        const url = new URL(request.url); route = ROUTES[url.pathname] ? url.pathname : 'unknown';
        const action = ROUTES[url.pathname];
        const origin = request.headers.get('Origin');
        if (origin && origin !== env.ALLOWED_ORIGIN) fail(403, 'origin_not_allowed', 'This origin is not allowed.');
        if (!action) fail(404, 'not_found', 'This endpoint does not exist.');
        if (request.method === 'OPTIONS') {
          if (origin !== env.ALLOWED_ORIGIN || request.headers.get('Access-Control-Request-Method') !== (action === 'callback' ? 'GET' : 'POST') || (request.headers.get('Access-Control-Request-Headers') || '').split(',').map(h => h.trim().toLowerCase()).filter(Boolean).some(h => !['authorization', 'content-type'].includes(h))) fail(403, 'origin_not_allowed', 'This preflight request is not allowed.');
          response = new Response(null, { status: 204 });
        } else {
          if (request.method !== (action === 'callback' ? 'GET' : 'POST')) fail(405, 'method_not_allowed', 'This endpoint does not support that request method.');
          if ((action === 'extract' ? env.ENABLE_EXTRACTION : env.ENABLE_GMAIL) !== 'true') maintenance();
          config(env);
          if (action === 'callback') {
            const result = await oauthCallback(url, env); errorCode = result.errorCode;
            const destination = new URL(env.APP_URL); destination.searchParams.set('gmail', result.connected ? 'connected' : 'error');
            response = new Response(null, { status: 303, headers: { Location: destination.href } });
          } else {
            if (url.search || url.hash) fail(400, 'invalid_input', 'Query parameters are not supported on this endpoint.');
            const authorization = request.headers.get('Authorization') || '';
            if (!/^Bearer [A-Za-z0-9_.-]+$/.test(authorization) || authorization.length > 16400) fail(401, 'authentication_required', 'Sign in to continue.');
            const body = await requestJson(request);
            if (action === 'extract') validateExtraction(body);
            else if (action === 'scan') validateScan(body);
            else if (action === 'auth') { object(body, ['consentToLink']); if (body.consentToLink !== true) fail(400, 'consent_required', 'Permission is required before connecting Gmail.'); }
            else if (action === 'disconnect') { object(body, ['confirmManualRevocation'], []); if (Object.hasOwn(body, 'confirmManualRevocation') && body.confirmManualRevocation !== true) fail(400, 'invalid_input', 'Manual revocation must be explicitly confirmed.'); }
            else object(body, []);
            // Owners retain the ability to revoke their own grant after losing
            // app approval. Every operation that reads mail or spends AI quota
            // requires current server-side approval.
            const identity = await checkToken(authorization.slice(7), env, action !== 'disconnect');
            await reserve(env, identity.uid, action);
            let result;
            if (action === 'extract') result = await extractJob(body, env, fetcher);
            else if (action === 'auth') result = await oauthStart(identity, env);
            else if (action === 'status') result = await storage(env, userName(identity.uid), '/status');
            else if (action === 'disconnect') result = await storage(env, userName(identity.uid), '/disconnect', body);
            else {
              const { accessToken } = await storage(env, userName(identity.uid), '/token');
              result = await scanGmail(body, accessToken, env, fetcher);
            }
            response = json(result);
          }
        }
      } catch (error) {
        errorCode = error instanceof ApiError ? error.code : 'service_unavailable';
        diagnosticReason = safeAiDiagnostic(error);
        response = errorResponse(error);
      }
      const headers = new Headers(response.headers);
      headers.set('Cache-Control', 'no-store'); headers.set('Referrer-Policy', 'no-referrer'); headers.set('X-Content-Type-Options', 'nosniff');
      headers.set('Vary', 'Origin');
      if (request.headers.get('Origin') === env.ALLOWED_ORIGIN) {
        headers.set('Access-Control-Allow-Origin', env.ALLOWED_ORIGIN); headers.set('Access-Control-Allow-Methods', 'POST, GET, OPTIONS'); headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      }
      if (response.status === 405) headers.set('Allow', route === '/gmail/callback' ? 'GET, OPTIONS' : 'POST, OPTIONS');
      if (response.status === 503) headers.set('Retry-After', '3600');
      // Never log full URLs: Google callback query strings contain credentials.
      audit({ event: 'job_tracker_request', route, status: response.status, ...(errorCode ? { errorCode } : {}), ...(diagnosticReason ? { diagnosticReason } : {}), durationMs: Date.now() - started });
      return new Response(response.body, { status: response.status, headers });
    }
  };
}
export default createWorker();
