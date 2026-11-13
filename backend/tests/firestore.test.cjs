const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, collection, collectionGroup, getDoc, getDocs, setDoc, updateDoc, deleteDoc, writeBatch, query, orderBy, where, setLogLevel } = require('firebase/firestore');
setLogLevel('silent'); // Expected denied writes are asserted below, not printed as failures.

// Never accept a real project ID or a remote endpoint, including from env.
const PROJECT = 'demo-job-tracker';
const address = process.env.FIRESTORE_EMULATOR_HOST || '';
assert.match(address, /^(127\.0\.0\.1|localhost):\d+$/, 'Run through the loopback-only Firebase emulator command');
const [host, port] = address.split(':');
const ADMIN = 'benyehuda.ziv@gmail.com'; // Already-public app admin identity; test UID is synthetic.
let env;
const verified = (uid, email = uid + '@fixture.test') => env.authenticatedContext(uid, { email, email_verified: true }).firestore();
const anonymous = () => env.unauthenticatedContext().firestore();
const job = (db, uid, id = 'base') => doc(db, 'users', uid, 'jobs', id);
const latest = (db, uid) => doc(db, 'users', uid, 'gmailSync', 'latest');
const metadata = { suggestions: [{ company: 'Synthetic Co', stage: 2, applied: false }], scannedAt: '2026-11-12T00:00:00.000Z' };
const key = email => email.toLowerCase().replace(/\./g, '_');

before(async () => {
  env = await initializeTestEnvironment({
    projectId: PROJECT,
    firestore: { host, port: Number(port), rules: fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8') }
  });
});
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    const batch = writeBatch(db);
    for (const uid of ['alice', 'bob']) batch.set(doc(db, 'allowlist', uid), { approved: true, email: uid + '@fixture.test' });
    batch.set(doc(db, 'allowlist', 'revoked'), { approved: false, email: 'revoked@fixture.test' });
    batch.set(doc(db, 'allowlist', 'legacy'), { email: 'legacy@fixture.test' });
    for (const uid of ['alice', 'bob', 'admin-fixture', 'unapproved', 'revoked', 'legacy']) {
      batch.set(job(db, uid), { company: 'Synthetic Co', stage: 1, createdAt: 1 });
      batch.set(latest(db, uid), metadata);
    }
    for (const uid of ['alice', 'bob']) batch.set(doc(db, 'userDirectory', uid), { uid, email: uid + '@fixture.test' });
    batch.set(doc(db, 'emailToUid', key('victim@fixture.test')), { uid: 'legacy-attacker', email: 'victim@fixture.test' });
    batch.set(doc(db, 'users', 'alice', 'gmailSync', 'tokens'), { refresh_token: 'synthetic-not-a-secret' });
    batch.set(doc(db, 'gmailTokens', 'alice'), { token: 'synthetic-not-a-secret' });
    await batch.commit();
  });
});
after(async () => { if (env) await env.cleanup(); });

test('anonymous callers cannot read a known job, list jobs, or write a job', async () => {
  const db = anonymous();
  await assertFails(getDoc(job(db, 'alice')));
  await assertFails(getDocs(collection(db, 'users', 'alice', 'jobs')));
  await assertFails(setDoc(job(db, 'alice', 'new'), { company: 'Denied' }));
  await assertFails(updateDoc(job(db, 'alice'), { stage: 5 }));
  await assertFails(deleteDoc(job(db, 'alice')));
});

test('approved verified owners can query, create, update, and delete their jobs', async () => {
  const db = verified('alice');
  await assertSucceeds(getDoc(job(db, 'alice')));
  await assertSucceeds(getDocs(query(collection(db, 'users', 'alice', 'jobs'), orderBy('createdAt', 'desc'))));
  await assertSucceeds(setDoc(job(db, 'alice', 'new'), { company: 'Synthetic New', stage: 0 }));
  await assertSucceeds(updateDoc(job(db, 'alice', 'new'), { stage: 2, 'stageData.1.appliedDate': '2026-11-12' }));
  await assertSucceeds(deleteDoc(job(db, 'alice', 'new')));
});

test('approved users cannot access another owner, even with a known share UID', async () => {
  const db = verified('bob');
  await assertFails(getDoc(job(db, 'alice')));
  await assertFails(getDocs(collection(db, 'users', 'alice', 'jobs')));
  await assertFails(setDoc(job(db, 'alice', 'new'), { company: 'Denied' }));
  await assertFails(updateDoc(job(db, 'alice'), { stage: 5 }));
  await assertFails(deleteDoc(job(db, 'alice')));
  await assertFails(getDocs(collectionGroup(db, 'jobs')));
});

test('missing, false, and absent approved fields do not grant owner access', async () => {
  for (const uid of ['unapproved', 'revoked', 'legacy']) {
    const db = verified(uid);
    await assertFails(getDoc(job(db, uid)));
    await assertFails(setDoc(job(db, uid, 'new'), { company: 'Denied' }));
  }
});

test('revocation blocks subsequent operations with the same signed-in identity', async () => {
  const db = verified('alice');
  await assertSucceeds(getDoc(job(db, 'alice')));
  await env.withSecurityRulesDisabled(context => updateDoc(doc(context.firestore(), 'allowlist', 'alice'), { approved: false }));
  await assertFails(getDoc(job(db, 'alice')));
  await assertFails(updateDoc(job(db, 'alice'), { notes: 'Denied after revocation' }));
});

test('unverified email and missing identity claims never grant access, including admin email', async () => {
  for (const claims of [{ email: 'alice@fixture.test', email_verified: false }, { email: 'alice@fixture.test' }, {}]) {
    const db = env.authenticatedContext('alice', claims).firestore();
    await assertFails(getDoc(job(db, 'alice')));
    await assertFails(setDoc(doc(db, 'userDirectory', 'alice'), { uid: 'alice', email: 'alice@fixture.test' }));
  }
  const fakeAdmin = env.authenticatedContext('admin-fixture', { email: ADMIN, email_verified: false }).firestore();
  await assertFails(getDoc(job(fakeAdmin, 'admin-fixture')));
  await assertFails(setDoc(doc(fakeAdmin, 'allowlist', 'new'), { approved: true }));
});

test('verified administrator keeps own access and allowlist management, but not other users jobs', async () => {
  const db = verified('admin-fixture', ADMIN.toUpperCase());
  await assertSucceeds(getDoc(job(db, 'admin-fixture')));
  await assertSucceeds(setDoc(job(db, 'admin-fixture', 'new'), { company: 'Synthetic admin job' }));
  await assertSucceeds(getDocs(collection(db, 'allowlist')));
  await assertSucceeds(setDoc(doc(db, 'allowlist', 'new'), { email: 'new@fixture.test', approved: true }));
  await assertSucceeds(updateDoc(doc(db, 'allowlist', 'new'), { approved: false }));
  await assertSucceeds(deleteDoc(doc(db, 'allowlist', 'new')));
  await assertFails(getDoc(job(db, 'alice')));
  await assertFails(updateDoc(job(db, 'alice'), { stage: 5 }));
});

test('ordinary users can inspect only their own approval and cannot self-approve', async () => {
  const db = verified('unapproved');
  await assertSucceeds(getDoc(doc(db, 'allowlist', 'unapproved')));
  await assertFails(getDoc(doc(db, 'allowlist', 'alice')));
  await assertFails(getDocs(collection(db, 'allowlist')));
  await assertFails(setDoc(doc(db, 'allowlist', 'unapproved'), { email: 'unapproved@fixture.test', approved: true }));
  const batch = writeBatch(db);
  batch.set(doc(db, 'allowlist', 'unapproved'), { approved: true });
  batch.set(job(db, 'unapproved', 'new'), { company: 'Denied' });
  await assertFails(batch.commit());
});

test('a verified unapproved user can register their own normalized email identity', async () => {
  const db = verified('charlie', 'Charlie.Quinn@Fixture.Test');
  const ref = doc(db, 'userDirectory', 'charlie');
  await assertSucceeds(setDoc(ref, { uid: 'charlie', email: 'charlie.quinn@fixture.test' }));
  await assertSucceeds(getDoc(ref));
  await assertSucceeds(setDoc(ref, { uid: 'charlie', email: 'charlie.quinn@fixture.test' }, { merge: true }));
  await assertFails(getDoc(job(db, 'charlie')));
});

test('UID directory creation rejects forged document ID, UID, email, and extra fields', async () => {
  const db = verified('charlie');
  await assertFails(setDoc(doc(db, 'userDirectory', 'victim'), { uid: 'charlie', email: 'charlie@fixture.test' }));
  await assertFails(setDoc(doc(db, 'userDirectory', 'charlie'), { uid: 'victim', email: 'charlie@fixture.test' }));
  await assertFails(setDoc(doc(db, 'userDirectory', 'charlie'), { uid: 'charlie', email: 'victim@fixture.test' }));
  await assertFails(setDoc(doc(db, 'userDirectory', 'charlie'), { uid: 'charlie', email: 'charlie@fixture.test', approved: true }));
});

test('directory entries cannot be reassigned or enumerated by ordinary users', async () => {
  const db = verified('alice');
  const own = doc(db, 'userDirectory', 'alice');
  await assertSucceeds(getDoc(own));
  await assertFails(getDoc(doc(db, 'userDirectory', 'bob')));
  await assertFails(getDocs(collection(db, 'userDirectory')));
  await assertFails(updateDoc(own, { uid: 'bob' }));
  await assertFails(deleteDoc(own));
  await assertFails(getDoc(doc(anonymous(), 'userDirectory', 'alice')));
});

test('dot and underscore emails no longer collide in UID-keyed directory', async () => {
  const dot = verified('dot-owner', 'a.b@fixture.test');
  const underscore = verified('underscore-owner', 'a_b@fixture.test');
  assert.equal(key('a_b@fixture.test'), key('a.b@fixture.test'));
  await assertSucceeds(setDoc(doc(dot, 'userDirectory', 'dot-owner'), { uid: 'dot-owner', email: 'a.b@fixture.test' }));
  await assertSucceeds(setDoc(doc(underscore, 'userDirectory', 'underscore-owner'), { uid: 'underscore-owner', email: 'a_b@fixture.test' }));
  await assertFails(getDoc(doc(underscore, 'userDirectory', 'dot-owner')));
  const admin = verified('admin-fixture', ADMIN);
  const result = await assertSucceeds(getDocs(query(collection(admin, 'userDirectory'), where('email', '==', 'a.b@fixture.test'))));
  assert.equal(result.size, 1);
  assert.equal(result.docs[0].id, 'dot-owner');
});

test('legacy poisoned directory is retired for everyone while fresh registration remains safe', async () => {
  const admin = verified('admin-fixture', ADMIN);
  const owner = verified('victim');
  for (const db of [admin, owner, anonymous()]) {
    const old = doc(db, 'emailToUid', key('victim@fixture.test'));
    await assertFails(getDoc(old));
    await assertFails(setDoc(old, { uid: 'victim', email: 'victim@fixture.test' }));
    await assertFails(deleteDoc(old));
  }
  await assertSucceeds(setDoc(doc(owner, 'userDirectory', 'victim'), { uid: 'victim', email: 'victim@fixture.test' }));
  const result = await assertSucceeds(getDocs(query(collection(admin, 'userDirectory'), where('email', '==', 'victim@fixture.test'))));
  assert.equal(result.size, 1);
  assert.equal(result.docs[0].id, 'victim');
  await assertFails(updateDoc(doc(admin, 'userDirectory', 'victim'), { uid: 'legacy-attacker' }));
});

test('approved owner can save and read Gmail suggestion metadata only', async () => {
  const db = verified('alice');
  await assertSucceeds(getDoc(latest(db, 'alice')));
  await assertSucceeds(setDoc(latest(db, 'alice'), { ...metadata, suggestions: [{ company: 'Synthetic Co', applied: true }] }));
  await assertSucceeds(deleteDoc(latest(db, 'alice')));
  await assertSucceeds(setDoc(latest(db, 'alice'), metadata));
  await assertFails(getDocs(collection(db, 'users', 'alice', 'gmailSync')));
});

test('Gmail metadata denies public, cross-owner, and revoked access', async () => {
  for (const db of [anonymous(), verified('bob'), verified('admin-fixture', ADMIN)]) {
    await assertFails(getDoc(latest(db, 'alice')));
    await assertFails(setDoc(latest(db, 'alice'), metadata));
  }
  await assertFails(getDoc(latest(verified('revoked'), 'revoked')));
  await assertFails(setDoc(latest(verified('unapproved'), 'unapproved'), metadata));
  await assertSucceeds(getDoc(latest(verified('admin-fixture', ADMIN), 'admin-fixture')));
});

test('OAuth credentials and unexpected Gmail document fields are denied even to owner', async () => {
  const db = verified('alice');
  await assertFails(getDoc(doc(db, 'users', 'alice', 'gmailSync', 'tokens')));
  await assertFails(setDoc(doc(db, 'users', 'alice', 'gmailSync', 'tokens'), { refresh_token: 'synthetic' }));
  await assertFails(getDoc(doc(db, 'gmailTokens', 'alice')));
  await assertFails(updateDoc(latest(db, 'alice'), { access_token: 'synthetic' }));
  await assertFails(setDoc(latest(db, 'alice'), { suggestions: 'not-a-list', scannedAt: 'today' }));
  await env.withSecurityRulesDisabled(context => updateDoc(latest(context.firestore(), 'alice'), { refresh_token: 'synthetic' }));
  await assertFails(getDoc(latest(db, 'alice')));
});

test('unknown paths and an arbitrary admin custom claim do not grant access', async () => {
  const db = verified('alice');
  await assertFails(setDoc(doc(db, 'users', 'alice', 'settings', 'arbitrary'), { admin: true }));
  await assertFails(setDoc(doc(db, 'arbitrary', 'document'), { value: true }));
  const forged = env.authenticatedContext('charlie', { email: 'charlie@fixture.test', email_verified: true, admin: true }).firestore();
  await assertFails(setDoc(doc(forged, 'allowlist', 'charlie'), { approved: true }));
});
