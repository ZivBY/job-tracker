export class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
export const fail = (status, code, message) => { throw new ApiError(status, code, message); };
const AI_DIAGNOSTIC_REASONS = new Set(['envelope_shape', 'stop_refusal', 'stop_max_tokens', 'stop_unexpected', 'content_shape', 'json_syntax', 'job_shape', 'job_field', 'job_type', 'job_date', 'suggestion_root', 'suggestion_shape', 'suggestion_field', 'suggestion_stage', 'suggestion_evidence', 'suggestion_rounds']);
export function safeAiDiagnostic(error) {
  return error instanceof ApiError && error.code === 'invalid_ai_response' && AI_DIAGNOSTIC_REASONS.has(error.diagnosticReason) ? error.diagnosticReason : undefined;
}
export function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });
}
export function errorResponse(error) {
  return error instanceof ApiError
    ? json({ error: { code: error.code, message: error.message, ...(safeAiDiagnostic(error) ? { diagnosticReason: safeAiDiagnostic(error) } : {}) } }, error.status, error.status === 429 ? { 'Retry-After': '60' } : {})
    : json({ error: { code: 'service_unavailable', message: 'The service is temporarily unavailable.' } }, 503);
}
export function object(value, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k)) || required.some(k => !Object.hasOwn(value, k))) fail(400, 'invalid_input', 'The request contains invalid fields.');
  return value;
}
export function str(value, max, min = 0) {
  if (typeof value !== 'string' || value.length < min || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) fail(400, 'invalid_input', 'A text field is invalid or too long.');
  return value;
}
export const now = () => Date.now();
export const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const randomToken = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
export async function sha256(value) { return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))); }
export async function readLimited(response, limit, signal) {
  const length = response.headers.get('Content-Length');
  if (length && (!/^\d+$/.test(length) || Number(length) > limit)) {
    response.body?.cancel().catch(() => {});
    fail(413, 'body_too_large', 'The response is too large.');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = []; let count = 0;
  let abort;
  const interrupted = signal && new Promise((_, reject) => {
    abort = () => reject(new ApiError(504, 'upstream_timeout', 'A service took too long to respond.'));
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
  try {
    while (true) {
      const result = await (interrupted ? Promise.race([reader.read(), interrupted]) : reader.read());
      if (result.done) break;
      count += result.value.byteLength;
      if (count > limit) fail(413, 'body_too_large', 'The response is too large.');
      chunks.push(result.value);
    }
    const bytes = new Uint8Array(count); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } finally {
    if (abort) signal.removeEventListener('abort', abort);
    // Do not await cancellation of an untrusted, possibly stalled stream.
    reader.cancel().catch(() => {});
  }
}
export async function requestJson(request, limit = 32768) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') || '')) fail(415, 'unsupported_media_type', 'Send JSON with Content-Type application/json.');
  if (request.headers.get('Content-Encoding')) fail(415, 'unsupported_media_type', 'Compressed request bodies are not supported.');
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 5000);
  try { return JSON.parse(await readLimited(request, limit, controller.signal)); }
  catch (e) { if (e instanceof ApiError) throw e; fail(400, 'invalid_json', 'Send a valid JSON request.'); }
  finally { clearTimeout(timer); controller.abort(); }
}
export async function upstream(url, options = {}, { limit = 262144, timeout = 10000, fetcher = fetch } = {}) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetcher(url, { ...options, redirect: 'manual', signal: controller.signal });
    const text = await readLimited(response, limit, controller.signal);
    return { status: response.status, ok: response.ok, headers: response.headers, text };
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if (controller.signal.aborted) fail(504, 'upstream_timeout', 'A service took too long to respond.');
    fail(502, 'upstream_unavailable', 'A required service could not be reached.');
  } finally { clearTimeout(timer); controller.abort(); }
}
export function parseJson(result) {
  try { return JSON.parse(result.text); } catch { fail(502, 'invalid_upstream_response', 'A service returned an invalid response.'); }
}
export function requireOk(result, code = 'upstream_error') {
  if (!result.ok) fail(result.status === 429 ? 429 : 502, code, 'A service could not complete the request. Try again later.');
  return parseJson(result);
}
export function config(env) {
  const required = ['FIREBASE_PROJECT_ID', 'FIREBASE_ADMIN_EMAIL', 'GMAIL_CLIENT_ID', 'OAUTH_REDIRECT_URI', 'APP_URL', 'ALLOWED_ORIGIN'];
  for (const key of required) if (typeof env[key] !== 'string' || !env[key]) fail(503, 'configuration_error', 'The service is not configured.');
  const app = new URL(env.APP_URL), redirect = new URL(env.OAUTH_REDIRECT_URI);
  if (app.protocol !== 'https:' || redirect.protocol !== 'https:' || app.origin !== env.ALLOWED_ORIGIN || redirect.pathname !== '/gmail/callback' || redirect.search || redirect.hash || app.search || app.hash) fail(503, 'configuration_error', 'The service is not configured.');
  if (!/^[a-z0-9-]{3,63}$/.test(env.FIREBASE_PROJECT_ID)) fail(503, 'configuration_error', 'The service is not configured.');
  return env;
}
export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
export const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
export const GRANT_MAX_AGE = 90 * 86400000;
export function parseTokenResponse(data, { refreshRequired = false } = {}) {
  if (!data || typeof data.access_token !== 'string' || data.access_token.length < 1 || data.access_token.length > 8192 || data.token_type?.toLowerCase() !== 'bearer' || !Number.isInteger(data.expires_in) || data.expires_in < 60 || data.expires_in > 86400 || (refreshRequired && (typeof data.refresh_token !== 'string' || !data.refresh_token))) fail(502, 'invalid_token_response', 'Google did not return a usable authorization. Reconnect Gmail.');
  if (data.refresh_token !== undefined && (typeof data.refresh_token !== 'string' || data.refresh_token.length > 8192)) fail(502, 'invalid_token_response', 'Google returned an invalid authorization.');
  if (data.scope !== undefined && (typeof data.scope !== 'string' || !data.scope.split(' ').includes(GMAIL_SCOPE))) fail(403, 'gmail_scope_missing', 'Gmail read permission is required.');
  return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt: now() + data.expires_in * 1000 };
}
