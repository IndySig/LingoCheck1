/**
 * Cross-platform Okapi installer entrypoint for CI / Render.
 * Windows: setup-okapi.ps1
 * Linux/macOS: setup-okapi.sh
 */
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..');
const isWin = process.platform === 'win32';

function run(cmd, args) {
  console.log(`[setup-okapi] ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: isWin });
  if (r.error) throw r.error;
  if (r.status !== 0) process.exit(r.status || 1);
}

if (isWin) {
  const ps1 = path.join(__dirname, 'setup-okapi.ps1');
  if (!fs.existsSync(ps1)) {
    console.error('Missing scripts/setup-okapi.ps1');
    process.exit(1);
  }
  run('powershell', ['-ExecutionPolicy', 'Bypass', '-File', ps1]);
} else {
  const sh = path.join(__dirname, 'setup-okapi.sh');
  if (!fs.existsSync(sh)) {
    console.error('Missing scripts/setup-okapi.sh');
    process.exit(1);
  }
  fs.chmodSync(sh, 0o755);
  run('bash', [sh]);
}
