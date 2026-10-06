const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const readline = require('node:readline/promises');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { findDockerCommand } = require('./docker-cli.js');

function readSecret(prompt) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
      reject(new Error('Run setup in an interactive terminal so credentials can be entered without echo.'));
      return;
    }
    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    let value = '';
    const onData = chunk => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\u0003') { cleanup(); reject(new Error('Setup cancelled.')); return; }
        if (char === '\r' || char === '\n') { cleanup(); process.stdout.write('\n'); resolve(value); return; }
        if (char === '\u007f' || char === '\b') value = value.slice(0,-1);
        else if (char >= ' ') value += char;
      }
    };
    const cleanup = () => { process.stdin.off('data', onData); process.stdin.setRawMode(false); };
    process.stdin.on('data', onData);
  });
}

function isDiscordId(value) {
  return /^\d{17,20}$/.test(value.trim());
}

function validateComposeConfig(dockerCommand,composeBase,env,{cwd=process.cwd(),run=spawnSync}={}){
  const envFile=`.env.sanwan-setup-${crypto.randomBytes(8).toString('hex')}`;
  const envPath=path.join(cwd,envFile);
  try{
    fs.writeFileSync(envPath,env,{mode:0o600,flag:'wx'});
    if(process.platform!=='win32') fs.chmodSync(envPath,0o600);
    const result=run(dockerCommand,[...composeBase,'--env-file',envFile,'config','--quiet'],{
      cwd,encoding:'utf8',windowsHide:true,env:{...process.env,SANWAN_ENV_FILE:envFile}
    });
    if(result.error) throw result.error;
    if(result.status!==0) throw new Error('Docker Compose configuration validation failed; the existing .env was left unchanged.');
    return true;
  }finally{if(fs.existsSync(envPath))fs.rmSync(envPath);}
}

async function main() {
  const platform = `${os.platform()} ${os.arch()}`;
  console.log(`SANWAN setup · detected ${platform}`);
  const profiles = ['Linux x64','Linux ARM64','Windows Docker Desktop x64','Windows Docker Desktop ARM64'];
  console.log(`Supported target profiles: ${profiles.map((p,i)=>`${i+1}) ${p}`).join(' · ')}`);
  if (!['linux', 'win32'].includes(os.platform()) || !['x64', 'arm64'].includes(os.arch())) throw new Error('Supported setup targets are Linux x64/ARM64 and Windows x64/ARM64 with Docker Desktop Linux containers.');
  const target = os.platform()==='win32'
    ?`Windows Docker Desktop ${os.arch()==='arm64'?'ARM64':'x64'}`
    :`Linux ${os.arch()==='arm64'?'ARM64':'x64'}`;
  const selectRl=readline.createInterface({input:process.stdin,output:process.stdout});
  try {
    const selected=await selectRl.question(`Select the profile for this host [${target}]: `);
    if(selected.trim() && profiles[Number(selected.trim())-1]!==target) throw new Error(`This setup process is running on ${target}; run it on the selected host profile.`);
  } finally {selectRl.close();}
  console.log(`Target profile: ${target}`);
  const dockerCommand=findDockerCommand();
  let dockerEngineAvailable=false;
  let dockerComposeAvailable=false;
  for (const [label, args] of [['Docker Engine', ['version','--format','{{.Server.Version}}']], ['Docker Compose v2', ['compose','version','--short']]]) {
    const capability = spawnSync(dockerCommand, args, { encoding: 'utf8', windowsHide: true });
    if(label==='Docker Engine') dockerEngineAvailable=capability.status===0;
    if(label==='Docker Compose v2') dockerComposeAvailable=capability.status===0;
    console.log(`${label}: ${capability.status === 0 ? 'available' : 'not detected (CI and status commands remain available; local deployment is disabled)'}`);
  }
  const dockerSecurity=dockerEngineAvailable?spawnSync(dockerCommand,['info','--format','{{json .SecurityOptions}}'],{encoding:'utf8',windowsHide:true}):undefined;
  let rootlessDockerAvailable=false;
  if(dockerSecurity?.status===0){try{rootlessDockerAvailable=(JSON.parse(dockerSecurity.stdout)||[]).some(value=>/rootless/i.test(String(value)));}catch{}}
  console.log(`Rootless Docker (deployment worker): ${rootlessDockerAvailable?'available':'not detected; worker deployments will remain disabled'}`);
  const composeBase=['compose','-f','docker-compose.yml'];
  let rl;
  try {
    let existing = {};
    if (fs.existsSync('.env')) {
      rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question('Existing .env found. Preserve its values and fill missing keys? [Y/n] ');
      if (!/^y(es)?$/i.test(answer || 'y')) throw new Error('Setup cancelled; existing configuration was left unchanged.');
      for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) { const i=line.indexOf('='); if(i>0) existing[line.slice(0,i)]=line.slice(i+1); }
      rl.close();
      rl = undefined;
    }
    const discordToken = existing.DISCORD_TOKEN || await readSecret('Discord bot token (input hidden): ');
    const githubToken = existing.GITHUB_TOKEN || await readSecret('GitHub token, press Enter to skip (input hidden): ');
    const ghcrToken = existing.GHCR_TOKEN || await readSecret('Optional GHCR read token, press Enter to skip (input hidden): ');
    const askApiKey = existing.ASK_API_KEY || await readSecret('Optional AI provider API key, press Enter to skip (input hidden): ');
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = async (key, prompt, optional=false) => existing[key] || await rl.question(`${prompt}${optional?' (optional)':''}: `);
    const defaultDockerSocket=process.env.DOCKER_HOST?.replace(/^unix:\/\//,'')||(os.platform()==='win32'?'':`${process.env.XDG_RUNTIME_DIR||`/run/user/${process.getuid?.()??1000}`}/docker.sock`);
    const dockerSocketPath=await ask('DOCKER_SOCKET_PATH',`Rootless Docker socket path [${defaultDockerSocket}]`,true);
    const socketPath=dockerSocketPath.trim()||defaultDockerSocket;
    let defaultSocketGid='1000';
    try { defaultSocketGid=String(fs.statSync(socketPath).gid); } catch {}
    const values = {
      DISCORD_TOKEN: discordToken,
      DISCORD_APPLICATION_ID: await ask('DISCORD_APPLICATION_ID','Discord application ID'),
      DISCORD_GUILD_ID: await ask('DISCORD_GUILD_ID','Discord server ID'),
      AUTHORIZED_ROLE_IDS: await ask('AUTHORIZED_ROLE_IDS','Roles allowed to inspect CI and deployment (comma-separated role IDs)',true),
      GITHUB_TOKEN: githubToken,
      GHCR_USERNAME: await ask('GHCR_USERNAME','GitHub username for private GHCR images',true),
      GHCR_TOKEN: ghcrToken,
      ASK_PROVIDER: await ask('ASK_PROVIDER','Optional AI provider (ollama or openai-compatible)',true),
      ASK_BASE_URL: await ask('ASK_BASE_URL','Optional AI API base URL',true),
      ASK_MODEL: await ask('ASK_MODEL','Optional initial AI model ID',true),
      ASK_API_KEY: askApiKey,
      GITHUB_REPOSITORIES: await ask('GITHUB_REPOSITORIES','Allowed repositories (comma-separated owner/repo)',true),
      GITHUB_CHANNEL_ID: await ask('GITHUB_CHANNEL_ID','Optional GitHub update channel ID',true),
      TASK_CHANNEL_ID: await ask('TASK_CHANNEL_ID','Optional task notification channel ID',true),
      ERROR_CHANNEL_ID: await ask('ERROR_CHANNEL_ID','Optional error channel ID',true),
      APPROVAL_CHANNEL_ID: await ask('APPROVAL_CHANNEL_ID','Optional production approval channel ID (blank uses request channel)',true),
      SQLITE_KEY: existing.SQLITE_KEY || crypto.randomBytes(32).toString('hex'),
      WORKER_TOKEN: existing.WORKER_TOKEN || crypto.randomBytes(32).toString('hex'),
      DOCKER_SOCKET_PATH: socketPath,
      DOCKER_SOCKET_GID: await ask('DOCKER_SOCKET_GID',`Rootless Docker socket group ID [${defaultSocketGid}]`,true)||defaultSocketGid
    };
    for (const name of ['DISCORD_TOKEN','DISCORD_APPLICATION_ID','DISCORD_GUILD_ID']) {
      if (!values[name]?.trim()) throw new Error(`${name} is required; configuration was not written.`);
    }
    for (const name of ['DISCORD_APPLICATION_ID','DISCORD_GUILD_ID']) {
      if (!isDiscordId(values[name])) throw new Error(`${name} must be a Discord snowflake ID (17–20 digits); configuration was not written.`);
    }
    const env = Object.entries(values).map(([k,v])=>`${k}=${v}`).join('\n')+'\n';
    fs.mkdirSync('config',{recursive:true});
    fs.mkdirSync('services',{recursive:true});
    if(!fs.existsSync('config/services.json')) fs.writeFileSync('config/services.json','{\n  "services": {}\n}\n',{mode:0o600,flag:'wx'});
    if(!fs.existsSync('services/README.md')) fs.writeFileSync('services/README.md','Place locally controlled Compose definitions here. Define only named volumes, provide a healthcheck, and use published images. Never put this directory under a GitHub checkout.\n',{mode:0o600,flag:'wx'});
    if(dockerComposeAvailable){
      validateComposeConfig(dockerCommand,composeBase,env);
      console.log('Docker Compose configuration validated.');
    }else console.log('Docker Compose configuration validation skipped; Compose v2 is unavailable.');
    fs.writeFileSync('.env', env, { mode: 0o600, flag: 'w' });
    if (process.platform !== 'win32') fs.chmodSync('.env', 0o600);
    console.log('\nWrote .env with a generated 256-bit database key. Keep a protected backup of SQLITE_KEY; losing it makes the database unreadable.');
    console.log(`Detected architecture: ${platform}. The restricted deployment worker is available as the optional Docker Compose deployment profile. Configure config/services.json before enabling it.`);
    const launchRl=readline.createInterface({input:process.stdin,output:process.stdout});
    try {
      const launch=await launchRl.question('Build and start SANWAN in Docker now? [Y/n] ');
      if(!/^y(es)?$/i.test(launch||'y')) return;
      if(!dockerEngineAvailable){console.log('Docker Engine is unavailable. Start Docker Desktop or Docker Engine, then run docker compose up -d --build.');return;}
      const composeVersion=spawnSync(dockerCommand,['compose','version','--short'],{encoding:'utf8',windowsHide:true});
      if(composeVersion.status!==0){console.log('Docker Compose v2 is unavailable. Install or enable the Compose plugin, then run docker compose up -d --build.');return;}
      const args=[...composeBase,'--env-file','.env','up','-d','--build'];
      const result=spawnSync(dockerCommand,args,{encoding:'utf8',windowsHide:true,stdio:'inherit',env:{...process.env,SANWAN_ENV_FILE:'.env'}});
      if(result.error) throw result.error;
      if(result.status!==0) throw new Error(`Docker Compose failed to build or start SANWAN (exit ${result.status}). Configuration was retained.`);
      console.log('SANWAN is running in Docker. Check status with docker compose ps and logs with docker compose logs -f sanwan.');
    } finally {launchRl.close();}
  } finally { rl.close(); }
}
if(require.main===module) main().catch(e=>{ console.error(e.message); process.exitCode=1; });
module.exports={isDiscordId,validateComposeConfig};
