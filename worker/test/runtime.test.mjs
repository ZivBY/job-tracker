import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const workerRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const minute = 60_000;
const day = 86_400_000;
// Keep virtual deadlines ahead of wall time so workerd's real alarm scheduler
// cannot race the deterministic request clock used by these tests.
const clock = Math.floor(Date.now() / day) * day + day + 12 * 60 * minute;

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function within(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 4_000);
      })
    ]);
  } finally { clearTimeout(timer); }
}

function fakeGrant(expiresAt = clock + 60 * minute) {
  return {
    refreshToken: 'synthetic-refresh-token',
    accessToken: 'synthetic-access-token',
    googleSub: 'synthetic-google-subject',
    email: 'runtime-fixture@example.invalid',
    expiresAt
  };
}

// Only this in-memory test entrypoint changes the clock. The production class,
// fetch routes and SQLite transactions are imported unchanged into workerd.
// There is no production debug route, credential, remote binding or network call.
const entrypoint = `
import { SecurityCoordinator } from './src/coordinator.mjs';
export class RuntimeCoordinator extends SecurityCoordinator {
  constructor(state, env) {
    const control = { pauseAlarmList: false };
    const storage = new Proxy(state.storage, {
      get(target, property) {
        if (property === 'list') return async options => {
          const snapshot = await target.list(options);
          if (control.pauseAlarmList && options?.prefix === 'rate:') {
            control.pauseAlarmList = false;
            await fetch('https://runtime-control.invalid/alarm-listed', { method: 'POST' });
          }
          return snapshot;
        };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    const wrappedState = new Proxy(state, {
      get(target, property) {
        if (property === 'storage') return storage;
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    super(wrappedState, env);
    this.testControl = control;
  }
  async fetch(request) {
    const timestamp = Number(request.headers.get('X-Runtime-Test-Time'));
    if (!Number.isFinite(timestamp)) throw new Error('Test clock required');
    Date.now = () => timestamp;
    if (new URL(request.url).pathname === '/__test/alarm') {
      this.testControl.pauseAlarmList = true;
      await super.alarm();
      return Response.json({ completed: true });
    }
    return super.fetch(request);
  }
}
export default { fetch() { return new Response('No public test routes', { status: 404 }); } };
`;

test('production coordinator concurrency in real workerd SQLite Durable Objects', { timeout: 60_000 }, async t => {
  let outbound = async request => {
    throw new Error(`Unexpected outbound request: ${new URL(request.url).origin}`);
  };
  const options = convertV4MiniflareOptions({
    name: 'coordinator-runtime-test',
    rootPath: workerRoot,
    host: '127.0.0.1',
    port: 0,
    compatibilityDate: '2026-11-12',
    cf: false,
    modules: [
      { type: 'ESModule', path: join(workerRoot, 'runtime-test-entry.mjs'), contents: entrypoint },
      { type: 'ESModule', path: join(workerRoot, 'src/coordinator.mjs'), contents: await readFile(join(workerRoot, 'src/coordinator.mjs'), 'utf8') },
      { type: 'ESModule', path: join(workerRoot, 'src/common.mjs'), contents: await readFile(join(workerRoot, 'src/common.mjs'), 'utf8') }
    ],
    durableObjects: { SECURITY_COORDINATOR: { className: 'RuntimeCoordinator', useSQLite: true } },
    bindings: { GMAIL_CLIENT_ID: 'synthetic-client', GMAIL_CLIENT_SECRET: 'synthetic-secret' },
    outboundService: request => outbound(request)
  });
  options.enableDevRegistry = false;
  options.telemetry = { enabled: false };
  options.logRequests = false;
  const runtime = new Miniflare(options);
  t.after(() => runtime.dispose());
  const namespace = await runtime.getDurableObjectNamespace('SECURITY_COORDINATOR');

  function caller(name) {
    const stub = namespace.get(namespace.idFromName(name));
    return async (path, body = {}, timestamp = clock) => {
      const response = await stub.fetch(`https://internal${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Runtime-Test-Time': String(timestamp) },
        body: JSON.stringify(body)
      });
      return { status: response.status, body: await response.json() };
    };
  }

  async function connected(call, grant = fakeGrant(), timestamp = clock) {
    const started = await call('/begin', {}, timestamp);
    assert.equal(started.status, 200);
    const claimed = await call('/callback/claim', { epoch: started.body.epoch }, timestamp);
    assert.equal(claimed.status, 200);
    const finished = await call('/callback/finish', { id: claimed.body.id, epoch: started.body.epoch, outcome: 'success', grant }, timestamp);
    assert.equal(finished.status, 200);
    assert.equal(finished.body.connected, true);
    return started.body.epoch;
  }

  await t.test('twenty simultaneous callbacks consume an OAuth state exactly once', async () => {
    const call = caller('state-replay');
    const key = 'A'.repeat(43);
    const record = { uid: 'owner-a', nonce: 'synthetic-nonce', verifier: 'synthetic-verifier', expiresAt: clock + 5 * minute };
    assert.equal((await call('/state/create', { key, record })).status, 200);
    const responses = await Promise.all(Array.from({ length: 20 }, () => call('/state/consume', { key })));
    const accepted = responses.filter(response => response.status === 200);
    assert.equal(accepted.length, 1);
    assert.deepEqual(accepted[0].body, record);
    assert.equal(responses.filter(response => response.status === 400 && response.body.error?.code === 'invalid_state').length, 19);
    assert.equal((await call('/state/consume', { key })).status, 400);
  });

  await t.test('expired OAuth state is denied and removed synchronously without waiting for an alarm', async () => {
    const call = caller('state-expiration');
    const key = 'B'.repeat(43);
    assert.equal((await call('/state/create', { key, record: { uid: 'owner-b', expiresAt: clock + minute } })).status, 200);
    assert.equal((await call('/state/consume', { key }, clock + minute)).status, 400);
    assert.equal((await call('/state/consume', { key }, clock)).status, 400, 'an expired record must have been consumed even if a clock later moves backward');
  });

  await t.test('parallel reservations enforce per-user and global minute limits without charging rejected reservations', async () => {
    const call = caller('quota-parallel');
    const oneUser = await Promise.all(Array.from({ length: 12 }, () => call('/rate', { uid: 'same-owner', action: 'extract' })));
    assert.equal(oneUser.filter(response => response.status === 200).length, 6);
    assert.equal(oneUser.filter(response => response.status === 429).length, 6);
    const otherUsers = await Promise.all(Array.from({ length: 35 }, (_, i) => call('/rate', { uid: `owner-${i}`, action: 'extract' })));
    assert.equal(otherUsers.filter(response => response.status === 200).length, 24, 'only successful reservations consume the global allowance of 30');
    assert.equal(otherUsers.filter(response => response.status === 429).length, 11);
    assert.equal((await call('/rate', { uid: 'last-owner', action: 'extract' })).status, 429);
  });

  await t.test('daily user and global quotas survive minute resets and reset only at the next UTC day', async () => {
    const user = caller('quota-user-day');
    for (let i = 0; i < 6; i++) assert.equal((await user('/rate', { uid: 'owner', action: 'scan' }, clock + i * minute)).status, 200);
    assert.equal((await user('/rate', { uid: 'owner', action: 'scan' }, clock + 6 * minute)).status, 429);
    assert.equal((await user('/rate', { uid: 'owner', action: 'scan' }, clock + day)).status, 200);
    const global = caller('quota-global-day');
    for (let batch = 0; batch < 2; batch++) {
      const responses = await Promise.all(Array.from({ length: 5 }, (_, i) => global('/rate', { uid: `owner-${batch}-${i}`, action: 'scan' }, clock + batch * minute)));
      assert.ok(responses.every(response => response.status === 200));
    }
    assert.equal((await global('/rate', { uid: 'over-budget', action: 'scan' }, clock + 2 * minute)).status, 429);
    assert.equal((await global('/rate', { uid: 'next-day', action: 'scan' }, clock + day)).status, 200);
  });

  await t.test('alarm cleanup cannot delete a quota renewed after its expired-row snapshot', async () => {
    const entered = deferred(), release = deferred();
    outbound = async request => {
      assert.equal(request.url, 'https://runtime-control.invalid/alarm-listed');
      entered.resolve();
      await release.promise;
      return new Response('', { status: 200 });
    };
    const call = caller('alarm-renewal-race');
    const body = { uid: 'same-owner', action: 'scan' };
    assert.equal((await call('/rate', body)).status, 200);
    const midnight = Math.floor(clock / day) * day + day;
    const cleaning = call('/__test/alarm', {}, midnight);
    try {
      await within(entered.promise, 'expired quota snapshot');
      assert.equal((await call('/rate', body, midnight + minute)).status, 200);
      release.resolve();
      assert.equal((await cleaning).status, 200);
      assert.equal((await call('/rate', body, midnight + minute)).status, 429,
        'cleanup must re-read expiry transactionally instead of deleting the fresh reservation');
    } finally { release.resolve(); await cleaning; }
  });

  await t.test('a callback lease permits exactly one claimant and blocks a newer connect until completion', async () => {
    const call = caller('callback-single-flight');
    const started = await call('/begin');
    const claims = await Promise.all(Array.from({ length: 10 }, () => call('/callback/claim', { epoch: started.body.epoch })));
    const accepted = claims.filter(response => response.status === 200);
    assert.equal(accepted.length, 1);
    assert.equal(claims.filter(response => response.status === 409).length, 9);
    assert.equal((await call('/begin')).status, 409);
    const completion = { id: accepted[0].body.id, epoch: started.body.epoch, outcome: 'success', grant: fakeGrant() };
    assert.equal((await call('/callback/finish', completion)).body.connected, true);
    assert.equal((await call('/status')).body.connected, true);
    const duplicate = await call('/callback/finish', completion);
    assert.equal(duplicate.body.connected, false);
    assert.equal(duplicate.body.lateCallback, true);
  });

  await t.test('disconnect invalidates callbacks already in progress and wins a simultaneous grant completion race', async () => {
    let revocations = 0;
    outbound = async request => {
      assert.equal(request.url, 'https://oauth2.googleapis.com/revoke');
      revocations++;
      return new Response('', { status: 200 });
    };
    const cancelled = caller('callback-cancelled');
    const { body: started } = await cancelled('/begin');
    const { body: lease } = await cancelled('/callback/claim', { epoch: started.epoch });
    const blocked = await cancelled('/disconnect');
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error.code, 'revocation_pending');
    assert.equal((await cancelled('/begin')).status, 409);
    const stale = await cancelled('/callback/finish', { id: lease.id, epoch: started.epoch, outcome: 'success', grant: fakeGrant() });
    assert.equal(stale.status, 200);
    assert.equal(stale.body.connected, false);
    assert.equal(stale.body.cleanupRequired, true);
    assert.equal((await cancelled('/status')).body.connected, false);
    assert.equal((await cancelled('/begin')).status, 409);
    assert.equal((await cancelled('/disconnect')).body.revoked, true);
    assert.equal(revocations, 1);
    for (let i = 0; i < 5; i++) {
      const call = caller(`callback-race-${i}`);
      const { body: current } = await call('/begin');
      const { body: claimed } = await call('/callback/claim', { epoch: current.epoch });
      const [commit, disconnect] = await Promise.all([
        call('/callback/finish', { id: claimed.id, epoch: current.epoch, outcome: 'success', grant: fakeGrant() }),
        call('/disconnect')
      ]);
      assert.equal(commit.status, 200);
      assert.ok([200, 409].includes(disconnect.status));
      if (disconnect.status === 409) {
        assert.equal(disconnect.body.error.code, 'revocation_pending');
        assert.equal(commit.body.connected, false);
        assert.equal(commit.body.cleanupRequired, true);
        assert.equal((await call('/disconnect')).body.revoked, true);
      }
      assert.equal((await call('/status')).body.connected, false);
      assert.equal((await call('/token')).status, 401);
    }
  });

  await t.test('an uncertain OAuth exchange requires explicit owner recovery after its grace period without claiming provider revocation', async () => {
    outbound = async () => { throw new Error('Owner confirmation must not pretend to call Google revocation'); };
    const call = caller('callback-uncertain-recovery');
    const { body: started } = await call('/begin');
    const { body: claimed } = await call('/callback/claim', { epoch: started.epoch });
    const unresolved = await call('/callback/finish', { id: claimed.id, epoch: started.epoch, outcome: 'uncertain' });
    assert.equal(unresolved.body.connected, false);
    assert.equal(unresolved.body.revocationPending, true);
    assert.equal((await call('/begin')).status, 409);
    assert.equal((await call('/token')).status, 409);
    assert.equal((await call('/disconnect', { confirmManualRevocation: true })).status, 409, 'manual confirmation cannot bypass an active exchange grace period');
    const afterGrace = clock + 2 * minute;
    const status = await call('/status', {}, afterGrace);
    assert.equal(status.body.connected, false);
    assert.equal(status.body.manualRevocationRequired, true);
    assert.equal((await call('/disconnect', {}, afterGrace)).status, 409, 'grace expiry alone is not approval to clear uncertainty');
    const recovery = await call('/disconnect', { confirmManualRevocation: true }, afterGrace);
    assert.equal(recovery.status, 200);
    assert.equal(recovery.body.success, true);
    assert.equal(recovery.body.revoked, false);
    assert.equal(recovery.body.confirmation, 'owner');
    await connected(call, fakeGrant(), afterGrace);
    assert.equal((await call('/status', {}, afterGrace)).body.connected, true);
  });

  await t.test('a late callback cannot auto-revoke a newer connection or falsely confirm its provider grant was removed', async () => {
    const revokedTokens = [];
    outbound = async request => {
      assert.equal(request.url, 'https://oauth2.googleapis.com/revoke');
      const token = new URLSearchParams(await request.text()).get('token');
      revokedTokens.push(token);
      return token === 'old-already-revoked-token'
        ? Response.json({ error: 'invalid_token' }, { status: 400 })
        : new Response('', { status: 200 });
    };
    const call = caller('late-callback-after-new-link');
    const { body: started } = await call('/begin');
    const { body: lease } = await call('/callback/claim', { epoch: started.epoch });
    await call('/callback/finish', { id: lease.id, epoch: started.epoch, outcome: 'uncertain' });
    const recoveredAt = clock + 2 * minute;
    const recovery = await call('/disconnect', { confirmManualRevocation: true }, recoveredAt);
    assert.equal(recovery.body.revoked, false);
    await connected(call, { ...fakeGrant(), refreshToken: 'new-current-provider-token' }, recoveredAt);

    const late = await call('/callback/finish', {
      id: lease.id, epoch: started.epoch, outcome: 'success',
      grant: { ...fakeGrant(), refreshToken: 'old-already-revoked-token' }
    }, recoveredAt);
    assert.equal(late.body.connected, false);
    assert.equal(late.body.lateCallback, true);
    assert.equal(late.body.revocationPending, true);
    assert.notEqual(late.body.cleanupRequired, true, 'the gateway must not automatically revoke across a newer connection');
    assert.deepEqual(revokedTokens, [], 'a stale completion cannot call Google on its own');
    assert.equal((await call('/status', {}, recoveredAt)).body.connected, false);
    assert.equal((await call('/token', {}, recoveredAt)).status, 409);
    assert.equal((await call('/begin', {}, recoveredAt)).status, 409);

    const explicitDisconnect = await call('/disconnect', {}, recoveredAt);
    if (explicitDisconnect.status === 200 && explicitDisconnect.body.revoked === true) {
      assert.ok(revokedTokens.includes('new-current-provider-token'),
        'revoking an already-invalid old token is not proof the newer provider grant was removed');
    } else {
      assert.equal(explicitDisconnect.status, 409);
      assert.notEqual(explicitDisconnect.body.revoked, true);
      const ownerRecoveryAt = recoveredAt + 2 * minute;
      assert.equal((await call('/status', {}, ownerRecoveryAt)).body.manualRevocationRequired, true);
      const manual = await call('/disconnect', { confirmManualRevocation: true }, ownerRecoveryAt);
      assert.equal(manual.status, 200);
      assert.equal(manual.body.revoked, false);
      assert.equal(manual.body.confirmation, 'owner');
    }
  });

  await t.test('a callback finishing after its own deadline is rejected and retained for provider cleanup', async () => {
    const call = caller('callback-deadline');
    const { body: started } = await call('/begin');
    const { body: lease } = await call('/callback/claim', { epoch: started.epoch });
    const finished = await call('/callback/finish', {
      id: lease.id, epoch: started.epoch, outcome: 'success', grant: fakeGrant()
    }, clock + 2 * minute);
    assert.equal(finished.status, 200);
    assert.equal(finished.body.connected, false);
    assert.equal(finished.body.cleanupRequired, true);
    assert.equal((await call('/status', {}, clock + 2 * minute)).body.connected, false);
    assert.equal((await call('/begin', {}, clock + 2 * minute)).status, 409);
  });

  await t.test('an older revocation response cannot clear a late-callback barrier or report cleanup complete', async () => {
    const entered = deferred(), release = deferred();
    let revocations = 0;
    outbound = async request => {
      assert.equal(request.url, 'https://oauth2.googleapis.com/revoke');
      revocations++;
      entered.resolve();
      await release.promise;
      return new Response('', { status: 200 });
    };
    const call = caller('late-callback-during-revoke');
    const { body: oldAttempt } = await call('/begin');
    const { body: oldLease } = await call('/callback/claim', { epoch: oldAttempt.epoch });
    await call('/callback/finish', { id: oldLease.id, epoch: oldAttempt.epoch, outcome: 'uncertain' });
    const recoveredAt = clock + 2 * minute;
    assert.equal((await call('/disconnect', { confirmManualRevocation: true }, recoveredAt)).body.revoked, false);
    await connected(call, { ...fakeGrant(), refreshToken: 'current-grant-for-revocation' }, recoveredAt);
    const disconnecting = call('/disconnect', {}, recoveredAt);
    try {
      await within(entered.promise, 'older provider revocation');
      const late = await call('/callback/finish', {
        id: oldLease.id, epoch: oldAttempt.epoch, outcome: 'success',
        grant: { ...fakeGrant(), refreshToken: 'late-credential-during-revoke' }
      }, recoveredAt);
      assert.equal(late.body.lateCallback, true);
      assert.equal(late.body.revocationPending, true);
      assert.equal((await call('/disconnect', { confirmManualRevocation: true }, recoveredAt)).status, 409,
        'manual recovery must respect the provider request still in flight');
      release.resolve();
      const completed = await disconnecting;
      assert.equal(completed.status, 409);
      assert.equal(completed.body.error.code, 'revocation_pending');
      assert.notEqual(completed.body.revoked, true);
      assert.equal((await call('/status', {}, recoveredAt)).body.revocationPending, true);
      assert.equal((await call('/token', {}, recoveredAt)).status, 409);
      const manual = await call('/disconnect', { confirmManualRevocation: true }, recoveredAt + minute);
      assert.equal(manual.body.revoked, false);
      assert.equal(manual.body.confirmation, 'owner');
      assert.equal(revocations, 1);
    } finally { release.resolve(); await disconnecting; }
  });

  await t.test('one refresh lease prevents duplicate exchanges and a late refresh cannot resurrect a disconnected grant', async () => {
    const entered = deferred(), release = deferred();
    let refreshes = 0, revocations = 0;
    outbound = async request => {
      if (request.url === 'https://oauth2.googleapis.com/token') {
        refreshes++;
        const body = new URLSearchParams(await request.text());
        assert.equal(body.get('grant_type'), 'refresh_token');
        entered.resolve();
        await release.promise;
        return Response.json({ access_token: 'synthetic-refreshed-token', token_type: 'Bearer', expires_in: 3600 });
      }
      assert.equal(request.url, 'https://oauth2.googleapis.com/revoke');
      revocations++;
      return new Response('', { status: 200 });
    };
    const call = caller('refresh-disconnect-race');
    await connected(call, fakeGrant(clock - 1));
    const refreshing = call('/token');
    try {
      await within(entered.promise, 'refresh exchange');
      const duplicate = await call('/token');
      assert.equal(duplicate.status, 409);
      assert.equal(duplicate.body.error.code, 'request_in_progress');
      assert.equal((await call('/disconnect')).status, 200);
      release.resolve();
      const completed = await refreshing;
      assert.equal(completed.status, 409);
      assert.equal(completed.body.error.code, 'authorization_cancelled');
      assert.equal((await call('/status')).body.connected, false);
      assert.equal((await call('/token')).status, 401);
      assert.equal(refreshes, 1);
      assert.equal(revocations, 1);
    } finally { release.resolve(); await refreshing; }
  });

  await t.test('concurrent disconnects cannot launch a second revocation that outlives the reconnect barrier', async () => {
    const entered = deferred(), release = deferred();
    let revocations = 0;
    outbound = async request => {
      assert.equal(request.url, 'https://oauth2.googleapis.com/revoke');
      revocations++;
      entered.resolve();
      await release.promise;
      return new Response('', { status: 200 });
    };
    const call = caller('disconnect-single-flight');
    const oldEpoch = await connected(call);
    const disconnecting = call('/disconnect');
    let duplicate;
    try {
      await within(entered.promise, 'Google revocation');
      duplicate = call('/disconnect');
      const second = await within(duplicate, 'concurrent disconnect rejection');
      assert.equal(second.status, 409, 'an existing revocation must be single-flight');
      assert.equal(revocations, 1);
      const status = await call('/status');
      assert.equal(status.body.connected, false);
      assert.equal(status.body.revocationPending, true);
      assert.equal((await call('/begin')).status, 409);
      assert.equal((await call('/callback/claim', { epoch: oldEpoch })).status, 409);
      release.resolve();
      assert.equal((await disconnecting).status, 200);
      assert.equal((await call('/status')).body.revocationPending, false);
      await connected(call);
      assert.equal((await call('/status')).body.connected, true);
      assert.equal(revocations, 1);
    } finally {
      release.resolve();
      await Promise.allSettled([disconnecting, duplicate].filter(Boolean));
    }
  });

  await t.test('failed provider revocation keeps local access denied and reconnect blocked until an explicit successful retry', async () => {
    let revocations = 0;
    outbound = async request => {
      assert.equal(request.url, 'https://oauth2.googleapis.com/revoke');
      revocations++;
      return new Response('', { status: revocations === 1 ? 503 : 200 });
    };
    const call = caller('disconnect-retry');
    await connected(call);
    assert.equal((await call('/disconnect')).status, 502);
    assert.equal((await call('/status')).body.connected, false);
    assert.equal((await call('/token')).status, 401);
    assert.equal((await call('/begin')).status, 409);
    assert.equal((await call('/disconnect')).status, 409, 'a failed revocation retains its retry lease');
    assert.equal((await call('/disconnect', {}, clock + minute)).status, 200);
    assert.equal((await call('/status', {}, clock + minute)).body.revocationPending, false);
    await connected(call, fakeGrant(), clock + minute);
    assert.equal(revocations, 2);
  });
});
