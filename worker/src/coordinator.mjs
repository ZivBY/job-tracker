import { fail, json, errorResponse, randomToken, now, upstream, parseJson, parseTokenResponse, GOOGLE_TOKEN_URL, GOOGLE_REVOKE_URL, GRANT_MAX_AGE } from './common.mjs';

// Daily limits count reservations, including failed upstream attempts. There is
// no automatic paid retry or refund that could bypass these budgets.
export const LIMITS = Object.freeze({
  extract: { userMinute: 6, userDay: 40, globalMinute: 30, globalDay: 50 },
  scan: { userMinute: 1, userDay: 6, globalMinute: 5, globalDay: 10 },
  auth: { userMinute: 3, userDay: 10, globalMinute: 20, globalDay: 200 },
  status: { userMinute: 30, userDay: 1000, globalMinute: 300, globalDay: 10000 },
  disconnect: { userMinute: 3, userDay: 20, globalMinute: 30, globalDay: 200 },
  callback: { userMinute: 10, userDay: 500, globalMinute: 60, globalDay: 500 }
});
const DAY = 86400000;
const tokenFields = { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } };

// This class has no public route. Only the Worker binding can reach fetch().
// All correctness-critical read/modify/write operations are transactions; no
// eventual-consistency KV or in-memory lock is used for OAuth state or grants.
export class SecurityCoordinator {
  constructor(state, env) { this.state = state; this.storage = state.storage; this.env = env; }
  async fetch(request) {
    try {
      if (request.method !== 'POST') fail(405, 'method_not_allowed', 'POST required.');
      const body = await request.json();
      const path = new URL(request.url).pathname;
      switch (path) {
        case '/rate': return json(await this.rate(body));
        case '/state/create': return json(await this.createState(body));
        case '/state/consume': return json(await this.consumeState(body));
        case '/begin': return json(await this.begin());
        case '/callback/claim': return json(await this.claimCallback(body));
        case '/callback/finish': return json(await this.finishCallback(body));
        case '/status': return json(await this.status());
        case '/token': return json(await this.accessToken());
        case '/disconnect': return json(await this.disconnect(body));
        default: fail(404, 'not_found', 'Unknown internal operation.');
      }
    } catch (e) { return errorResponse(e); }
  }
  async ensureAlarm(delay = 15 * 60000) {
    // Alarms are only housekeeping; expiration is enforced synchronously too.
    await this.storage.transaction(async tx => {
      const existing = await tx.getAlarm();
      if (existing === null || existing > now() + delay) await tx.setAlarm(now() + delay);
    });
  }
  async rate({ uid, action }) {
    const policy = LIMITS[action];
    if (!policy || typeof uid !== 'string' || uid.length > 128) fail(400, 'invalid_input', 'Invalid quota request.');
    const timestamp = now(), minute = Math.floor(timestamp / 60000), day = Math.floor(timestamp / DAY);
    await this.storage.transaction(async tx => {
      const updates = [];
      for (const [key, minCap, dayCap] of [
        [`rate:${action}:global`, policy.globalMinute, policy.globalDay],
        [`rate:${action}:user:${uid}`, policy.userMinute, policy.userDay]
      ]) {
        const previous = await tx.get(key);
        const record = { minute, day, minuteCount: previous?.minute === minute ? previous.minuteCount : 0, dayCount: previous?.day === day ? previous.dayCount : 0, expiresAt: (day + 1) * DAY };
        if (record.minuteCount >= minCap || record.dayCount >= dayCap) fail(429, 'rate_limited', 'The request limit has been reached. Try again later.');
        record.minuteCount++; record.dayCount++; updates.push([key, record]);
      }
      for (const [key, record] of updates) await tx.put(key, record);
    });
    await this.ensureAlarm();
    return { reserved: true };
  }
  async createState({ key, record }) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(key) || !record?.uid || record.expiresAt <= now() || record.expiresAt > now() + 301000) fail(400, 'invalid_state', 'Invalid authorization state.');
    await this.storage.transaction(async tx => {
      if (await tx.get(`state:${key}`)) fail(409, 'state_conflict', 'Try connecting again.');
      await tx.put(`state:${key}`, record);
    });
    await this.ensureAlarm();
    return { created: true };
  }
  async consumeState({ key }) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(key)) fail(400, 'invalid_state', 'Authorization expired. Connect Gmail again.');
    const record = await this.storage.transaction(async tx => {
      const found = await tx.get(`state:${key}`);
      if (found) await tx.delete(`state:${key}`);
      return found;
    });
    if (!record || record.expiresAt <= now()) fail(400, 'invalid_state', 'Authorization expired or was already used. Connect Gmail again.');
    return record;
  }
  async begin() {
    return this.storage.transaction(async tx => {
      // A pending Google revocation must finish before a new grant is linked:
      // revoking the old refresh token could otherwise revoke the new grant.
      if (await tx.get('pendingRevocation') || await tx.get('callbackLease') || await tx.get('orphanPending')) fail(409, 'revocation_pending', 'Finish the pending connection or disconnection before reconnecting.');
      const epoch = (await tx.get('epoch') || 0) + 1;
      await tx.put('epoch', epoch);
      return { epoch };
    });
  }
  async claimCallback({ epoch }) {
    return this.storage.transaction(async tx => {
      if (await tx.get('epoch') !== epoch || await tx.get('pendingRevocation') || await tx.get('callbackLease') || await tx.get('orphanPending')) fail(409, 'authorization_cancelled', 'The connection was cancelled or superseded.');
      const lease = { id: randomToken(), epoch, deadline: now() + 90000, cancelled: false };
      await tx.put('callbackLease', lease);
      return { id: lease.id };
    });
  }
  async finishCallback({ id, epoch, grant, revokeToken, outcome }) {
    const result = await this.storage.transaction(async tx => {
      const lease = await tx.get('callbackLease');
      if (!['success', 'failed', 'uncertain'].includes(outcome) || typeof id !== 'string' || !id) fail(400, 'invalid_input', 'Invalid callback outcome.');
      if (grant && (!grant.refreshToken || !grant.accessToken || !grant.googleSub || !grant.email || !Number.isFinite(grant.expiresAt))) fail(400, 'invalid_grant', 'Invalid grant.');
      if (revokeToken !== undefined && (typeof revokeToken !== 'string' || !revokeToken || revokeToken.length > 8192)) fail(400, 'invalid_grant', 'Invalid revocation credential.');
      const cleanupToken = grant?.refreshToken || revokeToken;
      if (!lease || lease.id !== id) {
        // Manual recovery/grace is not proof an old callback stopped. Never
        // silently discard its new credential or revoke across a newer link.
        // This binding-only endpoint is called with the original leased ID.
        if (cleanupToken || outcome === 'uncertain') {
          const existing = await tx.get('grant');
          const previous = await tx.get('pendingRevocation');
          const retained = await tx.get('orphanCredentials') || [];
          const credentials = [...new Set([...retained, existing?.refreshToken, previous?.token, cleanupToken].filter(Boolean))];
          if (credentials.length) await tx.put('orphanCredentials', credentials);
          const token = cleanupToken || existing?.refreshToken || previous?.token;
          if (token) {
            await tx.put('pendingRevocation', { token, id: randomToken(), createdAt: now(), ...(previous?.leaseUntil ? { leaseUntil: previous.leaseUntil } : {}) });
          }
          // A late old token may already be invalid while a newer Google grant
          // remains live. No single-token revoke can certify all are gone.
          // Preserve all known credentials, inaccessible, for owner-confirmed
          // Google account removal; never automatically claim provider revoke.
          await tx.put('orphanPending', { unknown: true, deadline: now() + (cleanupToken ? 0 : 90000) });
          await tx.put('epoch', (await tx.get('epoch') || 0) + 1);
          await tx.delete('grant'); await tx.delete('refreshLease');
          if (lease) await tx.put('callbackLease', { ...lease, cancelled: true });
        }
        return { connected: false, revocationPending: Boolean(cleanupToken || outcome === 'uncertain'), lateCallback: true };
      }
      if (outcome === 'uncertain') {
        await tx.put('callbackLease', { ...lease, cancelled: true, uncertain: true });
        return { connected: false, revocationPending: true };
      }
      const current = await tx.get('epoch');
      if (outcome === 'success' && grant && current === epoch && !lease.cancelled && lease.deadline > now() && !await tx.get('pendingRevocation') && !await tx.get('orphanPending')) {
        await tx.put('grant', { ...grant, version: randomToken(), createdAt: now() });
        await tx.delete('refreshLease'); await tx.delete('callbackLease');
        return { connected: true };
      }
      // A disconnect during exchange cannot know the new token yet. Once it
      // arrives, retain it for revocation before allowing another connection.
      if (cleanupToken) {
        await tx.put('pendingRevocation', { token: cleanupToken, id: randomToken(), createdAt: now() });
        await tx.delete('grant'); await tx.delete('refreshLease');
        await tx.put('epoch', (current || 0) + 1);
      }
      await tx.put('lastCancelledCallback', { id, epoch, deadline: lease.deadline });
      await tx.delete('callbackLease');
      return { connected: false, cleanupRequired: Boolean(await tx.get('pendingRevocation')) };
    });
    if (result.connected) await this.ensureAlarm(GRANT_MAX_AGE);
    return result;
  }
  async status() {
    const grant = await this.storage.get('grant');
    const callback = await this.storage.get('callbackLease');
    const orphan = await this.storage.get('orphanPending');
    const pending = await this.storage.get('pendingRevocation');
    const connected = Boolean(grant && grant.createdAt + GRANT_MAX_AGE > now());
    const manualReady = Boolean(callback || orphan) && (!callback || callback.deadline <= now()) && (!orphan || orphan.deadline <= now()) && (!pending?.leaseUntil || pending.leaseUntil <= now());
    return { connected, reconnectRequired: !connected, revocationPending: Boolean(pending) || Boolean(orphan) || Boolean(callback && (callback.cancelled || callback.deadline <= now())), manualRevocationRequired: manualReady };
  }
  async accessToken() {
    const leaseId = randomToken();
    const result = await this.storage.transaction(async tx => {
      const callback = await tx.get('callbackLease');
      if (callback?.uncertain || (callback && callback.deadline <= now()) || await tx.get('orphanPending')) fail(409, 'revocation_pending', 'Finish disconnecting Gmail before scanning again.');
      const grant = await tx.get('grant');
      if (!grant || grant.createdAt + GRANT_MAX_AGE <= now()) fail(401, 'reconnect_required', 'Reconnect Gmail to continue.');
      if (grant.expiresAt > now() + 60000) return { ready: true, accessToken: grant.accessToken };
      const lease = await tx.get('refreshLease');
      if (lease?.expiresAt > now()) fail(409, 'request_in_progress', 'Gmail is refreshing. Try again shortly.');
      await tx.put('refreshLease', { id: leaseId, expiresAt: now() + 15000 });
      return { grant, epoch: await tx.get('epoch') };
    });
    if (result.ready) return { accessToken: result.accessToken };
    const { grant, epoch } = result;
    try {
      const response = await upstream(GOOGLE_TOKEN_URL, { ...tokenFields, body: new URLSearchParams({ client_id: this.env.GMAIL_CLIENT_ID, client_secret: this.env.GMAIL_CLIENT_SECRET, refresh_token: grant.refreshToken, grant_type: 'refresh_token' }) }, { limit: 32768 });
      const data = parseJson(response);
      if (!response.ok) {
        if (data?.error === 'invalid_grant') {
          await this.storage.transaction(async tx => {
            if ((await tx.get('grant'))?.version === grant.version) await tx.delete('grant');
          });
          fail(401, 'reconnect_required', 'Gmail authorization expired or was revoked. Reconnect Gmail.');
        }
        fail(response.status === 429 ? 429 : 502, 'gmail_refresh_failed', 'Gmail authorization could not be refreshed. Try again later.');
      }
      const fresh = parseTokenResponse(data);
      await this.storage.transaction(async tx => {
        if (await tx.get('epoch') !== epoch || (await tx.get('grant'))?.version !== grant.version || (await tx.get('refreshLease'))?.id !== leaseId) fail(409, 'authorization_cancelled', 'Gmail was disconnected or reconnected during this request.');
        await tx.put('grant', { ...grant, ...fresh, refreshToken: fresh.refreshToken || grant.refreshToken, version: randomToken() });
      });
      return { accessToken: fresh.accessToken };
    } finally {
      await this.storage.transaction(async tx => {
        if ((await tx.get('refreshLease'))?.id === leaseId) await tx.delete('refreshLease');
      });
    }
  }
  async disconnect({ confirmManualRevocation = false } = {}) {
    const pending = await this.storage.transaction(async tx => {
      const grant = await tx.get('grant'), previous = await tx.get('pendingRevocation');
      const callback = await tx.get('callbackLease');
      const orphan = await tx.get('orphanPending');
      if (confirmManualRevocation && (!callback || callback.deadline <= now()) && (!orphan || orphan.deadline <= now()) && (!previous?.leaseUntil || previous.leaseUntil <= now())) {
        await tx.put('epoch', (await tx.get('epoch') || 0) + 1);
        if (callback) await tx.put('lastCancelledCallback', { id: callback.id, epoch: callback.epoch, deadline: callback.deadline });
        await tx.delete('grant'); await tx.delete('refreshLease'); await tx.delete('callbackLease'); await tx.delete('pendingRevocation'); await tx.delete('orphanPending'); await tx.delete('orphanCredentials');
        return { manuallyConfirmed: true };
      }
      if (callback) {
        await tx.put('epoch', (await tx.get('epoch') || 0) + 1);
        await tx.put('callbackLease', { ...callback, cancelled: true });
        await tx.delete('grant'); await tx.delete('refreshLease');
        if (!previous && grant) await tx.put('pendingRevocation', { token: grant.refreshToken, id: randomToken(), createdAt: now() });
        return { callbackPending: true };
      }
      if (orphan?.unknown) return { callbackPending: true };
      if (previous?.leaseUntil > now()) fail(409, 'request_in_progress', 'Google revocation is already in progress. Try again shortly.');
      await tx.put('epoch', (await tx.get('epoch') || 0) + 1);
      await tx.delete('grant'); await tx.delete('refreshLease');
      const revoke = previous || (grant ? { token: grant.refreshToken, id: randomToken(), createdAt: now() } : null);
      if (revoke) { revoke.leaseUntil = now() + 30000; await tx.put('pendingRevocation', revoke); }
      return revoke;
    });
    if (pending?.callbackPending) fail(409, 'revocation_pending', 'Gmail is disconnected locally. A Google connection is still resolving; wait and retry. If it remains pending, remove Job Tracker in your Google account and confirm manual revocation.');
    if (pending?.manuallyConfirmed) return { success: true, revoked: false, confirmation: 'owner' };
    // The local grant is already inaccessible even if Google is unavailable.
    if (!pending) return { success: true, revoked: true };
    let response;
    try { response = await upstream(GOOGLE_REVOKE_URL, { ...tokenFields, body: new URLSearchParams({ token: pending.token }) }, { limit: 8192 }); }
    catch { fail(502, 'revocation_failed', 'Gmail is disconnected locally. Google revocation could not be confirmed. Retry Disconnect or remove access in your Google account.'); }
    // Google's invalid_token response means the presented token is no longer valid.
    let invalid = false;
    if (response.status === 400) { try { invalid = JSON.parse(response.text).error === 'invalid_token'; } catch {} }
    if (!response.ok && !invalid) fail(502, 'revocation_failed', 'Gmail is disconnected locally. Google revocation could not be confirmed. Retry Disconnect or remove access in your Google account.');
    const cleared = await this.storage.transaction(async tx => {
      if ((await tx.get('pendingRevocation'))?.id !== pending.id) return false;
      await tx.delete('pendingRevocation'); await tx.delete('orphanPending'); return true;
    });
    if (!cleared) fail(409, 'revocation_pending', 'Another authorization arrived during cleanup. Finish disconnecting Gmail before reconnecting.');
    return { success: true, revoked: true };
  }
  async alarm() {
    const timestamp = now(); let nextAlarm = Infinity;
    for (const prefix of ['state:', 'rate:']) {
      const rows = await this.storage.list({ prefix });
      for (const [key] of rows) {
        await this.storage.transaction(async tx => {
          const current = await tx.get(key);
          if (current?.expiresAt <= timestamp) await tx.delete(key);
          else if (current) nextAlarm = Math.min(nextAlarm, timestamp + 15 * 60000);
        });
      }
    }
    // Expired grants are never usable. Retain their refresh token as a pending
    // revocation, so an owner can still explicitly remove Google authorization.
    await this.storage.transaction(async tx => {
      const grant = await tx.get('grant');
      if (grant && grant.createdAt + GRANT_MAX_AGE <= timestamp) {
        if (!await tx.get('pendingRevocation')) await tx.put('pendingRevocation', { token: grant.refreshToken, id: randomToken(), createdAt: timestamp });
        await tx.delete('grant');
      } else if (grant) nextAlarm = Math.min(nextAlarm, grant.createdAt + GRANT_MAX_AGE);
    });
    if (Number.isFinite(nextAlarm)) await this.storage.setAlarm(nextAlarm);
  }
}

export async function coordinate(env, name, path, body = {}) {
  if (!env.SECURITY_COORDINATOR) fail(503, 'configuration_error', 'Security storage is not configured.');
  const stub = env.SECURITY_COORDINATOR.get(env.SECURITY_COORDINATOR.idFromName(name));
  const response = await stub.fetch(`https://internal${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) fail(response.status, data.error?.code || 'security_storage_error', data.error?.message || 'Security storage is unavailable.');
  return data;
}
