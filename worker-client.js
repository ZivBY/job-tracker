(function (root) {
  'use strict';
  const messages = {
    security_maintenance: 'Gmail sync and job extraction are temporarily paused while access controls are upgraded.',
    unauthenticated: 'Your session could not be verified. Sign in again and retry.',
    authentication_required: 'Sign in to use this feature.',
    invalid_token: 'Your session could not be verified. Sign in again and retry.',
    unauthorized: 'Your session could not be verified. Sign in again and retry.',
    forbidden: 'This account does not have permission to use this feature.',
    not_approved: 'This account does not have permission to use this feature.',
    not_connected: 'Connect Gmail before scanning.',
    reconnect_required: 'Reconnect Gmail to replace the older connection securely.',
    gmail_account_mismatch: 'Reconnect with the same Google account used to sign in to this tracker.',
    gmail_scope_missing: 'Reconnect Gmail and grant read-only mail access to use scanning.',
    google_signin_required: 'Sign in with Google to connect Gmail.',
    authorization_cancelled: 'Google authorization was canceled. Connect again when you are ready.',
    gmail_refresh_failed: 'The Gmail connection expired. Reconnect Gmail before scanning.',
    gmail_unavailable: 'Gmail could not complete this request. Try again later.',
    request_in_progress: 'A request is already in progress. Wait a moment and retry.',
    revocation_pending: 'Finish disconnecting Gmail before connecting again.',
    oauth_exchange_failed: 'Google could not complete the connection. Reconnect Gmail.',
    invalid_token_response: 'Google did not return a usable connection. Reconnect Gmail.',
    revocation_failed: 'The tracker link was removed, but Google access revocation could not be confirmed. Review this app in your Google account permissions.',
    consent_required: 'Review the privacy notice and select the consent checkbox first.',
    rate_limited: 'The request limit was reached. Wait a moment and retry.',
    invalid_request: 'Check the supplied details and try again.',
    invalid_input: 'Check the supplied details and try again.',
    body_too_large: 'The supplied content is too large. Paste a shorter job description.',
    unsupported_url: 'This job site is not supported. Paste the job description text instead.',
    invalid_url: 'Use a supported HTTPS job URL or paste the job description text.',
    upstream_error: 'The provider could not complete this request. Try again later.',
    upstream_unavailable: 'The provider could not complete this request. Try again later.',
    service_unavailable: 'The service is temporarily unavailable. Try again later.',
    configuration_error: 'This feature is not configured yet. Try again after setup is complete.',
    invalid_upstream_response: 'The provider returned an unexpected response. Try again later.',
    invalid_ai_response: 'The AI provider returned an unexpected result. No job changes were applied.',
    ai_unavailable: 'The AI provider is temporarily unavailable. Try again later.',
    ai_input_too_large: 'This content is too large to process. Use a shorter job description or enter the updates manually.',
    page_unavailable: 'The posting could not be read. Paste the job description text instead.',
    upstream_timeout: 'The provider took too long to respond. Try again later.',
    provider_error: 'The provider could not complete this request. Try again later.',
    invalid_response: 'The service returned an unexpected response. Your existing data is unchanged.',
    timeout: 'The request took too long. Try again later.',
    network_error: 'Could not reach the service. Check your connection and retry.',
    stale_session: 'Your account changed. Retry from the current account.'
  };
  function error(code, status) {
    const e = new Error(messages[code] || 'The service could not complete this request. Try again later.');
    e.code = code; e.status = status || 0; return e;
  }
  function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
  function string(value, maximum = 4000) { return typeof value === 'string' && value.length <= maximum; }
  function validate(route, data, body = {}) {
    if (!object(data)) throw error('invalid_response');
    if (route === '/extract') {
      if (!object(data.job)) throw error('invalid_response');
      const job = {};
      for (const key of ['company', 'role', 'location', 'industry', 'type', 'url', 'postedDate', 'salary']) {
        if (data.job[key] == null) continue;
        if (!string(data.job[key])) throw error('invalid_response');
        job[key] = data.job[key];
      }
      if (job.url) { let url; try { url = new URL(job.url); } catch { throw error('invalid_response'); }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw error('invalid_response'); }
      return { job };
    }
    if (route === '/gmail/status') {
      if (typeof data.connected !== 'boolean' || ['reconnectRequired', 'revocationPending', 'manualRevocationRequired'].some(key => data[key] !== undefined && typeof data[key] !== 'boolean')) throw error('invalid_response');
      return { connected: data.connected && !data.reconnectRequired && !data.revocationPending && !data.manualRevocationRequired, reconnectRequired: !!data.reconnectRequired, revocationPending: !!data.revocationPending, manualRevocationRequired: !!data.manualRevocationRequired };
    }
    if (route === '/gmail/auth') {
      let url; try { url = new URL(data.authUrl); } catch { throw error('invalid_response'); }
      if (url.protocol !== 'https:' || url.hostname !== 'accounts.google.com' || url.username || url.password || url.port) throw error('invalid_response');
      return { authUrl: url.href };
    }
    if (route === '/gmail/scan') {
      if (!Array.isArray(data.suggestions) || data.suggestions.length > 30) throw error('invalid_response');
      const suggestions = data.suggestions.map(s => {
        if (!object(s) || !Number.isInteger(s.suggestedStage) || s.suggestedStage < 0 || s.suggestedStage > 5) throw error('invalid_response');
        const result = { suggestedStage: s.suggestedStage };
        for (const key of ['company', 'emailFrom', 'emailSubject', 'reason']) {
          if (!string(s[key])) throw error('invalid_response');
          result[key] = s[key];
        }
        if (s.interviewRounds !== undefined) {
          if (!Array.isArray(s.interviewRounds) || s.interviewRounds.length > 20) throw error('invalid_response');
          result.interviewRounds = s.interviewRounds.map(r => {
            if (!object(r) || !string(r.type || '') || !string(r.notes || '')) throw error('invalid_response');
            return { type: r.type || '', notes: r.notes || '' };
          });
        }
        return result;
      });
      return { suggestions };
    }
    if (route === '/gmail/disconnect') {
      if (data.success !== true) throw error('invalid_response');
      if (data.confirmation === 'owner' && data.revoked === false && body.confirmManualRevocation === true) return { success: true, revoked: false, confirmation: 'owner' };
      if (data.revoked !== true || data.confirmation !== undefined || data.revocationMethod !== undefined) throw error('invalid_response');
      return { success: true, revoked: true };
    }
    return data;
  }
  function createClient({ origin, session, fetch: fetcher, timeoutMs = 90000 }) {
    const routes = new Set(['/extract', '/gmail/status', '/gmail/auth', '/gmail/scan', '/gmail/disconnect']);
    function capture() {
      const current = session();
      if (!current.user || current.readOnly || typeof current.user.getIdToken !== 'function') throw error('unauthenticated');
      return { user: current.user, uid: current.user.uid, revision: current.revision };
    }
    function isCurrent(owner) {
      const current = session();
      return !!owner && !current.readOnly && current.user === owner.user && current.user?.uid === owner.uid && current.revision === owner.revision;
    }
    async function request(route, body = {}, owner = capture()) {
      if (!routes.has(route) || !object(body) || Object.hasOwn(body, 'uid')) throw error('invalid_request');
      if (!isCurrent(owner)) throw error('stale_session');
      let token;
      try { token = await owner.user.getIdToken(); } catch { throw error(isCurrent(owner) ? 'unauthenticated' : 'stale_session'); }
      if (!isCurrent(owner)) throw error('stale_session');
      if (!string(token, 16000) || !token) throw error('unauthenticated');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await (fetcher || root.fetch)(origin + route, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
          body: JSON.stringify(body), credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: controller.signal
        });
        if (!isCurrent(owner)) throw error('stale_session');
        let data; try { data = await res.json(); } catch { throw error(res.status === 503 ? 'security_maintenance' : 'invalid_response', res.status); }
        if (!isCurrent(owner)) throw error('stale_session');
        if (!res.ok || data?.error) {
          const code = typeof data?.error === 'string' ? data.error : data?.error?.code;
          throw error(code || ({ 401: 'unauthenticated', 403: 'forbidden', 429: 'rate_limited', 503: 'security_maintenance' })[res.status] || 'upstream_error', res.status);
        }
        return validate(route, data, body);
      } catch (e) {
        if (!isCurrent(owner)) throw error('stale_session');
        if (e.code) throw e;
        throw error(e.name === 'AbortError' ? 'timeout' : 'network_error');
      } finally { clearTimeout(timer); }
    }
    return { capture, isCurrent, request };
  }
  root.TrackerWorker = { createClient, errorMessage: e => messages[e?.code] || 'The service could not complete this request. Try again later.' };
  if (typeof module === 'object' && module.exports) module.exports = root.TrackerWorker;
})(typeof window === 'object' ? window : globalThis);
