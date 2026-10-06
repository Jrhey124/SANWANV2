import 'dotenv/config';
import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } from 'discord.js';
import Database from 'better-sqlite3-multiple-ciphers';
import { mkdirSync, appendFileSync, existsSync, readFileSync, readdirSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import * as os from 'node:os';
import { clearHeartbeat, writeHeartbeat, writeHeartbeatAfterReady } from './health.js';
import { classifyGitHubRunChange, hasConfiguredNotificationRoute, type GitHubTriggerName } from './github-events.js';
import { guildCommandRoute } from './discord-registration.js';
import { readContainerLimits } from './resource-limits.js';

const dataDir = process.env.DATA_DIR ?? 'data';
const logDir = process.env.LOG_DIR ?? 'logs';
mkdirSync(dataDir, { recursive: true }); mkdirSync(logDir, { recursive: true });
function log(level: string, message: string) {
  let safe = message.replace(/(token|secret|key)=\S+/gi, '$1=[REDACTED]');
  for (const secret of [process.env.DISCORD_TOKEN, process.env.GITHUB_TOKEN, process.env.GHCR_TOKEN, process.env.ASK_API_KEY, process.env.SQLITE_KEY, process.env.WORKER_TOKEN]) {
    if (secret && secret.length >= 8) safe = safe.replaceAll(secret, '[REDACTED]');
  }
  const line = `${new Date().toISOString()} ${level} ${safe}\n`;
  appendFileSync(join(logDir, 'sanwan.log'), line, { mode: 0o600 });
  if (level === 'ERROR') console.error(line.trim());
}

const key = process.env.SQLITE_KEY;
if (!key || key.length < 32) throw new Error('SQLITE_KEY must be set to a randomly generated value of at least 32 characters.');
const db = new Database(join(dataDir, 'sanwan.db'));
db.pragma("cipher = 'sqlcipher'");
db.key(Buffer.from(key, 'utf8'));
db.pragma('journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS task (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, assignee TEXT NOT NULL, deadline TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', description TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS note (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS inbox (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS github_run (repository TEXT NOT NULL, run_id INTEGER NOT NULL, workflow TEXT NOT NULL, status TEXT NOT NULL, conclusion TEXT, branch TEXT NOT NULL, sha TEXT NOT NULL, url TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(repository,run_id));
CREATE TABLE IF NOT EXISTS setting (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS schedule (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, interval_seconds INTEGER NOT NULL, action TEXT NOT NULL, next_run TEXT NOT NULL, updated_at TEXT NOT NULL, trigger TEXT NOT NULL DEFAULT 'interval');
CREATE TABLE IF NOT EXISTS schedule_history (id INTEGER PRIMARY KEY AUTOINCREMENT, schedule_id INTEGER, name TEXT NOT NULL, action TEXT NOT NULL, status TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS task_reminder (task_id INTEGER NOT NULL, deadline TEXT NOT NULL, kind TEXT NOT NULL, sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(task_id,deadline,kind));
CREATE TABLE IF NOT EXISTS pending_deployment (id INTEGER PRIMARY KEY AUTOINCREMENT, service TEXT NOT NULL, environment TEXT NOT NULL, sha TEXT NOT NULL, requester TEXT NOT NULL, status TEXT NOT NULL, expires_at TEXT NOT NULL, operation TEXT NOT NULL DEFAULT 'release', image_digest TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS staging_deployment (service TEXT NOT NULL, sha TEXT NOT NULL, status TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, attempts INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(service,sha));
CREATE TABLE IF NOT EXISTS event (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);`);
try{db.exec("ALTER TABLE schedule ADD COLUMN trigger TEXT NOT NULL DEFAULT 'interval'");}catch(error){if(!(error instanceof Error)||!error.message.includes('duplicate column name'))throw error;}
try{db.exec("ALTER TABLE pending_deployment ADD COLUMN operation TEXT NOT NULL DEFAULT 'release'");}catch(error){if(!(error instanceof Error)||!error.message.includes('duplicate column name'))throw error;}
try{db.exec('ALTER TABLE pending_deployment ADD COLUMN image_digest TEXT');}catch(error){if(!(error instanceof Error)||!error.message.includes('duplicate column name'))throw error;}
try{db.exec('ALTER TABLE staging_deployment ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1');}catch(error){if(!(error instanceof Error)||!error.message.includes('duplicate column name'))throw error;}
const isIsoDeadline = (value: string) => /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2}))?$/.test(value) && Number.isFinite(Date.parse(value));
const askLastRequest=new Map<string,number>();
let askRequestsInFlight=0;

type EnvironmentName='staging'|'production';
type ServiceSpec={github_repository:string;workflow_name:string;staging_branch:string;production_branch:string;image_repository:string;environments:Record<EnvironmentName,{compose_project:string;compose_file:string;compose_service:string;health_timeout_seconds?:number}>};
type ServiceRegistry={services:Record<string,ServiceSpec>};
const servicesConfigPath=process.env.SERVICES_CONFIG??'config/services.json';
function readServiceRegistry():ServiceRegistry {
  if(!existsSync(servicesConfigPath)) return {services:{}};
  const data=JSON.parse(readFileSync(servicesConfigPath,'utf8')) as ServiceRegistry;
  if(!data.services||typeof data.services!=='object') throw new Error('SERVICES_CONFIG must contain a services object.');
  return data;
}
function registeredService(name:string){const registry=readServiceRegistry();if(!Object.hasOwn(registry.services,name))throw new Error(`Service ${name} is not locally registered.`);return registry.services[name];}
async function workerCall(body:Record<string,unknown>){
  const workerToken=process.env.WORKER_TOKEN;
  const url=process.env.WORKER_URL;
  if(!workerToken||workerToken.length<64||!url) throw new Error('Deployment worker is not enabled. Start the worker profile and configure WORKER_TOKEN.');
  const response=await fetch(`${url}/v1/action`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${workerToken}`},body:JSON.stringify(body),signal:AbortSignal.timeout(360_000)});
  const result=await response.json() as {error?:string;[key:string]:unknown};
  if(!response.ok) throw new Error(result.error??`Deployment worker returned HTTP ${response.status}.`);
  return result;
}
async function verifyRelease(service:ServiceSpec,environment:EnvironmentName,sha:string){
  if(!/^[a-f0-9]{40}$/i.test(sha)) throw new Error('Commit must be a full 40-character SHA.');
  const allowed=(process.env.GITHUB_REPOSITORIES??'').split(',').map(s=>s.trim()).filter(Boolean);
  if(!allowed.includes(service.github_repository)) throw new Error('Service repository is not in the local GitHub allowlist.');
  if(!process.env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN is required to verify a release.');
  const branch=environment==='staging'?service.staging_branch:service.production_branch;
  const response=await fetch(`https://api.github.com/repos/${service.github_repository}/actions/runs?head_sha=${sha}&per_page=100`,{headers:{Authorization:`Bearer ${process.env.GITHUB_TOKEN}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'},signal:AbortSignal.timeout(15000)});
  if(!response.ok) throw new Error(`GitHub could not verify the release (HTTP ${response.status}).`);
  const payload=await response.json() as {workflow_runs?:Array<{name:string;head_branch:string;head_sha:string;status:string;conclusion:string|null;event:string;run_number:number;head_repository?:{full_name:string}|null}>};
  const validRuns=(payload.workflow_runs??[]).filter(run=>run.name===service.workflow_name&&run.event==='push'&&run.head_repository?.full_name.toLowerCase()===service.github_repository.toLowerCase()&&run.head_branch===branch&&run.status==='completed'&&run.conclusion==='success');
  if(!validRuns.some(run=>run.head_sha.toLowerCase()===sha.toLowerCase())) throw new Error(`No successful ${service.workflow_name} push run for ${sha.slice(0,7)} on configured ${branch} branch.`);
  if(environment==='production'){
    const latestResponse=await fetch(`https://api.github.com/repos/${service.github_repository}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=100`,{headers:{Authorization:`Bearer ${process.env.GITHUB_TOKEN}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'},signal:AbortSignal.timeout(15000)});
    if(!latestResponse.ok) throw new Error(`GitHub could not confirm the latest production candidate (HTTP ${latestResponse.status}).`);
    const latestPayload=await latestResponse.json() as {workflow_runs?:Array<{name:string;head_branch:string;head_sha:string;event:string;run_number:number;status:string;conclusion:string|null;head_repository?:{full_name:string}|null}>};
    const latest=(latestPayload.workflow_runs??[]).filter(run=>run.name===service.workflow_name&&run.event==='push'&&run.head_repository?.full_name.toLowerCase()===service.github_repository.toLowerCase()&&run.head_branch===branch&&run.status==='completed'&&run.conclusion==='success').sort((a,b)=>b.run_number-a.run_number)[0];
    if(!latest||latest.head_sha.toLowerCase()!==sha.toLowerCase()) throw new Error('A newer successful production release exists; request approval for the latest commit.');
  }
}
function askConfig(){
  const provider=process.env.ASK_PROVIDER;
  const base=process.env.ASK_BASE_URL;
  if(!provider||!base) throw new Error('AI chat is disabled. Configure ASK_PROVIDER and ASK_BASE_URL locally.');
  if(!['ollama','openai-compatible'].includes(provider)) throw new Error('ASK_PROVIDER must be ollama or openai-compatible.');
  const url=new URL(base);
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password) throw new Error('ASK_BASE_URL must be an HTTP(S) URL without embedded credentials.');
  if(process.env.ASK_API_KEY&&url.protocol==='http:'&&!['localhost','127.0.0.1','::1','ollama','host.docker.internal'].includes(url.hostname)) throw new Error('Use HTTPS when ASK_API_KEY is sent to a non-local AI provider.');
  const model=(db.prepare("SELECT value FROM setting WHERE key='ask_model'").get() as {value:string}|undefined)?.value||process.env.ASK_MODEL;
  if(!model) throw new Error('Set ASK_MODEL before using /ask.');
  return {provider,base:base.replace(/\/+$/,''),model};
}
async function askModels(){
  const config=askConfig();
  const path=config.provider==='ollama'?'/api/tags':'/models';
  const response=await fetch(`${config.base}${path}`,{headers:process.env.ASK_API_KEY?{Authorization:`Bearer ${process.env.ASK_API_KEY}`}:{},signal:AbortSignal.timeout(15000)});
  if(!response.ok) throw new Error(`AI provider model list returned HTTP ${response.status}.`);
  const payload=await response.json() as {models?:Array<{name:string}>;data?:Array<{id:string}>};
  return (config.provider==='ollama'?payload.models?.map(m=>m.name):payload.data?.map(m=>m.id))??[];
}
async function askProvider(question:string){
  const config=askConfig();
  const url=`${config.base}${config.provider==='ollama'?'/api/chat':'/chat/completions'}`;
  const headers:Record<string,string>={'content-type':'application/json'};
  if(process.env.ASK_API_KEY) headers.Authorization=`Bearer ${process.env.ASK_API_KEY}`;
  const body=config.provider==='ollama'?{model:config.model,messages:[{role:'user',content:question}],stream:false}:{model:config.model,messages:[{role:'user',content:question}],stream:false};
  const response=await fetch(url,{method:'POST',headers,body:JSON.stringify(body),signal:AbortSignal.timeout(90000)});
  if(!response.ok) throw new Error(`AI provider request returned HTTP ${response.status}.`);
  const payload=await response.json() as {message?:{content?:string};choices?:Array<{message?:{content?:string}}>};
  const answer=config.provider==='ollama'?payload.message?.content:payload.choices?.[0]?.message?.content;
  if(!answer) throw new Error('AI provider returned no answer.');
  return {model:config.model,answer};
}

const commands = [
  new SlashCommandBuilder().setName('help').setDescription('Show SANWAN commands and setup status'),
  new SlashCommandBuilder().setName('ping').setDescription('Check bot and database connection'),
  new SlashCommandBuilder().setName('ci').setDescription('Inspect GitHub Actions workflows')
    .addSubcommand(s => s.setName('status').setDescription('Show latest workflow run for a configured repository')
      .addStringOption(o => o.setName('repository').setDescription('owner/repository from GITHUB_REPOSITORIES').setRequired(true))),
  new SlashCommandBuilder().setName('deploy').setDescription('Inspect and control registered deployments')
    .addSubcommand(s=>s.setName('simulate').setDescription('Validate deployment configuration without changing a service')
      .addStringOption(o=>o.setName('service').setDescription('Locally registered service').setRequired(true))
      .addStringOption(o=>o.setName('environment').setDescription('Deployment environment').setRequired(true).addChoices({name:'staging',value:'staging'},{name:'production',value:'production'}))
      .addStringOption(o=>o.setName('commit').setDescription('Optional full commit SHA').setMaxLength(40)))
    .addSubcommand(s=>s.setName('release').setDescription('Deploy staging or request production approval for a successful CI commit')
      .addStringOption(o=>o.setName('service').setDescription('Locally registered service').setRequired(true))
      .addStringOption(o=>o.setName('environment').setDescription('Deployment environment').setRequired(true).addChoices({name:'staging',value:'staging'},{name:'production',value:'production'}))
      .addStringOption(o=>o.setName('commit').setDescription('Full commit SHA with a successful configured workflow').setRequired(true).setMinLength(40).setMaxLength(40)))
    .addSubcommand(s=>s.setName('status').setDescription('Show registered service status')
      .addStringOption(o=>o.setName('service').setDescription('Locally registered service').setRequired(true))
      .addStringOption(o=>o.setName('environment').setDescription('Deployment environment').setRequired(true).addChoices({name:'staging',value:'staging'},{name:'production',value:'production'})))
    .addSubcommand(s=>s.setName('start').setDescription('Start the active pinned release')
      .addStringOption(o=>o.setName('service').setDescription('Locally registered service').setRequired(true))
      .addStringOption(o=>o.setName('environment').setDescription('Deployment environment').setRequired(true).addChoices({name:'staging',value:'staging'},{name:'production',value:'production'})))
    .addSubcommand(s=>s.setName('stop').setDescription('Stop a registered service')
      .addStringOption(o=>o.setName('service').setDescription('Locally registered service').setRequired(true))
      .addStringOption(o=>o.setName('environment').setDescription('Deployment environment').setRequired(true).addChoices({name:'staging',value:'staging'},{name:'production',value:'production'})))
    .addSubcommand(s=>s.setName('restart').setDescription('Restart the active pinned release')
      .addStringOption(o=>o.setName('service').setDescription('Locally registered service').setRequired(true))
      .addStringOption(o=>o.setName('environment').setDescription('Deployment environment').setRequired(true).addChoices({name:'staging',value:'staging'},{name:'production',value:'production'})))
    .addSubcommand(s=>s.setName('rollback').setDescription('Restore the previous healthy release')
      .addStringOption(o=>o.setName('service').setDescription('Locally registered service').setRequired(true))
      .addStringOption(o=>o.setName('environment').setDescription('Deployment environment').setRequired(true).addChoices({name:'staging',value:'staging'},{name:'production',value:'production'}))),
  new SlashCommandBuilder().setName('task').setDescription('Manage tasks')
    .addSubcommand(s => s.setName('create').setDescription('Create a task')
      .addStringOption(o => o.setName('title').setDescription('Short task title').setRequired(true).setMaxLength(120))
      .addStringOption(o => o.setName('assignee').setDescription('Discord user, name, or team').setRequired(true).setMaxLength(100))
      .addStringOption(o => o.setName('deadline').setDescription('ISO date or timestamp with timezone').setRequired(true).setMaxLength(40))
      .addStringOption(o => o.setName('description').setDescription('Task details').setMaxLength(1000)))
    .addSubcommand(s => s.setName('list').setDescription('List tasks; defaults to all tasks')
      .addStringOption(o=>o.setName('scope').setDescription('Task list scope (default: all)').addChoices({name:'all',value:'all'},{name:'open',value:'open'})))
    .addSubcommand(s => s.setName('update').setDescription('Update task fields')
      .addStringOption(o => o.setName('id').setDescription('Task ID such as t0').setRequired(true))
      .addStringOption(o => o.setName('status').setDescription('New status').addChoices({name:'open',value:'open'},{name:'in progress',value:'in-progress'},{name:'blocked',value:'blocked'},{name:'done',value:'done'}))
      .addStringOption(o => o.setName('assignee').setDescription('New assignee').setMaxLength(100))
      .addStringOption(o => o.setName('deadline').setDescription('New ISO date or timestamp').setMaxLength(40)))
    .addSubcommand(s => s.setName('describe').setDescription('Set task description')
      .addStringOption(o => o.setName('id').setDescription('Task ID such as t0').setRequired(true))
      .addStringOption(o => o.setName('description').setDescription('Task details').setRequired(true).setMaxLength(1000)))
    .addSubcommand(s => s.setName('remove').setDescription('Remove a task')
      .addStringOption(o => o.setName('id').setDescription('Task ID such as t0').setRequired(true)))
    .addSubcommand(s => s.setName('bump').setDescription('Send a task reminder')
      .addStringOption(o => o.setName('id').setDescription('Task ID such as t0').setRequired(true))),
  new SlashCommandBuilder().setName('note').setDescription('Manage notes and your personal inbox')
    .addSubcommand(s => s.setName('add').setDescription('Create a titled note')
      .addStringOption(o => o.setName('title').setDescription('Title').setRequired(true).setMaxLength(120))
      .addStringOption(o => o.setName('description').setDescription('Note text').setRequired(true).setMaxLength(3000)))
    .addSubcommand(s => s.setName('list').setDescription('List notes'))
    .addSubcommand(s => s.setName('search').setDescription('Search note title and text')
      .addStringOption(o => o.setName('query').setDescription('Keyword or note ID such as n0').setRequired(true).setMaxLength(100)))
    .addSubcommand(s => s.setName('remove').setDescription('Remove a note')
      .addStringOption(o => o.setName('id').setDescription('Note ID such as n0').setRequired(true)))
    .addSubcommand(s => s.setName('push').setDescription('Add item(s) to your inbox')
      .addStringOption(o => o.setName('text').setDescription('Text; separate multiple lines with newlines').setRequired(true).setMaxLength(2000)))
    .addSubcommand(s => s.setName('pop').setDescription('Remove and show the oldest item in your inbox'))
    .addSubcommand(s => s.setName('export').setDescription('Export a note as a text file')
      .addStringOption(o => o.setName('id').setDescription('Note ID such as n0').setRequired(true)))
    .addSubcommand(s => s.setName('exportall').setDescription('Export all notes as a text file')),
  new SlashCommandBuilder().setName('schedule').setDescription('Schedule registered SANWAN actions')
    .addSubcommand(s => s.setName('set').setDescription('Create or replace a repeating schedule')
      .addStringOption(o=>o.setName('name').setDescription('Schedule name or ID such as s0').setRequired(true).setMaxLength(80))
      .addIntegerOption(o=>o.setName('every_seconds').setDescription('Repeat interval from 60 to 2592000 seconds').setRequired(true).setMinValue(60).setMaxValue(2592000))
      .addStringOption(o=>o.setName('action').setDescription('Registered action').setRequired(true).addChoices({name:'Poll configured GitHub repositories',value:'github.poll'},{name:'Send task deadline reminders',value:'task.reminders'})))
    .addSubcommand(s=>s.setName('ontrigger').setDescription('Run a registered notification action when GitHub polling sees a workflow result')
      .addStringOption(o=>o.setName('name').setDescription('Schedule name or ID such as s0').setRequired(true).setMaxLength(80))
      .addStringOption(o=>o.setName('trigger').setDescription('GitHub event detected by polling').setRequired(true).addChoices({name:'Workflow completed successfully',value:'github.run.completed'},{name:'Workflow completed without success',value:'github.run.unsuccessful'}))
      .addStringOption(o=>o.setName('action').setDescription('Where to send the notification').setRequired(true).addChoices({name:'GitHub update channel',value:'notify.github'},{name:'Error channel',value:'notify.error'})))
    .addSubcommand(s=>s.setName('unset').setDescription('Remove a schedule')
      .addStringOption(o=>o.setName('name').setDescription('Schedule name or ID such as s0').setRequired(true)))
    .addSubcommand(s=>s.setName('list').setDescription('List schedules'))
    .addSubcommand(s=>s.setName('history').setDescription('Show recent schedule runs')),
  new SlashCommandBuilder().setName('logs').setDescription('Read bounded, redacted SANWAN logs')
    .addSubcommand(s=>s.setName('list').setDescription('List available log sources'))
    .addSubcommand(s=>s.setName('show').setDescription('Show recent log lines')
      .addStringOption(o=>o.setName('name').setDescription('Log source from /logs list').setMaxLength(40))
      .addIntegerOption(o=>o.setName('lines').setDescription('Number of lines, 1–100').setMinValue(1).setMaxValue(100))),
  new SlashCommandBuilder().setName('errors').setDescription('Read recent SANWAN errors')
    .addStringOption(o=>o.setName('name').setDescription('Log source name, such as sanwan').setMaxLength(40))
    .addIntegerOption(o=>o.setName('lines').setDescription('Number of error lines, 1–100').setMinValue(1).setMaxValue(100)),
  new SlashCommandBuilder().setName('status').setDescription('Inspect SANWAN container health')
    .addSubcommand(s=>s.setName('disks').setDescription('Show SANWAN data-volume capacity'))
    .addSubcommand(s=>s.setName('resources').setDescription('Show process and container resource information'))
    .addSubcommand(s=>s.setName('network').setDescription('Check Discord and GitHub connectivity')),
  new SlashCommandBuilder().setName('ask').setDescription('Ask the configured optional AI provider')
    .addSubcommand(s=>s.setName('question').setDescription('Ask a question; no commands or logs are sent automatically')
      .addStringOption(o=>o.setName('text').setDescription('Question to send to the configured provider').setRequired(true).setMaxLength(1500)))
    .addSubcommand(s=>s.setName('models').setDescription('List models from the configured provider'))
    .addSubcommand(s=>s.setName('config').setDescription('Show configured provider and model'))
    .addSubcommand(s=>s.setName('switch').setDescription('Change the active model (authorized users only)')
      .addStringOption(o=>o.setName('model').setDescription('Model identifier').setRequired(true).setMaxLength(120)))
].map(c => c.toJSON());

const token = process.env.DISCORD_TOKEN;
if (!token) {
  log('INFO', 'No DISCORD_TOKEN configured. Setup/diagnostic mode: encryption and storage initialized; Discord login skipped.');
  console.log('SANWAN setup mode ready. Configure DISCORD_TOKEN in .env to connect Discord.');
  db.close(); process.exit(0);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
let githubPollRunning = false;
let githubErrorActive = false;
type GitHubTriggerEvent={trigger:GitHubTriggerName;message:string};
async function postChannel(channelId: string | undefined, content: string) {
  if (!channelId) return;
  try {
    const channel = await client.channels.fetch(channelId);
    if (channel && channel.isTextBased() && 'send' in channel) await channel.send({content:content.slice(0,1900),allowedMentions:{parse:[]}});
  } catch (error) { log('ERROR',`Channel notification failed: ${error instanceof Error?error.message:'unknown error'}`); }
}
async function reportSchedulerError(context:string,error:unknown){
  const detail=error instanceof Error?error.message:'unknown error';
  log('ERROR',`${context} failed: ${detail}`);
  await postChannel(process.env.ERROR_CHANNEL_ID,`SANWAN ${context.toLowerCase()} failed. See local redacted logs.`);
}
async function pollGithub() {
  if (githubPollRunning || !process.env.GITHUB_TOKEN) return;
  const repos=(process.env.GITHUB_REPOSITORIES??'').split(',').map(s=>s.trim()).filter(Boolean);
  if(!repos.length) return;
  githubPollRunning=true;
  const baseline=db.prepare("SELECT value FROM setting WHERE key='github_baseline' ").get() as {value:string}|undefined;
  let succeeded=0;
  const triggerEvents:GitHubTriggerEvent[]=[];
  try {
    for(const repo of repos){
      if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) { log('ERROR',`Invalid configured GitHub repository: ${repo}`); continue; }
      const response=await fetch(`https://api.github.com/repos/${repo}/actions/runs?per_page=10`,{
        headers:{Authorization:`Bearer ${process.env.GITHUB_TOKEN}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'},
        signal:AbortSignal.timeout(10000)
      });
      if(!response.ok) throw new Error(`GitHub Actions request failed for ${repo} (HTTP ${response.status}).`);
      const payload=await response.json() as {workflow_runs?:Array<{id:number;name:string;status:string;conclusion:string|null;head_branch:string;head_sha:string;html_url:string;updated_at:string;event:string;head_repository?:{full_name:string}|null}>};
      for(const run of payload.workflow_runs??[]){
        const previous=db.prepare('SELECT status,conclusion FROM github_run WHERE repository=? AND run_id=?').get(repo,run.id) as {status:string;conclusion:string|null}|undefined;
        db.prepare(`INSERT INTO github_run(repository,run_id,workflow,status,conclusion,branch,sha,url,updated_at) VALUES(?,?,?,?,?,?,?,?,?)
          ON CONFLICT(repository,run_id) DO UPDATE SET workflow=excluded.workflow,status=excluded.status,conclusion=excluded.conclusion,branch=excluded.branch,sha=excluded.sha,url=excluded.url,updated_at=excluded.updated_at`)
          .run(repo,run.id,run.name,run.status,run.conclusion,run.head_branch,run.head_sha,run.html_url,run.updated_at);
        const change=classifyGitHubRunChange(baseline?.value==='ready',previous,run);
        if(change){
          const routes=change.trigger?db.prepare('SELECT action FROM schedule WHERE trigger=?').all(change.trigger) as Array<{action:string}>:[];
          const hasTriggerRoute=hasConfiguredNotificationRoute(change.trigger,routes.map(route=>route.action),Boolean(process.env.GITHUB_CHANNEL_ID),Boolean(process.env.ERROR_CHANNEL_ID));
          if(change.trigger&&hasTriggerRoute)triggerEvents.push({trigger:change.trigger,message:change.message});
          else await postChannel(process.env.GITHUB_CHANNEL_ID,change.message);
        }
        if(baseline?.value==='ready'&&run.event==='push'&&run.head_repository?.full_name.toLowerCase()===repo.toLowerCase()&&run.status==='completed'&&run.conclusion==='success'){
          const registry=readServiceRegistry();
          for(const [serviceName,service] of Object.entries(registry.services)){
            if(service.github_repository===repo&&service.workflow_name===run.name&&service.production_branch===run.head_branch){
              db.prepare("UPDATE pending_deployment SET status='superseded' WHERE service=? AND environment='production' AND operation='release' AND status='pending' AND sha<>?").run(serviceName,run.head_sha);
            }
            if(service.github_repository!==repo||service.workflow_name!==run.name||service.staging_branch!==run.head_branch) continue;
            const prior=db.prepare('SELECT status,attempts FROM staging_deployment WHERE service=? AND sha=?').get(serviceName,run.head_sha) as {status:string;attempts:number}|undefined;
            if(prior?.status==='healthy'||(prior&&prior.attempts>=3)) continue;
            if(prior?.status==='deploying'){
              try{
                const current=await workerCall({operation:'status',service:serviceName,environment:'staging'});
                if(current.active_sha===run.head_sha){db.prepare("UPDATE staging_deployment SET status='healthy',detail='recovered from worker state',updated_at=? WHERE service=? AND sha=?").run(new Date().toISOString(),serviceName,run.head_sha);continue;}
              }catch{}
            }
            if(prior) db.prepare("UPDATE staging_deployment SET status='deploying',attempts=attempts+1,updated_at=? WHERE service=? AND sha=?").run(new Date().toISOString(),serviceName,run.head_sha);
            else db.prepare("INSERT INTO staging_deployment(service,sha,status,detail,attempts) VALUES(?,?,'deploying','automatic successful CI deployment',1)").run(serviceName,run.head_sha);
            try{
              const result=await workerCall({operation:'deploy',service:serviceName,environment:'staging',sha:run.head_sha});
              db.prepare("UPDATE staging_deployment SET status='healthy',detail=?,updated_at=? WHERE service=? AND sha=?").run(String(result.digest??'healthy'),new Date().toISOString(),serviceName,run.head_sha);
              await postChannel(process.env.GITHUB_CHANNEL_ID,`Staging deployed · **${serviceName}** · ${run.head_sha.slice(0,7)} · healthy.`);
            }catch(error){
              const detail=error instanceof Error?error.message:'deployment failed';
              db.prepare("UPDATE staging_deployment SET status='failed',detail=?,updated_at=? WHERE service=? AND sha=?").run(detail.slice(0,500),new Date().toISOString(),serviceName,run.head_sha);
              log('ERROR',`Automatic staging deployment ${serviceName} failed: ${detail}`);
              await postChannel(process.env.ERROR_CHANNEL_ID,`Automatic staging deployment failed for ${serviceName} (${run.head_sha.slice(0,7)}). Check SANWAN logs.`);
            }
          }
        }
      }
      succeeded++;
    }
    if(succeeded===repos.length){
      db.prepare("INSERT INTO setting(key,value) VALUES('github_baseline','ready') ON CONFLICT(key) DO UPDATE SET value='ready'").run();
      githubErrorActive=false;
    }
  }catch(error){
    const message=error instanceof Error?error.message:'GitHub polling failed.';
    log('ERROR',message);
    if(!githubErrorActive) await postChannel(process.env.ERROR_CHANNEL_ID,`SANWAN GitHub polling error: ${message}`);
    githubErrorActive=true;
  }finally{githubPollRunning=false;}
  for(const event of triggerEvents)await runTriggeredSchedules(event);
}
async function sendTaskReminders() {
  if(!process.env.TASK_CHANNEL_ID) return;
  const rows=db.prepare("SELECT id,title,assignee,deadline,status FROM task WHERE status!='done'").all() as Array<{id:number;title:string;assignee:string;deadline:string;status:string}>;
  const now=Date.now();
  for(const task of rows){
    const due=Date.parse(task.deadline);
    if(!Number.isFinite(due)) continue;
    const remaining=due-now;
    const kind=remaining<0?'overdue':remaining<=60*60*1000?'1h':remaining<=24*60*60*1000?'24h':undefined;
    if(!kind) continue;
    const result=db.prepare('INSERT OR IGNORE INTO task_reminder(task_id,deadline,kind) VALUES(?,?,?)').run(task.id,task.deadline,kind);
    if(result.changes) await postChannel(process.env.TASK_CHANNEL_ID,`Task reminder · **t${task.id-1}** ${task.title} · ${task.assignee} · due ${task.deadline} · ${kind==='overdue'?'overdue':`within ${kind}`}.`);
  }
}
async function runScheduledAction(action: string, eventMessage?:string) {
  if(action==='github.poll') await pollGithub();
  else if(action==='task.reminders') await sendTaskReminders();
  else if(action==='notify.github') await postChannel(process.env.GITHUB_CHANNEL_ID,eventMessage??'Scheduled GitHub notification.');
  else if(action==='notify.error') await postChannel(process.env.ERROR_CHANNEL_ID,eventMessage??'Scheduled GitHub notification.');
  else throw new Error(`Unsupported registered action: ${action}`);
}
async function runTriggeredSchedules(event:GitHubTriggerEvent){
  const matching=db.prepare('SELECT id,name,action FROM schedule WHERE trigger=? ORDER BY id').all(event.trigger) as Array<{id:number;name:string;action:string}>;
  for(const item of matching){
    try{
      await runScheduledAction(item.action,event.message);
      db.prepare('INSERT INTO schedule_history(schedule_id,name,action,status,detail) VALUES(?,?,?,?,?)').run(item.id,item.name,item.action,'ok',`trigger ${event.trigger}`);
    }catch(error){
      const detail=error instanceof Error?error.message:'unknown error';
      db.prepare('INSERT INTO schedule_history(schedule_id,name,action,status,detail) VALUES(?,?,?,?,?)').run(item.id,item.name,item.action,'error',detail.slice(0,500));
      log('ERROR',`Triggered schedule ${item.name} failed: ${detail}`);
      await postChannel(process.env.ERROR_CHANNEL_ID,`SANWAN GitHub-triggered schedule **${item.name}** failed. See local redacted logs.`);
    }
  }
}
let schedulePassRunning=false;
async function runDueSchedules() {
  if(schedulePassRunning) return;
  schedulePassRunning=true;
  try {
    const due=db.prepare("SELECT id,name,interval_seconds,action FROM schedule WHERE trigger='interval' AND next_run<=? ORDER BY next_run LIMIT 10").all(new Date().toISOString()) as Array<{id:number;name:string;interval_seconds:number;action:string}>;
    for(const item of due){
      const nextRun=new Date(Date.now()+item.interval_seconds*1000).toISOString();
      db.prepare('UPDATE schedule SET next_run=? WHERE id=?').run(nextRun,item.id);
      try{
        await runScheduledAction(item.action);
        db.prepare('INSERT INTO schedule_history(schedule_id,name,action,status,detail) VALUES(?,?,? ,?,?)').run(item.id,item.name,item.action,'ok','completed');
      }catch(error){
        const detail=error instanceof Error?error.message:'unknown error';
        db.prepare('INSERT INTO schedule_history(schedule_id,name,action,status,detail) VALUES(?,?,?,?,?)').run(item.id,item.name,item.action,'error',detail.slice(0,500));
        log('ERROR',`Schedule ${item.name} failed: ${detail}`);
        await postChannel(process.env.ERROR_CHANNEL_ID,`SANWAN scheduled action **${item.name}** failed. See local redacted logs.`);
      }
    }
    await sendTaskReminders();
  }finally{schedulePassRunning=false;}
}
async function safelyRunDueSchedules(){
  try{await runDueSchedules();}
  catch(error){await reportSchedulerError('scheduler',error);}
}
function authorized(interaction: {inGuild:()=>boolean;guildId:string|null;user:{id:string};guild:{ownerId:string}|null;member:unknown}): boolean {
  if (!interaction.inGuild() || interaction.guildId !== process.env.DISCORD_GUILD_ID) return false;
  if (interaction.guild?.ownerId === interaction.user.id) return true;
  const allowedRoles = (process.env.AUTHORIZED_ROLE_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if(!interaction.member||typeof interaction.member!=='object'||!('roles' in interaction.member)) return false;
  const roles=(interaction.member as {roles:unknown}).roles;
  const roleIds=Array.isArray(roles)?roles:roles&&typeof roles==='object'&&'cache' in roles?[...((roles as {cache:Map<string,unknown>}).cache.keys())]:[];
  return roleIds.some(id=>allowedRoles.includes(String(id)));
}
client.once('ready', async () => {
  try {
    log('INFO', `Connected to Discord as ${client.user?.tag}`);
    const appId = process.env.DISCORD_APPLICATION_ID ?? client.application?.id;
    if (!appId) throw new Error('Could not determine Discord application ID.');
    const guildId=process.env.DISCORD_GUILD_ID;
    if(!guildId) throw new Error('DISCORD_GUILD_ID must be set to register guild commands.');
    const rest = new REST({ version: '10' }).setToken(token);
    await writeHeartbeatAfterReady(()=>rest.put(guildCommandRoute(appId,guildId), { body: commands }));
    log('INFO', `Slash commands registered for guild ${guildId}.`);
    setInterval(()=>{if(client.isReady())writeHeartbeat();else clearHeartbeat();},15_000).unref();
    await pollGithub();
    setInterval(() => { void pollGithub(); }, 60_000).unref();
    void safelyRunDueSchedules();
    setInterval(() => { void safelyRunDueSchedules(); }, 15_000).unref();
  } catch(error) {
    const detail=error instanceof Error?error.message:'unknown error';
    log('ERROR',`Discord startup initialization failed: ${detail}`);
    clearHeartbeat();
    await postChannel(process.env.ERROR_CHANNEL_ID,'SANWAN startup initialization failed. See local redacted logs.');
    await client.destroy().catch(()=>undefined);
    db.close();
    process.exitCode=1;
  }
});

client.on('interactionCreate', async interaction => {
  if(interaction.isButton()&&interaction.customId.startsWith('deploy-approve:')){
    const match=/^deploy-approve:(\d+)$/.exec(interaction.customId);
    if(!match)return;
    if(!authorized(interaction)){await interaction.reply({content:'You are not authorized to approve production deployments.',ephemeral:true});return;}
    const id=Number(match[1]);
    const pending=db.prepare('SELECT id,service,environment,sha,requester,status,expires_at,operation,image_digest FROM pending_deployment WHERE id=?').get(id) as {id:number;service:string;environment:EnvironmentName;sha:string;requester:string;status:string;expires_at:string;operation:string;image_digest:string|null}|undefined;
    if(!pending||pending.status!=='pending'){await interaction.reply({content:'This deployment approval is no longer pending.',ephemeral:true});return;}
    if(pending.requester===interaction.user.id){await interaction.reply({content:'A different authorized user must approve this release.',ephemeral:true});return;}
    if(Date.parse(pending.expires_at)<=Date.now()){
      db.prepare("UPDATE pending_deployment SET status='expired' WHERE id=? AND status='pending'").run(id);
      await interaction.reply({content:'This approval has expired.',ephemeral:true});return;
    }
    const claimed=db.prepare("UPDATE pending_deployment SET status='deploying' WHERE id=? AND status='pending' AND expires_at>?").run(id,new Date().toISOString());
    if(!claimed.changes){await interaction.reply({content:'This approval was already handled.',ephemeral:true});return;}
    await interaction.deferUpdate();
    try{
      const service=registeredService(pending.service);
      let result:{[key:string]:unknown};
      if(pending.operation==='rollback'){
        const current=await workerCall({operation:'status',service:pending.service,environment:'production'});
        if(current.previous_digest!==pending.sha) throw new Error('The previous production release changed after this approval was requested.');
        result=await workerCall({operation:'rollback',service:pending.service,environment:'production',expected_digest:pending.sha});
      }else{
        await verifyRelease(service,'production',pending.sha);
        if(!pending.image_digest) throw new Error('This request has no pinned production digest; submit a new request.');
        result=await workerCall({operation:'deploy',service:pending.service,environment:'production',sha:pending.sha,digest:pending.image_digest});
      }
      db.prepare("UPDATE pending_deployment SET status='approved' WHERE id=?").run(id);
      const releaseLabel=pending.operation==='rollback'?pending.sha.slice(0,19):pending.sha.slice(0,7);
      await interaction.message.edit({content:`Production ${pending.operation==='rollback'?'rollback':'release'} approved by <@${interaction.user.id}> and completed. **${pending.service}** · ${releaseLabel} · ${String(result.digest??'digest unavailable')}`,components:[]});
      await interaction.followUp({content:`Production ${pending.operation} is healthy.`,ephemeral:true});
    }catch(error){
      const message=error instanceof Error?error.message:'Deployment failed.';
      db.prepare("UPDATE pending_deployment SET status='failed' WHERE id=?").run(id);
      log('ERROR',`Production approval ${id} failed: ${message}`);
      await interaction.message.edit({content:`Production ${pending.operation} failed for **${pending.service}** · ${pending.operation==='rollback'?pending.sha.slice(0,19):pending.sha.slice(0,7)}. See SANWAN logs.`,components:[]}).catch(()=>undefined);
      await interaction.followUp({content:'The release was not completed. Check the SANWAN error log.',ephemeral:true});
    }
    return;
  }
  if (!interaction.isChatInputCommand()) return;
  try {
    if (!interaction.inGuild() || interaction.guildId !== process.env.DISCORD_GUILD_ID) {
      await interaction.reply({ content: 'This SANWAN installation is restricted to its configured Discord server.', ephemeral: true }); return;
    }
    if (interaction.commandName === 'ping') {
      db.prepare("INSERT INTO event(source,message) VALUES('discord','ping')").run();
      await interaction.reply({ content: `Pong. Database ready; gateway latency ${client.ws.ping} ms.`, ephemeral: true });
    } else if (interaction.commandName === 'help') {
      await interaction.reply({ content: '**SANWAN** · `/ping` · `/ci status` · `/deploy simulate|release|status|start|stop|restart|rollback` · `/task` · `/note` · `/schedule`\nDeployment services must be registered by the host owner. Production changes require approval from a second authorized user.', ephemeral: true });
    } else if (interaction.commandName === 'ci') {
      if (!authorized(interaction)) { await interaction.reply({ content: 'You are not authorized to inspect CI for this server.', ephemeral: true }); return; }
      await interaction.deferReply({ ephemeral: true });
      const repo = interaction.options.getString('repository', true);
      const allowed = (process.env.GITHUB_REPOSITORIES ?? '').split(',').map(s => s.trim()).filter(Boolean);
      if (!allowed.includes(repo)) { await interaction.editReply('Repository is not in the local GITHUB_REPOSITORIES allowlist.'); return; }
      if (!process.env.GITHUB_TOKEN) { await interaction.editReply('GitHub polling is configured only after GITHUB_TOKEN is added to .env.'); return; }
      const response = await fetch(`https://api.github.com/repos/${repo}/actions/runs?per_page=5`, { headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } });
      if (!response.ok) throw new Error(`GitHub API returned HTTP ${response.status}`);
      const payload = await response.json() as { workflow_runs?: Array<{name:string;status:string;conclusion:string|null;head_branch:string;head_sha:string;html_url:string}> };
      const runs = payload.workflow_runs ?? [];
      if (!runs.length) { await interaction.editReply(`No workflow runs found for ${repo}.`); return; }
      const content = runs.map(r => `• **${r.name}** · ${r.status}${r.conclusion ? ` / ${r.conclusion}` : ''} · ${r.head_branch} @ ${r.head_sha.slice(0,7)} · <${r.html_url}>`).join('\n');
      await interaction.editReply(content.slice(0, 1900));
    } else if (interaction.commandName === 'deploy') {
      if (!authorized(interaction)) { await interaction.reply({ content: 'You are not authorized to inspect or operate deployments.', ephemeral: true }); return; }
      const action=interaction.options.getSubcommand();
      const serviceName=interaction.options.getString('service',true);
      const environment=interaction.options.getString('environment',true) as EnvironmentName;
      const service=registeredService(serviceName);
      if(action==='simulate'){
        const sha=interaction.options.getString('commit')??undefined;
        const result=await workerCall({operation:'simulate',service:serviceName,environment,sha});
        await interaction.reply({content:`Simulation passed for **${serviceName}/${environment}**. No service was changed. ${String(result.planned_image??'Compose security checks passed.')}`,ephemeral:true});
      }else if(action==='release'){
        const sha=interaction.options.getString('commit',true).toLowerCase();
        await interaction.deferReply({ephemeral:true});
        await verifyRelease(service,environment,sha);
        if(environment==='staging'){
          const result=await workerCall({operation:'deploy',service:serviceName,environment,sha});
          db.prepare("INSERT INTO staging_deployment(service,sha,status,detail,attempts) VALUES(?,?,'healthy','manual successful deployment',1) ON CONFLICT(service,sha) DO UPDATE SET status='healthy',detail='manual successful deployment',updated_at=CURRENT_TIMESTAMP").run(serviceName,sha);
          await interaction.editReply(`Staging release is healthy · **${serviceName}** · ${sha.slice(0,7)} · ${String(result.digest??'digest unavailable')}.`);
        }else{
          const prepared=await workerCall({operation:'prepare',service:serviceName,environment,sha});
          const digest=String(prepared.digest??'');
          if(!digest.startsWith(`${service.image_repository}@sha256:`)) throw new Error('Worker returned a digest outside the configured image repository.');
          const channel=process.env.APPROVAL_CHANNEL_ID?await client.channels.fetch(process.env.APPROVAL_CHANNEL_ID):interaction.channel;
          if(!channel||!channel.isTextBased()||!('send' in channel)) throw new Error('The configured approval channel is unavailable.');
          db.prepare("UPDATE pending_deployment SET status='superseded' WHERE service=? AND environment=? AND status='pending'").run(serviceName,environment);
          const expires=new Date(Date.now()+24*60*60*1000).toISOString();
          const insert=db.prepare("INSERT INTO pending_deployment(service,environment,sha,requester,status,expires_at,image_digest) VALUES(?,?,?,?,'pending',?,?)").run(serviceName,environment,sha,interaction.user.id,expires,digest);
          const approvalId=Number(insert.lastInsertRowid);
          const button=new ButtonBuilder().setCustomId(`deploy-approve:${approvalId}`).setLabel('Approve production release').setStyle(ButtonStyle.Danger);
          try{
            await channel.send({content:`Production deployment approval requested by <@${interaction.user.id}>.\nService: **${serviceName}**\nCommit: **${sha}**\nImage digest: **${digest}**\nWorkflow: **${service.workflow_name}** passed on **${service.production_branch}**.\nApproval expires: ${expires}. A different authorized user must approve.`,components:[new ActionRowBuilder<ButtonBuilder>().addComponents(button)],allowedMentions:{parse:[]}});
          }catch(error){db.prepare("UPDATE pending_deployment SET status='failed' WHERE id=?").run(approvalId);throw error;}
          await interaction.editReply('Production approval request posted. The exact commit and image are locked to this request.');
        }
      }else{
        if(action==='rollback'&&environment==='production'){
          await interaction.deferReply({ephemeral:true});
          const current=await workerCall({operation:'status',service:serviceName,environment});
          const previous=String(current.previous_digest??'');
          if(!previous.startsWith(`${service.image_repository}@sha256:`)){await interaction.editReply('No previous healthy production digest is available to approve.');return;}
          db.prepare("UPDATE pending_deployment SET status='superseded' WHERE service=? AND environment='production' AND status='pending'").run(serviceName);
          const expires=new Date(Date.now()+24*60*60*1000).toISOString();
          const insert=db.prepare("INSERT INTO pending_deployment(service,environment,sha,requester,status,expires_at,operation) VALUES(?,'production',?,?,'pending',?,'rollback')").run(serviceName,previous,interaction.user.id,expires);
          const approvalId=Number(insert.lastInsertRowid);
          const channel=process.env.APPROVAL_CHANNEL_ID?await client.channels.fetch(process.env.APPROVAL_CHANNEL_ID):interaction.channel;
          if(!channel||!channel.isTextBased()||!('send' in channel)){db.prepare("UPDATE pending_deployment SET status='failed' WHERE id=?").run(approvalId);throw new Error('The configured approval channel is unavailable.');}
          const button=new ButtonBuilder().setCustomId(`deploy-approve:${approvalId}`).setLabel('Approve production rollback').setStyle(ButtonStyle.Danger);
          try{await channel.send({content:`Production rollback approval requested by <@${interaction.user.id}>.\nService: **${serviceName}**\nRestore digest: **${previous}**\nApproval expires: ${expires}. A different authorized user must approve.`,components:[new ActionRowBuilder<ButtonBuilder>().addComponents(button)],allowedMentions:{parse:[]}});}
          catch(error){db.prepare("UPDATE pending_deployment SET status='failed' WHERE id=?").run(approvalId);throw error;}
          await interaction.editReply('Production rollback approval request posted. It is bound to the previous digest shown in the approval message.');return;
        }
        await interaction.deferReply({ephemeral:true});
        const result=await workerCall({operation:action,service:serviceName,environment});
        await interaction.editReply(JSON.stringify(result).slice(0,1900));
      }
    } else if (interaction.commandName === 'task') {
      const action = interaction.options.getSubcommand();
      const notifyTask = async (message: string) => {
        const channelId = process.env.TASK_CHANNEL_ID;
        await postChannel(channelId,message);
      };
      const getTask = (value: string) => {
        const match = /^t(\d+)$/i.exec(value.trim());
        if (!match) return undefined;
        return db.prepare('SELECT id,title,assignee,deadline,status,description FROM task WHERE id=?').get(Number(match[1])+1) as {id:number;title:string;assignee:string;deadline:string;status:string;description:string}|undefined;
      };
      if (action === 'create') {
        const title=interaction.options.getString('title',true).trim();
        const assignee=interaction.options.getString('assignee',true).trim();
        const deadline=interaction.options.getString('deadline',true).trim();
        if (!isIsoDeadline(deadline)) { await interaction.reply({content:'Deadline must be YYYY-MM-DD or an ISO timestamp with timezone.',ephemeral:true}); return; }
        const description=interaction.options.getString('description') ?? '';
        const result=db.prepare('INSERT INTO task(title,assignee,deadline,description) VALUES(?,?,?,?)').run(title,assignee,deadline,description);
        const taskId=`t${Number(result.lastInsertRowid)-1}`;
        db.prepare('INSERT INTO event(source,message) VALUES(?,?)').run('task',`create ${taskId} by ${interaction.user.id}`);
        await interaction.reply({content:`Created **${taskId}** · ${title} · assigned to ${assignee} · due ${deadline}.`,ephemeral:true});
        await notifyTask(`Task **${taskId}** created: ${title} · ${assignee} · due ${deadline}.`);
      } else if (action === 'list') {
        const scope=interaction.options.getString('scope')??'all';
        const rows=(scope==='open'
          ?db.prepare("SELECT id,title,assignee,deadline,status,description FROM task WHERE status!='done' ORDER BY deadline LIMIT 20").all()
          :db.prepare('SELECT id,title,assignee,deadline,status,description FROM task ORDER BY deadline LIMIT 20').all()) as Array<{id:number;title:string;assignee:string;deadline:string;status:string;description:string}>;
        const content=rows.length?rows.map(t=>`**t${t.id-1}** · ${t.title} · ${t.assignee} · ${t.status} · due ${t.deadline}${t.description?` · ${t.description.slice(0,50)}`:''}`).join('\n'):'No open tasks.';
        await interaction.reply({content:content.slice(0,1900),ephemeral:true});
      } else if (action === 'update' || action === 'describe' || action === 'bump' || action === 'remove') {
        const id=interaction.options.getString('id',true);
        const task=getTask(id);
        if (!task) { await interaction.reply({content:`Task **${id}** was not found.`,ephemeral:true}); return; }
        const label=`t${task.id-1}`;
        if (action === 'remove') {
          if (!authorized(interaction)) { await interaction.reply({content:'Only the server owner or an authorized role can remove tasks.',ephemeral:true}); return; }
          db.prepare('DELETE FROM task WHERE id=?').run(task.id);
          await interaction.reply({content:`Removed **${label}** · ${task.title}.`,ephemeral:true});
          await notifyTask(`Task **${label}** removed: ${task.title}.`);
        } else if (action === 'bump') {
          await interaction.reply({content:`Reminder sent for **${label}** · ${task.title}.`,ephemeral:true});
          await notifyTask(`Reminder · **${label}** ${task.title} · ${task.assignee} · due ${task.deadline} · ${task.status}.`);
        } else if (action === 'describe') {
          const description=interaction.options.getString('description',true);
          db.prepare('UPDATE task SET description=? WHERE id=?').run(description,task.id);
          await interaction.reply({content:`Updated description for **${label}**.`,ephemeral:true});
          await notifyTask(`Task **${label}** updated: description changed.`);
        } else {
          const status=interaction.options.getString('status');
          const assignee=interaction.options.getString('assignee');
          const deadline=interaction.options.getString('deadline');
          if (!status && !assignee && !deadline) { await interaction.reply({content:'Provide at least one field to update.',ephemeral:true}); return; }
          if (deadline && !isIsoDeadline(deadline)) { await interaction.reply({content:'Deadline must be YYYY-MM-DD or an ISO timestamp with timezone.',ephemeral:true}); return; }
          db.prepare('UPDATE task SET status=COALESCE(?,status),assignee=COALESCE(?,assignee),deadline=COALESCE(?,deadline) WHERE id=?').run(status,assignee,deadline,task.id);
          await interaction.reply({content:`Updated **${label}**.`,ephemeral:true});
          await notifyTask(`Task **${label}** updated: ${[status&&`status ${status}`,assignee&&`assignee ${assignee}`,deadline&&`deadline ${deadline}`].filter(Boolean).join(', ')}.`);
        }
        db.prepare('INSERT INTO event(source,message) VALUES(?,?)').run('task',`${action} ${label} by ${interaction.user.id}`);
      }
    } else if (interaction.commandName === 'note') {
      const action=interaction.options.getSubcommand();
      const getNote=(value:string)=>{
        const match=/^n(\d+)$/i.exec(value.trim());
        if(!match) return undefined;
        return db.prepare('SELECT id,title,body FROM note WHERE id=?').get(Number(match[1])+1) as {id:number;title:string;body:string}|undefined;
      };
      if(action==='add'){
        const title=interaction.options.getString('title',true).trim();
        const body=interaction.options.getString('description',true);
        const row=db.prepare('INSERT INTO note(title,body) VALUES(?,?)').run(title,body);
        await interaction.reply({content:`Created note **n${Number(row.lastInsertRowid)-1}** · ${title}.`,ephemeral:true});
      } else if(action==='list'){
        const rows=db.prepare('SELECT id,title,body FROM note ORDER BY id DESC LIMIT 30').all() as Array<{id:number;title:string;body:string}>;
        const text=rows.length?rows.map(n=>`**n${n.id-1}** · ${n.title} · ${n.body.replace(/\s+/g,' ').slice(0,50)}`).join('\n'):'No notes.';
        await interaction.reply({content:text.slice(0,1900),ephemeral:true});
      } else if(action==='search'){
        const query=interaction.options.getString('query',true).trim();
        const byId=getNote(query);
        const rows=byId?[byId]:db.prepare("SELECT id,title,body FROM note WHERE title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT 20").all(`%${query.replace(/[\\%_]/g,'\\$&')}%`,`%${query.replace(/[\\%_]/g,'\\$&')}%`) as Array<{id:number;title:string;body:string}>;
        const text=rows.length?rows.map(n=>`**n${n.id-1}** · ${n.title} · ${n.body.replace(/\s+/g,' ').slice(0,80)}`).join('\n'):'No matching notes.';
        await interaction.reply({content:text.slice(0,1900),ephemeral:true});
      } else if(action==='remove' || action==='export'){
        const id=interaction.options.getString('id',true);
        const note=getNote(id);
        if(!note){await interaction.reply({content:`Note **${id}** was not found.`,ephemeral:true});return;}
        if(action==='remove'){
          db.prepare('DELETE FROM note WHERE id=?').run(note.id);
          await interaction.reply({content:`Removed **n${note.id-1}** · ${note.title}.`,ephemeral:true});
        }else{
          await interaction.reply({files:[new AttachmentBuilder(Buffer.from(`${note.title}\n\n${note.body}\n`),{name:`${note.title.replace(/[^a-z0-9_-]/gi,'_').slice(0,60)||'note'}.txt`})],ephemeral:true});
        }
      } else if(action==='exportall'){
        const notes=db.prepare('SELECT id,title,body FROM note ORDER BY id').all() as Array<{id:number;title:string;body:string}>;
        if(!notes.length){await interaction.reply({content:'No notes to export.',ephemeral:true});return;}
        const content=notes.map(n=>`# n${n.id-1} · ${n.title}\n\n${n.body}`).join('\n\n---\n\n');
        await interaction.reply({files:[new AttachmentBuilder(Buffer.from(content),{name:'sanwan-notes.txt'})],ephemeral:true});
      } else if(action==='push'){
        const items=interaction.options.getString('text',true).split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
        if(!items.length){await interaction.reply({content:'Enter at least one non-empty inbox item.',ephemeral:true});return;}
        const insert=db.prepare('INSERT INTO inbox(user_id,body) VALUES(?,?)');
        const transaction=db.transaction((values:string[])=>values.forEach(v=>insert.run(interaction.user.id,v)));
        transaction(items);
        await interaction.reply({content:`Added ${items.length} item${items.length===1?'':'s'} to your inbox.`,ephemeral:true});
      } else if(action==='pop'){
        const item=db.prepare('SELECT id,body FROM inbox WHERE user_id=? ORDER BY id LIMIT 1').get(interaction.user.id) as {id:number;body:string}|undefined;
        if(!item){await interaction.reply({content:'Your inbox is empty.',ephemeral:true});return;}
        db.prepare('DELETE FROM inbox WHERE id=?').run(item.id);
        await interaction.reply({content:item.body.slice(0,1900),ephemeral:true});
      }
    } else if(interaction.commandName==='schedule'){
      const action=interaction.options.getSubcommand();
      if((action==='set'||action==='ontrigger'||action==='unset')&&!authorized(interaction)){
        await interaction.reply({content:'Only the server owner or an authorized role can change schedules.',ephemeral:true});return;
      }
      const findSchedule=(value:string)=>{
        const match=/^s(\d+)$/i.exec(value.trim());
        return match?db.prepare('SELECT id,name,interval_seconds,action,next_run,trigger FROM schedule WHERE id=?').get(Number(match[1])+1) as {id:number;name:string;interval_seconds:number;action:string;next_run:string;trigger:string}|undefined
          :db.prepare('SELECT id,name,interval_seconds,action,next_run,trigger FROM schedule WHERE name=? COLLATE NOCASE').get(value.trim()) as {id:number;name:string;interval_seconds:number;action:string;next_run:string;trigger:string}|undefined;
      };
      if(action==='ontrigger'){
        const input=interaction.options.getString('name',true).trim();
        const trigger=interaction.options.getString('trigger',true) as GitHubTriggerName;
        const actionName=interaction.options.getString('action',true);
        const byId=/^s(\d+)$/i.exec(input);
        const now=new Date().toISOString();
        if(byId){
          const existing=findSchedule(input);
          if(!existing){await interaction.reply({content:`Schedule **${input}** was not found.`,ephemeral:true});return;}
          db.prepare("UPDATE schedule SET interval_seconds=0,action=?,next_run='',updated_at=?,trigger=? WHERE id=?").run(actionName,now,trigger,existing.id);
          await interaction.reply({content:`Updated **s${existing.id-1} · ${existing.name}** to trigger **${trigger}** → ${actionName}.`,ephemeral:true});
        }else{
          if(!/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(input)){await interaction.reply({content:'Use a schedule name containing letters, numbers, hyphens, or underscores.',ephemeral:true});return;}
          const name=input.toLowerCase();
          db.prepare(`INSERT INTO schedule(name,interval_seconds,action,next_run,updated_at,trigger) VALUES(?,0,?,'',?,?)
            ON CONFLICT(name) DO UPDATE SET interval_seconds=0,action=excluded.action,next_run='',updated_at=excluded.updated_at,trigger=excluded.trigger`)
            .run(name,actionName,now,trigger);
          const saved=findSchedule(name)!;
          await interaction.reply({content:`Saved **s${saved.id-1} · ${saved.name}** · on **${trigger}** → ${actionName}.`,ephemeral:true});
        }
      }else if(action==='set'){
        const input=interaction.options.getString('name',true).trim();
        const actionName=interaction.options.getString('action',true);
        const seconds=interaction.options.getInteger('every_seconds',true);
        const byId=/^s(\d+)$/i.exec(input);
        if(byId){
          const existing=findSchedule(input);
          if(!existing){await interaction.reply({content:`Schedule **${input}** was not found.`,ephemeral:true});return;}
          db.prepare("UPDATE schedule SET interval_seconds=?,action=?,next_run=?,updated_at=?,trigger='interval' WHERE id=?").run(seconds,actionName,new Date(Date.now()+seconds*1000).toISOString(),new Date().toISOString(),existing.id);
          await interaction.reply({content:`Updated **s${existing.id-1} · ${existing.name}** to every ${seconds}s → ${actionName}.`,ephemeral:true});
        }else{
          if(!/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(input)){await interaction.reply({content:'Use a schedule name containing letters, numbers, hyphens, or underscores.',ephemeral:true});return;}
          const name=input.toLowerCase();
          db.prepare(`INSERT INTO schedule(name,interval_seconds,action,next_run,updated_at,trigger) VALUES(?,?,?,?,?,'interval')
            ON CONFLICT(name) DO UPDATE SET interval_seconds=excluded.interval_seconds,action=excluded.action,next_run=excluded.next_run,updated_at=excluded.updated_at,trigger='interval'`)
            .run(name,seconds,actionName,new Date(Date.now()+seconds*1000).toISOString(),new Date().toISOString());
          const saved=findSchedule(name)!;
          await interaction.reply({content:`Saved **s${saved.id-1} · ${saved.name}** · every ${seconds}s → ${actionName}.`,ephemeral:true});
        }
      }else if(action==='unset'){
        const value=interaction.options.getString('name',true);
        const schedule=findSchedule(value);
        if(!schedule){await interaction.reply({content:`Schedule **${value}** was not found.`,ephemeral:true});return;}
        db.prepare('DELETE FROM schedule WHERE id=?').run(schedule.id);
        await interaction.reply({content:`Removed **s${schedule.id-1} · ${schedule.name}**.`,ephemeral:true});
      }else if(action==='list'){
        const rows=db.prepare('SELECT id,name,interval_seconds,action,next_run,trigger FROM schedule ORDER BY id').all() as Array<{id:number;name:string;interval_seconds:number;action:string;next_run:string;trigger:string}>;
        const text=rows.length?rows.map(s=>s.trigger==='interval'?`**s${s.id-1} · ${s.name}** · every ${s.interval_seconds}s → ${s.action} · next ${s.next_run}`:`**s${s.id-1} · ${s.name}** · on ${s.trigger} → ${s.action}`).join('\n'):'No schedules.';
        await interaction.reply({content:text.slice(0,1900),ephemeral:true});
      }else if(action==='history'){
        const rows=db.prepare('SELECT name,action,status,detail,created_at FROM schedule_history ORDER BY id DESC LIMIT 15').all() as Array<{name:string;action:string;status:string;detail:string;created_at:string}>;
        const text=rows.length?rows.map(r=>`**${r.name}** · ${r.action} · ${r.status} · ${r.created_at} · ${r.detail}`).join('\n'):'No schedule history.';
        await interaction.reply({content:text.slice(0,1900),ephemeral:true});
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    log('ERROR', `${interaction.commandName} failed: ${message}`);
    const response = 'SANWAN encountered an error. Check the local log for details.';
    if (interaction.deferred || interaction.replied) await interaction.editReply(response).catch(() => undefined);
    else await interaction.reply({ content: response, ephemeral: true }).catch(() => undefined);
    const channelId = process.env.ERROR_CHANNEL_ID;
    if (channelId) {
      try {
        const channel = await client.channels.fetch(channelId);
        if (channel && channel.isTextBased() && 'send' in channel) await channel.send('SANWAN command failed. See local redacted logs.');
      } catch { /* Notification delivery failures are recorded by the original error log. */ }
    }
  }
});

client.on('interactionCreate', async interaction=>{
  if(!interaction.isChatInputCommand()||!['logs','errors','status','ask'].includes(interaction.commandName)) return;
  if(interaction.replied||interaction.deferred) return;
  try{
    if(!interaction.inGuild()||interaction.guildId!==process.env.DISCORD_GUILD_ID){await interaction.reply({content:'This SANWAN installation is restricted to its configured Discord server.',ephemeral:true});return;}
    if(interaction.commandName==='logs'||interaction.commandName==='errors'){
      if(!authorized(interaction)){await interaction.reply({content:'Only the server owner or an authorized role can view operational logs.',ephemeral:true});return;}
      const isError=interaction.commandName==='errors';
      if(!isError&&interaction.options.getSubcommand()==='list'){
        const sources=readdirSync(logDir,{withFileTypes:true}).filter(entry=>entry.isFile()&&/^[a-z0-9][a-z0-9_-]{0,39}\.log$/i.test(entry.name)).map(entry=>entry.name.slice(0,-4));
        await interaction.reply({content:`Available sources: ${sources.length?sources.map(name=>`**${name}**`).join(', '):'none yet'}. Worker output is available through \`docker compose logs worker\`.`,ephemeral:true});return;
      }
      const source=interaction.options.getString('name')?.trim()||'sanwan';
      if(!/^[a-z0-9][a-z0-9_-]{0,39}$/i.test(source)){await interaction.reply({content:'Log source names may contain only letters, numbers, underscores, and hyphens.',ephemeral:true});return;}
      const count=interaction.options.getInteger('lines')??20;
      const file=join(logDir,`${source}.log`);
      if(!existsSync(file)){await interaction.reply({content:`No log file exists for source **${source}**. Use /logs list to see available sources.`,ephemeral:true});return;}
      let lines=readFileSync(file,'utf8').split(/\r?\n/).filter(Boolean);
      if(isError) lines=lines.filter(line=>/\bERROR\b/.test(line));
      const text=lines.slice(-count).join('\n');
      const block=text?['```text',text.slice(-1700),'```'].join('\n'):'No matching log lines.';
      await interaction.reply({content:`**${source} ${isError?'errors':'logs'} · last ${count} lines**\n${block}`,ephemeral:true,allowedMentions:{parse:[]}});
    }else if(interaction.commandName==='status'){
      const action=interaction.options.getSubcommand();
      if(action==='disks'){
        const fsInfo=statfsSync(dataDir);
        const total=Number(fsInfo.blocks)*Number(fsInfo.bsize);const free=Number(fsInfo.bavail)*Number(fsInfo.bsize);
        await interaction.reply({content:`SANWAN data volume · ${(free/1024**3).toFixed(2)} GiB free of ${(total/1024**3).toFixed(2)} GiB.`,ephemeral:true});
      }else if(action==='resources'){
        const memory=process.memoryUsage();
        const limits=readContainerLimits();
        const availableMemory=limits.memoryLimitBytes&&limits.memoryUsageBytes
          ?`Container memory ${(limits.memoryUsageBytes/1024**2).toFixed(1)} MiB used of ${(limits.memoryLimitBytes/1024**2).toFixed(1)} MiB`
          :`Host memory ${(os.freemem()/1024**3).toFixed(2)} GiB free of ${(os.totalmem()/1024**3).toFixed(2)} GiB`;
        const cpu=limits.cpuQuotaCores?`Container CPU quota ${limits.cpuQuotaCores.toFixed(2)} cores`:`${os.cpus().length} logical CPUs`;
        await interaction.reply({content:`SANWAN process · Node ${process.version} · ${process.platform}/${process.arch}\nProcess RSS ${(memory.rss/1024**2).toFixed(1)} MiB · heap ${(memory.heapUsed/1024**2).toFixed(1)} MiB\n${availableMemory} · ${cpu} · load ${os.loadavg().map(v=>v.toFixed(2)).join('/')}`,ephemeral:true});
      }else{
        let github='not configured';
        if(process.env.GITHUB_TOKEN){try{const response=await fetch('https://api.github.com',{headers:{Authorization:`Bearer ${process.env.GITHUB_TOKEN}`,Accept:'application/vnd.github+json'},signal:AbortSignal.timeout(5000)});github=`reachable (HTTP ${response.status})`;}catch{github='unreachable';}}
        await interaction.reply({content:`Discord Gateway · ${client.isReady()?'connected':'disconnected'} (${client.ws.ping} ms)\nGitHub API · ${github}`,ephemeral:true});
      }
    }else if(interaction.commandName==='ask'){
      const action=interaction.options.getSubcommand();
      if(action==='config'){
        const config=askConfig();const endpoint=new URL(config.base);
        await interaction.reply({content:`Provider: **${config.provider}**\nModel: **${config.model}**\nEndpoint: **${endpoint.origin}${endpoint.pathname}**`,ephemeral:true});
      }else if(action==='models'){
        await interaction.deferReply({ephemeral:true});
        const models=await askModels();
        await interaction.editReply(models.length?`Models · ${models.slice(0,25).join(', ')}`:'Provider returned no models.');
      }else if(action==='switch'){
        if(!authorized(interaction)){await interaction.reply({content:'Only the server owner or an authorized role can switch the AI model.',ephemeral:true});return;}
        const model=interaction.options.getString('model',true).trim();
        const models=await askModels();
        if(!models.includes(model)){await interaction.reply({content:'That model is not available from the configured provider.',ephemeral:true});return;}
        db.prepare("INSERT INTO setting(key,value) VALUES('ask_model',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(model);
        await interaction.reply({content:`Active AI model set to **${model}**.`,ephemeral:true});
      }else{
        const userId=interaction.user.id;const now=Date.now();
        if(now-(askLastRequest.get(userId)??0)<10_000){await interaction.reply({content:'Please wait 10 seconds between AI requests.',ephemeral:true});return;}
        if(askRequestsInFlight>=2){await interaction.reply({content:'SANWAN is handling its maximum number of AI requests. Try again shortly.',ephemeral:true});return;}
        askLastRequest.set(userId,now);askRequestsInFlight++;
        await interaction.deferReply({ephemeral:true});
        try{
          const result=await askProvider(interaction.options.getString('text',true));
          await interaction.editReply({content:`**${result.model}**\n${result.answer.slice(0,1800)}`,allowedMentions:{parse:[]}});
        }finally{askRequestsInFlight--;}
      }
    }
  }catch(error){
    log('ERROR',`${interaction.commandName} failed: ${error instanceof Error?error.message:'Unknown error'}`);
    const safe='SANWAN could not complete that request. Check the redacted logs.';
    if(interaction.deferred||interaction.replied) await interaction.editReply(safe).catch(()=>undefined);
    else await interaction.reply({content:safe,ephemeral:true}).catch(()=>undefined);
    await postChannel(process.env.ERROR_CHANNEL_ID,'SANWAN status, logs, or AI request failed. See local redacted logs.');
  }
});

process.on('SIGTERM', () => { log('INFO', 'Shutting down.'); clearHeartbeat(); db.close(); client.destroy(); process.exit(0); });
process.on('SIGINT', () => { clearHeartbeat(); db.close(); client.destroy(); process.exit(0); });
client.login(token).catch(error => { log('ERROR', `Discord login failed: ${error instanceof Error ? error.message : 'unknown error'}`); process.exitCode = 1; });
