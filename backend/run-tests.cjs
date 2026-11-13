const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const runtime = path.resolve(__dirname, '..', 'output', 'firestore-runtime');
const env = { ...process.env, CI: 'true' };
// Child-process-only settings: never change machine PATH or stored login state.
delete env.FIREBASE_TOKEN;
delete env.GOOGLE_APPLICATION_CREDENTIALS;
env.GCLOUD_PROJECT = env.GOOGLE_CLOUD_PROJECT = 'demo-job-tracker';
env.FIREBASE_EMULATORS_PATH = path.join(runtime, 'emulators');

if (spawnSync('java', ['-version'], { env, stdio: 'ignore', windowsHide: true }).error) {
  const binary = process.platform === 'win32' ? 'java.exe' : 'java';
  const portable = fs.existsSync(runtime) && fs.readdirSync(runtime, { withFileTypes: true })
    .find(entry => entry.isDirectory() && fs.existsSync(path.join(runtime, entry.name, 'bin', binary)));
  if (!portable) {
    console.error('Java 21+ is required on PATH (or a portable runtime under output/firestore-runtime).');
    process.exit(1);
  }
  env.JAVA_HOME = path.join(runtime, portable.name);
  // Windows environment names are case-insensitive; avoid duplicate Path/PATH.
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH';
  env[pathKey] = path.join(env.JAVA_HOME, 'bin') + path.delimiter + (env[pathKey] || '');
}

const cli = require.resolve('firebase-tools/lib/bin/firebase.js');
const result = spawnSync(process.execPath, [
  cli, 'emulators:exec', '--only', 'firestore', '--project', 'demo-job-tracker',
  '--config', path.join(__dirname, 'firebase.test.json'),
  'node --test tests/firestore.test.cjs'
], { cwd: __dirname, env, stdio: 'inherit', windowsHide: true });
if (result.error) console.error(result.error.message);
process.exit(result.status == null ? 1 : result.status);
