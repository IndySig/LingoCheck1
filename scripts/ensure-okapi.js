/**
 * Ensure Okapi+JRE are present before the server starts.
 * Used on Render when Build Command was not set to `npm run build`.
 */
const { spawnSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const okapi = require(path.join(root, 'okapi.js'));

function report(status, label) {
  if (status.ready) {
    console.log(`[LingoCheck] Okapi ready (${status.okapiHome})${label ? ` ${label}` : ''}`);
    return true;
  }
  console.log(`[LingoCheck] Okapi not ready${label ? ` ${label}` : ''}: ${status.message}`);
  return false;
}

if (report(okapi.getStatus(), 'before setup')) {
  process.exit(0);
}

console.log('[LingoCheck] Installing Okapi (Java + Tikal)...');
const setup = path.join(__dirname, 'setup-okapi-auto.js');
const result = spawnSync(process.execPath, [setup], {
  cwd: root,
  stdio: 'inherit',
  env: process.env
});

const after = okapi.getStatus();
if (report(after, 'after setup')) {
  process.exit(0);
}

if (result.status !== 0) {
  console.error(`[LingoCheck] Okapi setup exited with code ${result.status}.`);
}
console.error('[LingoCheck] Okapi still unavailable — DOCX will use the browser fallback layout path.');
// Do not block server start; translation still works without Okapi.
process.exit(0);
