const fs = require('node:fs');
const readline = require('node:readline/promises');
const { spawnSync } = require('node:child_process');
const { findDockerCommand } = require('./docker-cli.js');

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const stop = await rl.question('Stop and remove SANWAN containers now? Type STOP to continue: ');
    if (stop !== 'STOP') { console.log('Cancelled. SANWAN was left running.'); return; }
    const purge = await rl.question('Also erase the encrypted database, logs, and worker state? Type PURGE to confirm, or press Enter to preserve them: ');
    if (purge && purge !== 'PURGE') { console.log('Cancelled. No changes were made.'); return; }
    const args = ['compose', '-f', 'docker-compose.yml', '-f', 'docker-compose.worker.yml', '--profile', 'deployment', 'down', '--remove-orphans'];
    if (purge === 'PURGE') args.push('--volumes');
    const result = spawnSync(findDockerCommand(), args, { encoding: 'utf8', windowsHide: true, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Docker Compose could not stop SANWAN (exit ${result.status}). No local config was removed.`);
    if (purge === 'PURGE') {
      fs.rmSync('data', { recursive: true, force: true });
      fs.rmSync('logs', { recursive: true, force: true });
      if (fs.existsSync('.env')) fs.rmSync('.env');
      console.log('SANWAN containers and persistent volumes were removed. Local service definitions were preserved.');
    } else {
      console.log('SANWAN containers were removed. Database, logs, worker state, and .env were preserved.');
    }
  } finally { rl.close(); }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
