/* Shared, dependency-free boundaries for tracker data and HTML. */
(function (root) {
  'use strict';
  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }
  function inlineArg(value) {
    return escapeHtml(JSON.stringify(String(value)).slice(1, -1).replace(/'/g, "\\'"));
  }
  function httpUrl(value) {
    try {
      const text = String(value || '').trim();
      const parsed = new URL(text);
      return ['http:', 'https:'].includes(parsed.protocol) ? text : '';
    } catch (_) { return ''; }
  }
  function renderValue(value) {
    if (typeof value === 'string') return escapeHtml(value);
    if (Array.isArray(value)) return value.map(renderValue);
    if (value && Object.getPrototypeOf(value)?.constructor?.name === 'Object') {
      return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, renderValue(val)]));
    }
    return value;
  }
  function renderJob(job) {
    const base = {
      ...job,
      role: String(job.role || 'Untitled role'), company: String(job.company || 'Unknown company'),
      type: String(job.type || 'Not specified'), emoji: String(job.emoji || '?'),
      interviewRounds: Array.isArray(job.interviewRounds) ? job.interviewRounds.filter(x => x && typeof x === 'object') : [],
      attachments: Array.isArray(job.attachments) ? job.attachments.filter(x => x && typeof x === 'object') : [],
      contacts: Array.isArray(job.contacts) ? job.contacts.filter(x => x && typeof x === 'object') : [],
      stageData: job.stageData && typeof job.stageData === 'object' ? job.stageData : {},
      stageNotes: job.stageNotes && typeof job.stageNotes === 'object' ? job.stageNotes : {},
      stageHistory: Array.isArray(job.stageHistory) ? job.stageHistory.filter(x => x && typeof x === 'object') : []
    };
    const copy = renderValue(base);
    copy.firestoreId = job.firestoreId;
    copy.color = /^#[0-9a-f]{6}$/i.test(job.color || '') ? job.color : '#635BFF';
    copy.stage = Number.isInteger(job.stage) && job.stage >= 0 && job.stage <= 5 ? job.stage : 0;
    return copy;
  }
  function localDate(date = new Date()) {
    return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
  }
  function applyFields(record, fields) {
    for (const [path, value] of Object.entries(fields)) {
      const parts = path.split('.');
      if (parts.some(part => ['__proto__', 'prototype', 'constructor'].includes(part))) continue;
      let target = record;
      for (const part of parts.slice(0, -1)) {
        if (!target[part] || typeof target[part] !== 'object') target[part] = {};
        target = target[part];
      }
      target[parts[parts.length - 1]] = value;
    }
    return record;
  }
  function applicationMatch(a, b) {
    const normalize = value => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const canonicalUrl = value => {
      const valid = httpUrl(value);
      if (!valid) return '';
      const url = new URL(valid);
      url.hash = '';
      for (const key of [...url.searchParams.keys()]) if (/^(utm_|gh_src$)/i.test(key)) url.searchParams.delete(key);
      return url.href.replace(/\/$/, '');
    };
    const firstUrl = canonicalUrl(a.url), secondUrl = canonicalUrl(b.url);
    if (firstUrl && secondUrl) return firstUrl === secondUrl ? 'exact-url' : null;
    return normalize(a.company) === normalize(b.company) && normalize(a.role) === normalize(b.role) ? 'possible' : null;
  }
  function sameApplication(a, b) { return applicationMatch(a, b) !== null; }
  const api = { escapeHtml, inlineArg, httpUrl, renderValue, renderJob, localDate, applyFields, applicationMatch, sameApplication };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TrackerSafety = api;
})(typeof window !== 'undefined' ? window : globalThis);
