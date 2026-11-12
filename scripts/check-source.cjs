const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
let failures = 0;
for (const file of ['index.html', 'index_mobile.html']) {
  const html = fs.readFileSync(path.join(root, file), 'utf8');
  const modules = [...html.matchAll(/<script\b[^>]*type="module"[^>]*>([\s\S]*?)<\/script>/g)];
  if (!modules.length) { console.error(file + ': missing module'); failures++; }
  for (const [index, match] of modules.entries()) {
    const result = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: match[1], encoding: 'utf8' });
    if (result.status !== 0) { console.error(file + ' module ' + index + ': ' + result.stderr); failures++; }
  }
  for (const match of html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)="([^"?#]+)"/g)) {
    if (/^(?:[a-z]+:|\/\/)/i.test(match[1])) continue;
    if (!fs.existsSync(path.resolve(root, match[1]))) { console.error(file + ': missing asset ' + match[1]); failures++; }
  }
}
for (const file of ['tracker-safety.js', 'sw.js']) {
  const result = spawnSync(process.execPath, ['--check', path.join(root, file)], { encoding: 'utf8' });
  if (result.status !== 0) { console.error(result.stderr); failures++; }
}
if (failures) process.exitCode = 1;
else console.log('Main and mobile modules, local assets, helper, and service worker validated.');
