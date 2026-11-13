import { decodeProtectedHeader, importX509, jwtVerify, createRemoteJWKSet } from 'jose';
import { ApiError, fail, upstream, requireOk } from './common.mjs';

export const FIREBASE_CERTS = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
export const GOOGLE_JWKS = 'https://www.googleapis.com/oauth2/v3/certs';
export function createFirebaseKeyResolver(fetcher = fetch) {
  let keys = new Map(), expires = 0, lastAttempt = 0, pending;
  return async header => {
    if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.kid.length > 200 || header.jku || header.x5u || header.jwk) throw new Error('invalid header');
    const timestamp = Date.now();
    if (timestamp >= expires || !keys.has(header.kid)) {
      if (!pending && timestamp - lastAttempt > 30000) {
        lastAttempt = timestamp;
        pending = (async () => {
          const result = await upstream(FIREBASE_CERTS, {}, { fetcher, limit: 65536, timeout: 5000 });
          const certificates = requireOk(result);
          if (!certificates || Array.isArray(certificates) || Object.keys(certificates).length > 10) throw new Error('invalid certificates');
          const next = new Map();
          for (const [kid, certificate] of Object.entries(certificates)) next.set(kid, await importX509(certificate, 'RS256'));
          keys = next;
          const maxAge = Number(/(?:^|,)\s*max-age=(\d+)/i.exec(result.headers.get('Cache-Control') || '')?.[1] || 300);
          expires = Date.now() + Math.min(Math.max(maxAge, 30), 3600) * 1000;
        })().finally(() => { pending = undefined; });
      }
      if (pending) await pending;
    }
    if (Date.now() >= expires || !keys.has(header.kid)) throw new Error('unknown or expired key');
    return keys.get(header.kid);
  };
}
const firebaseKey = createFirebaseKeyResolver();
const googleKey = createRemoteJWKSet(new URL(GOOGLE_JWKS), { timeoutDuration: 5000, cooldownDuration: 30000, cacheMaxAge: 3600000 });

export async function verifyFirebase(token, env, resolver = firebaseKey) {
  try {
    if (typeof token !== 'string' || token.length > 16384) throw new Error();
    const header = decodeProtectedHeader(token);
    if (header.alg !== 'RS256' || !header.kid || header.jku || header.jwk || header.x5u) throw new Error();
    const { payload } = await jwtVerify(token, resolver, {
      algorithms: ['RS256'], issuer: `https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`,
      audience: env.FIREBASE_PROJECT_ID, requiredClaims: ['exp', 'iat', 'auth_time', 'sub', 'email', 'email_verified'], clockTolerance: 0
    });
    const seconds = Math.floor(Date.now() / 1000);
    if (payload.aud !== env.FIREBASE_PROJECT_ID || typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 128 || /[\x00-\x20/]/u.test(payload.sub) || !Number.isInteger(payload.iat) || payload.iat > seconds || !Number.isInteger(payload.auth_time) || payload.auth_time > seconds || payload.auth_time > payload.iat || payload.exp - payload.iat > 3700 || payload.email_verified !== true || typeof payload.email !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(payload.email) || payload.email.length > 254) throw new Error();
    const ids = payload.firebase?.identities?.['google.com'];
    return { uid: payload.sub, email: payload.email.toLowerCase(), googleIds: Array.isArray(ids) ? ids.filter(id => typeof id === 'string' && /^\d{1,64}$/.test(id)) : [], token };
  } catch { fail(401, 'invalid_token', 'Sign in again to continue.'); }
}
export async function checkApproval(identity, env, fetcher = fetch) {
  // Always call Firestore with the caller's token, including the administrator.
  // No service account can accidentally bypass the deployed security rules.
  const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/allowlist/${encodeURIComponent(identity.uid)}`;
  const result = await upstream(url, { headers: { Authorization: `Bearer ${identity.token}` } }, { fetcher, limit: 32768, timeout: 5000 });
  if (result.status === 401 || result.status === 403) fail(403, 'not_approved', 'This account is not approved for Job Tracker.');
  if (identity.email === env.FIREBASE_ADMIN_EMAIL.toLowerCase() && (result.ok || result.status === 404)) return;
  if (result.status === 404) fail(403, 'not_approved', 'This account is not approved for Job Tracker.');
  const data = requireOk(result, 'approval_unavailable');
  if (data.fields?.approved?.booleanValue !== true) fail(403, 'not_approved', 'This account is not approved for Job Tracker.');
}
export async function verifyGoogleIdentity(idToken, record, env, resolver = googleKey) {
  try {
    if (typeof idToken !== 'string' || idToken.length > 16384) throw new Error();
    const header = decodeProtectedHeader(idToken);
    if (header.alg !== 'RS256' || !header.kid || header.jku || header.x5u || header.jwk) throw new Error();
    const { payload } = await jwtVerify(idToken, resolver, {
      algorithms: ['RS256'], issuer: ['https://accounts.google.com', 'accounts.google.com'], audience: env.GMAIL_CLIENT_ID,
      requiredClaims: ['exp', 'iat', 'sub', 'nonce', 'email', 'email_verified'], clockTolerance: 0
    });
    if (payload.aud !== env.GMAIL_CLIENT_ID || (payload.azp && payload.azp !== env.GMAIL_CLIENT_ID) || payload.iat > Math.floor(Date.now() / 1000) || payload.nonce !== record.nonce || !record.googleIds.includes(payload.sub) || payload.email_verified !== true || typeof payload.email !== 'string' || payload.email.toLowerCase() !== record.email) throw new Error();
    return payload.sub;
  } catch { fail(403, 'gmail_account_mismatch', 'Select the same Google account used to sign in to Job Tracker.'); }
}
