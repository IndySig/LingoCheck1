/**
 * Ensure Okapi+JRE are present before the server starts.
 * Used on Render when Build Command was not set to `npm run build`.
 */
const { spawnSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const okapi = require(path.join(root, 'okapi.js'));

const status = okapi.getStatus();
if (status.ready) {
  console.log('[LingoCheck] Okapi already ready');
  process.exit(0);
}

console.log(`[LingoCheck] Okapi not ready (${status.message}). Installing...`);
const setup = path.join(__dirname, 'setup-okapi-auto.js');
const result = spawnSync(process.execPath, [setup], {
  cwd: root,
  stdio: 'inherit',
  env: process.env
});

if (result.status !== 0) {
  console.error('[LingoCheck] Okapi install failed — DOCX will use the browser fallback layout path.');
  // Do not block server start; translation still works without Okapi.
  process.exit(0);
}

const after = okapi.getStatus();
if (after.ready) {
  console.log(`[LingoCheck] Okapi install complete (${after.okapiHome})`);
} else {
  console.error(`[LingoCheck] Okapi still not ready after install: ${after.message}`);
}
process.exit(0);
