import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { execFile as execFileCb, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const execFile = promisify(execFileCb);
type Environment = { compose_project: string; compose_file: string; compose_service: string; health_timeout_seconds?: number };
type Service = { github_repository: string; workflow_name: string; staging_branch: string; production_branch: string; image_repository: string; environments: Record<'staging'|'production',Environment> };
type Config = { services: Record<string,Service> };
type Request = { operation: 'simulate'|'status'|'start'|'stop'|'restart'|'prepare'|'deploy'|'rollback'; service: string; environment: 'staging'|'production'; sha?: string; digest?:string; expected_digest?:string };
type State = Record<string,{active?:string;previous?:string;active_sha?:string;previous_sha?:string;updated_at?:string}>;
const configPath=process.env.SERVICES_CONFIG??'/config/services.json';
const servicesRoot=resolve(process.env.SERVICES_ROOT??'/services');
const stateDir=process.env.WORKER_STATE_DIR??'/worker-state';
const tempDir=process.env.WORKER_TMP_DIR??'/tmp';
const statePath=resolve(stateDir,'releases.json');
const dockerSocket=process.env.DOCKER_HOST??'unix:///var/run/docker.sock';
const dockerConfig=resolve(tempDir,'sanwan-docker-config');
const secret=process.env.WORKER_TOKEN??'';

function loadConfig():Config {
  const parsed=JSON.parse(readFileSync(configPath,'utf8')) as Config;
  if(!parsed || typeof parsed.services!=='object' || !parsed.services) throw new Error('Invalid worker service configuration.');
  for(const [name,s] of Object.entries(parsed.services)){
    if(!/^[a-z0-9][a-z0-9_-]{0,39}$/i.test(name)) throw new Error(`Invalid service key: ${name}`);
    if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s.github_repository)||!s.workflow_name||!s.image_repository) throw new Error(`Incomplete trusted config for service ${name}.`);
    for(const envName of ['staging','production'] as const){
      const env=s.environments?.[envName];
      if(!env||!/^[-a-zA-Z0-9_]{1,63}$/.test(env.compose_project)||!/^[-a-zA-Z0-9_]{1,63}$/.test(env.compose_service)) throw new Error(`Invalid ${envName} Compose mapping for ${name}.`);
      if(typeof env.compose_file!=='string'||env.compose_file.startsWith('/')||env.compose_file.split(/[\\/]/).includes('..')) throw new Error(`Compose file must be a relative path below /services (${name}/${envName}).`);
      const candidate=resolve(servicesRoot,env.compose_file);
      const f=realpathSync(candidate);
      if(!f.startsWith(`${realpathSync(servicesRoot)}${sep}`)) throw new Error(`Compose file symlinks must remain under /services (${name}/${envName}).`);
      env.compose_file=f;
    }
    if(!/^([a-z0-9.-]+(?::[0-9]+)?\/)?[a-z0-9][a-z0-9._/-]*$/i.test(s.image_repository)||s.image_repository.includes('..')) throw new Error(`Invalid image repository for ${name}.`);
  }
  return parsed;
}
const config=loadConfig();
mkdirSync(stateDir,{recursive:true});

function readState():State {
  let raw:string;
  try{raw=readFileSync(statePath,'utf8');}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return{};throw new Error('Persistent deployment state is unreadable; refusing to change releases.');}
  try{
    const parsed=JSON.parse(raw) as unknown;
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error('invalid state root');
    for(const [key,value] of Object.entries(parsed)){
      if(!/^[a-z0-9][a-z0-9_-]{0,39}:(staging|production)$/i.test(key)||!value||typeof value!=='object'||Array.isArray(value))throw new Error('invalid state entry');
      const item=value as Record<string,unknown>;
      for(const field of ['active','previous'] as const){const digest=item[field];if(digest!==undefined&&(typeof digest!=='string'||!/^.+@sha256:[a-f0-9]{64}$/i.test(digest)))throw new Error('invalid saved digest');}
      for(const field of ['active_sha','previous_sha'] as const){const sha=item[field];if(sha!==undefined&&(typeof sha!=='string'||!/^[a-f0-9]{40}$/i.test(sha)))throw new Error('invalid saved revision');}
    }
    return parsed as State;
  }catch{throw new Error('Persistent deployment state is invalid; refusing to change releases.');}
}
function writeState(state:State){
  const temp=`${statePath}.${randomBytes(8).toString('hex')}.tmp`;
  writeFileSync(temp,JSON.stringify(state,null,2),{mode:0o600,flag:'wx'});
  renameSync(temp,statePath);
}
async function docker(args:string[],timeout=30000):Promise<string>{
  mkdirSync(dockerConfig,{recursive:true,mode:0o700});
  const prefix=process.env.DOCKER_CLI_ARGS?JSON.parse(process.env.DOCKER_CLI_ARGS) as string[]:[];
  const {stdout}=await execFile(process.env.DOCKER_CLI??'docker',[...prefix,...args],{timeout,maxBuffer:2*1024*1024,windowsHide:true,env:{...process.env,DOCKER_HOST:dockerSocket,DOCKER_CONFIG:dockerConfig}});
  return stdout.trim();
}
async function loginGhcr(){
  const username=process.env.GHCR_USERNAME;const password=process.env.GHCR_TOKEN;
  if(!password)return;
  if(!username)throw new Error('GHCR_USERNAME is required when GHCR_TOKEN is configured.');
  mkdirSync(dockerConfig,{recursive:true,mode:0o700});
  await new Promise<void>((resolvePromise,reject)=>{
    const prefix=process.env.DOCKER_CLI_ARGS?JSON.parse(process.env.DOCKER_CLI_ARGS) as string[]:[];
    const child=spawn(process.env.DOCKER_CLI??'docker',[...prefix,'login','ghcr.io','--username',username,'--password-stdin'],{env:{...process.env,DOCKER_HOST:dockerSocket,DOCKER_CONFIG:dockerConfig},windowsHide:true});
    child.stderr.resume();
    child.on('error',reject);child.on('close',code=>code===0?resolvePromise():reject(new Error(`GHCR login failed (exit ${code}).`)));
    child.stdin.end(password);
  });
}
async function verifyPinnedImage(service:Service,sha:string,digest:string){
  if(!digest.startsWith(`${service.image_repository}@sha256:`)||!/^.+@sha256:[a-f0-9]{64}$/i.test(digest)) throw new Error('Release digest does not match the locally configured repository.');
  await docker(['pull',digest],300000);
  const inspected=await docker(['image','inspect','--format','{{json .RepoDigests}}|{{index .Config.Labels "org.opencontainers.image.revision"}}',digest]);
  const split=inspected.indexOf('|');
  const repoDigests=JSON.parse(inspected.slice(0,split)) as string[];
  const revision=inspected.slice(split+1).trim();
  if(revision!==sha.toLowerCase()||!repoDigests.includes(digest)) throw new Error('Pinned image digest does not match the approved source revision.');
}
async function resolveCommitDigest(service:Service,sha:string){
  if(service.image_repository.startsWith('ghcr.io/')) await loginGhcr();
  const imageTag=`${service.image_repository}:sha-${sha.toLowerCase()}`;
  await docker(['pull',imageTag],300000);
  const inspected=await docker(['image','inspect','--format','{{json .RepoDigests}}|{{index .Config.Labels "org.opencontainers.image.revision"}}',imageTag]);
  const split=inspected.indexOf('|');
  const repoDigests=JSON.parse(inspected.slice(0,split)) as string[];
  const revision=inspected.slice(split+1).trim();
  if(revision!==sha.toLowerCase()) throw new Error('Pulled image revision label does not match the requested commit.');
  const digest=repoDigests.find(value=>value.startsWith(`${service.image_repository}@sha256:`));
  if(!digest) throw new Error('Pulled image has no digest in the configured repository.');
  return digest;
}
async function assertRootless(){
  const options=await docker(['info','--format','{{json .SecurityOptions}}']);
  let values:string[]=[];try{values=JSON.parse(options) as string[];}catch{}
  if(!values.some(v=>/rootless/i.test(v))) throw new Error('Deployment is disabled because the configured Docker daemon is not rootless. Use rootless Docker before enabling the worker.');
}
function baseArgs(service:Service,environment:'staging'|'production'){
  const env=service.environments[environment];
  return ['compose','--project-name',env.compose_project,'--project-directory',dirname(env.compose_file),'-f',env.compose_file];
}
function overrideFor(service:Service,environment:'staging'|'production',digest:string){
  const env=service.environments[environment];
  if(!digest.startsWith(`${service.image_repository}@sha256:`)||!/^.+@sha256:[a-f0-9]{64}$/i.test(digest)) throw new Error('Release must be a digest pinned to the configured image repository.');
  const path=resolve(tempDir,`sanwan-${randomBytes(12).toString('hex')}.json`);
  writeFileSync(path,JSON.stringify({services:{[env.compose_service]:{image:digest,pull_policy:'always'}}}),{mode:0o600,flag:'wx'});
  return path;
}
type RenderedService={privileged?:boolean;network_mode?:string;pid?:string;ipc?:string;uts?:string;userns_mode?:string;devices?:unknown[];cap_add?:unknown[];healthcheck?:{test?:unknown};volumes?:Array<{type?:string;source?:string}>;build?:unknown;security_opt?:string[];secrets?:unknown[];configs?:unknown[];volumes_from?:unknown[];extends?:unknown;credential_spec?:unknown;devices_cgroup_rules?:unknown[];deploy?:{privileged?:boolean;resources?:{reservations?:{devices?:unknown[]}}}};
async function getComposeConfig(service:Service,environment:'staging'|'production',override?:string){
  const args=baseArgs(service,environment);
  if(override) args.push('-f',override);
  const raw=await docker([...args,'config','--format','json']);
  const config=JSON.parse(raw) as {services?:Record<string,RenderedService>};
  const env=service.environments[environment];
  const item=config.services?.[env.compose_service];
  if(!item) throw new Error(`Registered Compose service ${env.compose_service} is missing.`);
  if(item.privileged||item.deploy?.privileged||item.network_mode==='host'||item.pid==='host'||item.ipc==='host'||item.uts==='host'||item.userns_mode==='host'||item.devices?.length||item.deploy?.resources?.reservations?.devices?.length||item.cap_add?.length) throw new Error('Deployment service uses a prohibited host privilege, device, or namespace setting.');
  if(item.security_opt?.some(value=>/unconfined|label=disable|no-new-privileges:false/i.test(value))) throw new Error('Deployment service disables a container security profile.');
  if(item.secrets?.length||item.configs?.length) throw new Error('Compose file secrets and configs are not allowed; manage credentials outside deployment definitions.');
  if(item.volumes_from?.length||item.extends||item.credential_spec||item.devices_cgroup_rules?.length) throw new Error('Deployment service uses an indirect mount, inherited service, host credential, or device rule.');
  if(item.build) throw new Error('Deployment definitions must use published images, not build contexts.');
  if(!item.healthcheck?.test||JSON.stringify(item.healthcheck.test).includes('NONE')) throw new Error('Deployment service must define a working healthcheck.');
  if(item.volumes?.some(v=>v.type!=='volume'||!v.source||v.source.startsWith('/')||v.source.split(/[\\/]/).includes('..'))) throw new Error('Only named volumes are allowed; bind mounts and host paths are prohibited.');
  return config;
}
async function deployDigest(environment:'staging'|'production',service:Service,digest:string,forceRecreate=false){
  await assertRootless();
  const override=overrideFor(service,environment,digest);
  try{
    await getComposeConfig(service,environment,override);
    const args=baseArgs(service,environment);args.push('-f',override);
    await docker([...args,'pull',service.environments[environment].compose_service],300000);
    await docker([...args,'up','-d','--no-deps',...(forceRecreate?['--force-recreate']:[]),service.environments[environment].compose_service],120000);
    const timeout=Math.max(10,Math.min(service.environments[environment].health_timeout_seconds??120,300));
    const end=Date.now()+timeout*1000;
    let healthy=false;
    while(Date.now()<end){
      const ids=await docker([...args,'ps','-q',service.environments[environment].compose_service]);
      const id=ids.split(/\s+/)[0];
      if(id&&/^[a-f0-9]{12,64}$/i.test(id)){
        const state=await docker(['inspect','--format','{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}',id]);
        if(state==='running|healthy'){healthy=true;break;}
        if(state.startsWith('exited|')||state.startsWith('dead|')) break;
      }
      await new Promise(r=>setTimeout(r,3000));
    }
    if(!healthy) throw new Error('New release did not become healthy before the deadline.');
    return true;
  }finally{try{require('node:fs').unlinkSync(override);}catch{}}
}
async function waitHealthy(service:Service,environment:'staging'|'production',digest:string){return deployDigest(environment,service,digest);}
async function handle(input:Request){
  if(!input||!['simulate','status','start','stop','restart','prepare','deploy','rollback'].includes(input.operation)||!['staging','production'].includes(input.environment)) throw new Error('Invalid worker operation.');
  await assertRootless();
  if(!/^[a-z0-9][a-z0-9_-]{0,39}$/i.test(input.service)||!Object.hasOwn(config.services,input.service)) throw new Error('Unknown locally registered service.');
  const service=config.services[input.service];
  const key=`${input.service}:${input.environment}`;
  const state=readState();
  const current=state[key]??{};
  if(input.operation==='simulate'){
    if(input.sha&&!/^[a-f0-9]{40}$/i.test(input.sha)) throw new Error('Commit SHA must be 40 hexadecimal characters.');
    try{
      await getComposeConfig(service,input.environment);
      return {ok:true,service:input.service,environment:input.environment,planned_image:input.sha?`${service.image_repository}:sha-${input.sha.toLowerCase()}`:undefined,changed:false};
    }finally{rmSync(dockerConfig,{recursive:true,force:true});}
  }
  if(input.operation==='status'){
    try{
      await getComposeConfig(service,input.environment);
      const args=baseArgs(service,input.environment);
      const output=await docker([...args,'ps','--format','json',service.environments[input.environment].compose_service]);
      return {ok:true,service:input.service,environment:input.environment,status:output||'stopped',active_digest:current.active,previous_digest:current.previous,active_sha:current.active_sha,previous_sha:current.previous_sha};
    }finally{rmSync(dockerConfig,{recursive:true,force:true});}
  }
  if(input.operation==='prepare'){
    if(!input.sha||!/^[a-f0-9]{40}$/i.test(input.sha)) throw new Error('Commit SHA must be 40 hexadecimal characters.');
    try{await assertRootless();return {ok:true,service:input.service,environment:input.environment,sha:input.sha.toLowerCase(),digest:await resolveCommitDigest(service,input.sha)};}
    finally{rmSync(dockerConfig,{recursive:true,force:true});}
  }
  if(input.operation==='deploy'){
    try{
    if(!input.sha||!/^[a-f0-9]{40}$/i.test(input.sha)) throw new Error('Commit SHA must be 40 hexadecimal characters.');
    await assertRootless();
    const digest=input.digest??await resolveCommitDigest(service,input.sha);
    if(input.digest){if(service.image_repository.startsWith('ghcr.io/'))await loginGhcr();await verifyPinnedImage(service,input.sha,digest);}
    const before=readState();
    try{
      await deployDigest(input.environment,service,digest);
      before[key]={active:digest,previous:before[key]?.active,active_sha:input.sha.toLowerCase(),previous_sha:before[key]?.active_sha,updated_at:new Date().toISOString()};
      writeState(before);
      return {ok:true,service:input.service,environment:input.environment,digest,health:'healthy'};
    }catch(error){
      const previous=before[key]?.active;
      let rollback='no previous healthy release';
      if(previous){
        try{await waitHealthy(service,input.environment,previous);rollback='previous release restored';}
        catch{rollback='automatic rollback failed; inspect service status';}
      }else{try{const args=baseArgs(service,input.environment);await docker([...args,'stop',service.environments[input.environment].compose_service]);}catch{rollback='no previous release; failed service could not be stopped';}}
      throw new Error(`Release failed; ${rollback}. ${error instanceof Error?error.message:'unknown error'}`);
    }
    }finally{rmSync(dockerConfig,{recursive:true,force:true});}
  }
  if(input.operation==='rollback'){
    await assertRootless();
    if(!current.previous) throw new Error('No previous healthy release is available.');
    if(input.expected_digest&&input.expected_digest!==current.previous) throw new Error('The previous release changed since approval was requested.');
    try{await waitHealthy(service,input.environment,current.previous);}
    catch(error){
      let recovery='current release restored';
      if(current.active){try{await waitHealthy(service,input.environment,current.active);}catch{recovery='automatic recovery failed; inspect service status';}}
      throw new Error(`Rollback failed; ${recovery}. ${error instanceof Error?error.message:'unknown error'}`);
    }
    state[key]={active:current.previous,previous:current.active,active_sha:current.previous_sha,previous_sha:current.active_sha,updated_at:new Date().toISOString()};
    writeState(state);
    return {ok:true,service:input.service,environment:input.environment,digest:current.previous,health:'healthy'};
  }
  if(input.operation==='stop'){
    await assertRootless();
    const args=baseArgs(service,input.environment);
    await docker([...args,'stop',service.environments[input.environment].compose_service]);
    return {ok:true,service:input.service,environment:input.environment,status:'stopped'};
  }
  if(input.operation==='start'||input.operation==='restart'){
    await assertRootless();
    if(!current.active) throw new Error('No pinned deployed release exists; deploy a successful CI commit first.');
    await deployDigest(input.environment,service,current.active,input.operation==='restart');
    return {ok:true,service:input.service,environment:input.environment,status:input.operation==='restart'?'restarted':'started',active_digest:current.active,health:'healthy'};
  }
  throw new Error('Unsupported worker operation.');
}
function send(res:ServerResponse,status:number,body:unknown){const data=JSON.stringify(body);res.writeHead(status,{'content-type':'application/json','content-length':Buffer.byteLength(data),'cache-control':'no-store'});res.end(data);}
let operationBusy=false;
const server=createServer(async(req:IncomingMessage,res:ServerResponse)=>{
  if(req.method==='GET'&&req.url==='/health'){send(res,200,{ok:true});return;}
  if(req.method!=='POST'||req.url!=='/v1/action'){send(res,404,{error:'not found'});return;}
  if(secret.length<64){send(res,503,{error:'worker authentication is not configured'});return;}
  const auth=req.headers.authorization??'';
  const supplied=Buffer.from(auth.startsWith('Bearer ')?auth.slice(7):'');
  const expected=Buffer.from(secret);
  if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected)){send(res,401,{error:'unauthorized'});return;}
  if(operationBusy){send(res,409,{error:'another worker operation is running'});return;}
  operationBusy=true;
  let body='';let tooLarge=false;
  req.on('data',chunk=>{if(tooLarge)return;body+=chunk;if(body.length>8192){tooLarge=true;body='';}});
  req.on('end',async()=>{
    try{if(tooLarge){send(res,413,{error:'request too large'});return;}const result=await handle(JSON.parse(body) as Request);send(res,200,result);}
    catch(error){const message=error instanceof Error?error.message:'worker operation failed';console.error(`${new Date().toISOString()} ${message}`);send(res,400,{error:message});}
    finally{operationBusy=false;}
  });
});

if(require.main===module){
  if(secret.length<64) throw new Error('WORKER_TOKEN must be a 64-character random hex secret.');
  void assertRootless().then(()=>server.listen(Number(process.env.WORKER_PORT??8877),'0.0.0.0')).catch(error=>{
    const detail=error instanceof Error?error.message:'unknown error';
    console.error(`Worker startup refused: ${detail}`);
    process.exitCode=1;
  });
}
export { handle, server };
