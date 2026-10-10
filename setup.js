const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const readline = require('node:readline/promises');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { findDockerCommand } = require('./docker-cli.js');
const { runSavedChecks } = require('./setup-checks.js');

function readSecret(label) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
      reject(new Error('Run setup in an interactive terminal so credentials can be entered without echo.'));
      return;
    }
    process.stdout.write(label);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.resume();
    let value = '';
    const cleanup = () => { process.stdin.off('data', onData); process.stdin.setRawMode(false); };
    const onData = chunk => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\u0003') { cleanup(); process.stdout.write('\n'); reject(new Error('Setup cancelled.')); return; }
        if (char === '\r' || char === '\n') { cleanup(); process.stdout.write('\n'); resolve(value); return; }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ') value += char;
      }
    };
    process.stdin.on('data', onData);
  });
}

function isDiscordId(value) { return /^\d{17,20}$/.test(value.trim()); }
function parseChoice(value, allowed, fallback) {
  const selected = value.trim() || fallback;
  return allowed.includes(selected) ? selected : undefined;
}
function discordFieldError(key, value) {
  if (!value.trim()) return 'This value is required.';
  if (key !== 'DISCORD_TOKEN' && !isDiscordId(value)) return 'Enter a numeric Discord ID of 17 to 20 digits.';
  return undefined;
}
async function prompt(label) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { return await rl.question(label); } finally { rl.close(); }
}
async function choice(label, allowed, fallback) {
  while (true) {
    const selected = parseChoice(await prompt(label), allowed, fallback);
    if (selected) return selected;
    console.log(`  Choose ${allowed.join(', ')}.`);
  }
}
async function required(key, label, existing, secret = false) {
  if (existing[key]?.trim()) { console.log(`  ${label}: already configured`); return existing[key]; }
  while (true) {
    const value = secret ? await readSecret(`  ${label} (hidden): `) : await prompt(`  ${label}: `);
    const error = discordFieldError(key, value);
    if (!error) return value.trim();
    console.log(`  ${error}${key === 'DISCORD_GUILD_ID' ? ' Enable Developer Mode in Discord to copy your server ID.' : ''}`);
  }
}
async function optional(key, label, values, secret = false, io = {}) {
  const askChoice = io.choice || choice;
  const ask = io.prompt || prompt;
  const askSecret = io.readSecret || readSecret;
  const existing = values[key]?.trim();
  if (existing) {
    console.log(`  ${label}: already configured`);
    if (await askChoice('  1) Keep existing  2) Replace [1]: ', ['1', '2'], '1') === '1') return;
  }
  const name = `${existing ? 'New ' : ''}${label}`;
  const hint = existing ? 'keep existing' : 'skip';
  const value = (secret ? await askSecret(`  ${name} (hidden, Enter to ${hint}): `) : await ask(`  ${name} (Enter to ${hint}): `)).trim();
  if (value) values[key] = value;
}

function validateComposeConfig(dockerCommand, composeBase, env, { cwd = process.cwd(), run = spawnSync } = {}) {
  const envFile = `.env.sanwan-setup-${crypto.randomBytes(8).toString('hex')}`;
  const envPath = path.join(cwd, envFile);
  try {
    fs.writeFileSync(envPath, env, { mode: 0o600, flag: 'wx' });
    if (process.platform !== 'win32') fs.chmodSync(envPath, 0o600);
    const result = run(dockerCommand, [...composeBase, '--env-file', envFile, 'config', '--quiet'], {
      cwd, encoding: 'utf8', windowsHide: true, env: { ...process.env, SANWAN_ENV_FILE: envFile }
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error('Docker Compose configuration validation failed; the existing .env was left unchanged.');
    return true;
  } finally { if (fs.existsSync(envPath)) fs.rmSync(envPath); }
}

async function main() {
  if (!['linux', 'win32'].includes(os.platform()) || !['x64', 'arm64'].includes(os.arch())) {
    throw new Error('Supported setup targets are Linux x64/ARM64 and Windows x64/ARM64 with Docker Desktop Linux containers.');
  }
  const target = os.platform() === 'win32' ? `Windows Docker Desktop ${os.arch()}` : `Linux ${os.arch()}`;
  console.log('\nSANWAN setup');
  console.log(`Detected host: ${target}`);
  console.log('Four steps: Discord, optional features, Docker check, and launch.');
  const existing = {};
  if (fs.existsSync('.env')) {
    console.log('\nExisting .env found. Optional settings can be kept or replaced.');
    const mode = await choice('  1) Configure  2) Check saved setup  3) Cancel [1]: ', ['1', '2', '3'], '1');
    if (mode === '3') return;
    if (mode === '2') { await runSavedChecks(); return; }
    for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
      const i = line.indexOf('=');
      if (i > 0) existing[line.slice(0, i)] = line.slice(i + 1);
    }
  }
  const values = { ...existing };
  console.log('\n[1/4] Connect Discord');
  console.log('  Create an app at discord.com/developers/applications and open its Bot page.');
  console.log('  Invite it with the bot and applications.commands scopes.');
  values.DISCORD_TOKEN = await required('DISCORD_TOKEN', 'Bot token', existing, true);
  console.log('  Copy Application ID from the app General Information page.');
  values.DISCORD_APPLICATION_ID = await required('DISCORD_APPLICATION_ID', 'Application ID', existing);
  console.log('  Enable Developer Mode in Discord, right-click the server, and copy its ID.');
  values.DISCORD_GUILD_ID = await required('DISCORD_GUILD_ID', 'Server ID', existing);

  console.log('\n[2/4] Optional features');
  console.log('  Configure features now or rerun setup later.');
  while (true) {
    console.log('  1) Continue  2) GitHub monitoring  3) AI chat  4) Advanced settings');
    const selected = await choice('  Choice [1]: ', ['1', '2', '3', '4'], '1');
    if (selected === '1') break;
    if (selected === '2') {
      console.log('  GitHub monitoring needs a token and an owner/repo allowlist.');
      console.log('  Monitors workflow runs, pushes, and branch creation/deletion. Set a channel to receive updates.');
      await optional('GITHUB_TOKEN', 'GitHub token', values, true);
      await optional('GITHUB_REPOSITORIES', 'Repositories (comma-separated owner/repo)', values);
      await optional('GITHUB_CHANNEL_ID', 'GitHub update channel ID', values);
    } else if (selected === '3') {
      console.log('  AI chat needs a provider (ollama or openai-compatible) and API base URL.');
      await optional('ASK_PROVIDER', 'AI provider', values);
      await optional('ASK_BASE_URL', 'AI API base URL', values);
      await optional('ASK_MODEL', 'Initial model ID', values);
      await optional('ASK_API_KEY', 'AI API key', values, true);
    } else {
      console.log('  Advanced settings cover roles, channels, private GHCR, and the Linux worker.');
      await optional('AUTHORIZED_ROLE_IDS', 'Authorized role IDs (comma-separated)', values);
      await optional('TASK_CHANNEL_ID', 'Task notification channel ID', values);
      await optional('ERROR_CHANNEL_ID', 'Error channel ID', values);
      await optional('APPROVAL_CHANNEL_ID', 'Production approval channel ID', values);
      await optional('GHCR_USERNAME', 'GHCR username', values);
      await optional('GHCR_TOKEN', 'GHCR read token', values, true);
      if (os.platform() === 'win32') console.log('  Deployment worker requires rootless Linux Docker; Docker Desktop cannot run it.');
      else {
        const socket = process.env.DOCKER_HOST?.replace(/^unix:\/\//, '') || `${process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 1000}`}/docker.sock`;
        if (!values.DOCKER_SOCKET_PATH) values.DOCKER_SOCKET_PATH = (await prompt(`  Rootless Docker socket [${socket}]: `)).trim() || socket;
        let gid = '1000';
        try { gid = String(fs.statSync(values.DOCKER_SOCKET_PATH).gid); } catch {}
        if (!values.DOCKER_SOCKET_GID) values.DOCKER_SOCKET_GID = (await prompt(`  Socket group ID [${gid}]: `)).trim() || gid;
      }
    }
  }
  values.SQLITE_KEY ||= crypto.randomBytes(32).toString('hex');
  values.WORKER_TOKEN ||= crypto.randomBytes(32).toString('hex');
  values.DOCKER_SOCKET_PATH ||= os.platform() === 'win32' ? '' : process.env.DOCKER_HOST?.replace(/^unix:\/\//, '') || `${process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 1000}`}/docker.sock`;
  values.DOCKER_SOCKET_GID ||= '1000';

  console.log('\n[3/4] Check Docker');
  const dockerCommand = findDockerCommand();
  const engine = spawnSync(dockerCommand, ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8', windowsHide: true });
  const compose = spawnSync(dockerCommand, ['compose', 'version', '--short'], { encoding: 'utf8', windowsHide: true });
  const engineReady = engine.status === 0;
  const composeReady = compose.status === 0;
  console.log(`  Docker Engine: ${engineReady ? 'ready' : 'unavailable'}`);
  console.log(`  Docker Compose v2: ${composeReady ? 'ready' : 'unavailable'}`);
  if (!engineReady) console.log(os.platform() === 'win32' ? '  Start Docker Desktop and wait for its Linux engine to run.' : '  Start Docker Engine before launching SANWAN.');
  if (!composeReady) console.log('  Install or enable Docker Compose v2 before launching SANWAN.');
  if (os.platform() === 'win32') console.log('  Deployment worker: requires rootless Linux Docker.');
  else if (engineReady) {
    const security = spawnSync(dockerCommand, ['info', '--format', '{{json .SecurityOptions}}'], { encoding: 'utf8', windowsHide: true });
    let rootless = false;
    if (security.status === 0) { try { rootless = (JSON.parse(security.stdout) || []).some(x => /rootless/i.test(String(x))); } catch {} }
    console.log(`  Deployment worker: ${rootless ? 'rootless Docker detected' : 'requires a rootless Docker daemon'}`);
  }
  const env = Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n';
  if (composeReady) {
    validateComposeConfig(dockerCommand, ['compose', '-f', 'docker-compose.yml'], env);
    console.log('  Compose configuration: valid');
  } else console.log('  Compose configuration: check skipped');
  fs.mkdirSync('config', { recursive: true });
  fs.mkdirSync('services', { recursive: true });
  if (!fs.existsSync('config/services.json')) fs.writeFileSync('config/services.json', '{\n  "services": {}\n}\n', { mode: 0o600, flag: 'wx' });
  if (!fs.existsSync('services/README.md')) fs.writeFileSync('services/README.md', 'Place locally controlled Compose definitions here. Define only named volumes, provide a healthcheck, and use published images. Never put this directory under a GitHub checkout.\n', { mode: 0o600, flag: 'wx' });
  fs.writeFileSync('.env', env, { mode: 0o600, flag: 'w' });
  if (process.platform !== 'win32') fs.chmodSync('.env', 0o600);

  console.log('\n[4/4] Finish and launch');
  console.log('  Saved .env and local configuration. Discord is configured.');
  console.log('  Keep a protected backup of SQLITE_KEY; losing it makes the database unreadable.');
  if (values.GITHUB_TOKEN && values.GITHUB_REPOSITORIES) console.log('  GitHub monitoring: configured');
  if (values.ASK_PROVIDER && values.ASK_BASE_URL) console.log('  AI chat: configured');
  if (!engineReady || !composeReady) {
    console.log('  When Docker is ready, run: docker compose up -d --build');
    console.log('  Then try /ping in your Discord server.');
    return;
  }
  if (await choice('  Build and start SANWAN now? 1) Yes  2) Later [1]: ', ['1', '2'], '1') === '2') {
    console.log('  Start later with: docker compose up -d --build');
    return;
  }
  const result = spawnSync(dockerCommand, ['compose', '-f', 'docker-compose.yml', '--env-file', '.env', 'up', '-d', '--build'], {
    windowsHide: true, stdio: 'inherit', env: { ...process.env, SANWAN_ENV_FILE: '.env' }
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Docker Compose failed to build or start SANWAN (exit ${result.status}). Configuration was retained.`);
  console.log('  SANWAN is running. Try /ping in Discord. Check logs with docker compose logs -f sanwan.');
  if (await choice('  Connectivity checks: 1) Run checks  2) Skip [1]: ', ['1', '2'], '1') === '1') await runSavedChecks();
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { isDiscordId, parseChoice, discordFieldError, optional, validateComposeConfig };
