Job Tracker Firestore rules

Test from the repository root with Node 24 and Java 21:
  npm ci --prefix backend --ignore-scripts --no-audit --no-fund
  npm run test:firestore

The runner uses only the fixed demo-job-tracker project and loopback emulator
ports. It removes inherited Firebase-token and ADC-file settings from its child
environment. No Firebase login, production project alias, or deploy command is
needed. A portable Java runtime under output/firestore-runtime is also supported.
Dependencies are pinned in backend/package-lock.json. CI runs the same command
on Ubuntu with read-only repository permission and no deployment credentials.

Deployment is separate from CI and requires explicit approval of the migration
below. Review the exact firestore.rules file and successful emulator result;
coordinate publication with the current userDirectory client code. The test
configuration is for the emulator only. It is not a production deploy target.
After publication, verify owner/admin access and anonymous/cross-user denial in
the Firebase Console rules simulator before treating the change as complete.

Migration scope:
- Known-UID public share links stop working. Jobs are accessible only by their
  verified owner, who must be the verified admin or have approved === true in
  the allowlist. An admin cannot read another user's jobs through client rules.
- Existing jobs, approvals, and legacy emailToUid documents are not deleted.
  Legacy directory reads/writes are denied because previous entries could have
  been forged. Do not copy those entries into the new trusted directory.
- Users self-register {uid, email} in userDirectory/{uid} after sign-in. The
  verified token controls UID and normalized email, including before approval.
  Directory updates cannot reassign UID; client deletion is denied.
- Admin approval queries the new directory by exact normalized email and must
  require one result with stored UID equal to its document ID. Missing or
  duplicate matches require renewed sign-in or trusted account reconciliation;
  do not fall back to the legacy directory. Existing approved users stay approved.
  Existing approvals remain trusted; review their provenance separately if a
  forged legacy mapping might previously have influenced an admin approval.
- Only an approved owner's gmailSync/latest suggestion history is client-readable
  and writable, with suggestions (list) and scannedAt (string). Other fields and
  Gmail documents are denied. The Worker stores OAuth tokens separately in its
  GMAIL_TOKENS KV binding; these Firestore rules do not govern that storage.

These are client Firestore rules. They do not secure the Worker's routes, OAuth
state, token validation, KV permissions, or privileged Admin SDK requests.
The emulator suite covers authorization boundaries and synthetic data only.

Official test reference:
https://firebase.google.com/docs/firestore/security/test-rules-emulator
