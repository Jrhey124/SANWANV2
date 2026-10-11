const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

function composeArgs(values) {
  return values.DEPLOYMENTS_ENABLED === 'true'
    ? ['compose','-f','docker-compose.yml','-f','docker-compose.worker.yml','--profile','deployment']
    : ['compose','-f','docker-compose.yml'];
}
function selectedDocker(command, {run=spawnSync, env=process.env, platform=process.platform, stat=fs.statSync, uid=process.getuid?.(), gid=process.getgid?.()}={}) {
  const invoke=(args)=>run(command,args,{encoding:'utf8',windowsHide:true,timeout:15000,env});
  const info=invoke(['info','--format','{{json .SecurityOptions}}']);
  let rootless=false;
  try { rootless=info.status===0&&JSON.parse(info.stdout).some(v=>String(v).includes('rootless')); } catch {}
  let endpoint=env.DOCKER_HOST;
  if(!endpoint||env.DOCKER_CONTEXT){
    const context=env.DOCKER_CONTEXT || invoke(['context','show']).stdout?.trim();
    if(context){try{endpoint=JSON.parse(invoke(['context','inspect',context]).stdout)[0].Endpoints.docker.Host;}catch{}}
  }
  const socket=endpoint?.startsWith('unix://')?endpoint.slice(7):undefined;
  let socketGroup;
  try{const attributes=stat(socket);if(rootless&&attributes.uid===uid&&attributes.gid===gid)socketGroup='0';}catch{}
  return {rootless:platform==='linux'&&rootless,socket,gid:socketGroup,endpoint};
}
function detectWorker(command,{run=spawnSync}={}) {
  const bot=run(command,['compose','-f','docker-compose.yml','ps','-q','sanwan'],{encoding:'utf8',windowsHide:true,timeout:10000});
  if(bot.status!==0)return undefined;
  if(!bot.stdout?.trim())return false;
  const project=run(command,['inspect','--format','{{index .Config.Labels "com.docker.compose.project"}}',bot.stdout.trim()],{encoding:'utf8',windowsHide:true,timeout:10000});
  if(project.status!==0||!project.stdout?.trim())return undefined;
  const worker=run(command,['ps','--filter',`label=com.docker.compose.project=${project.stdout.trim()}`,'--filter','label=com.docker.compose.service=worker','--format','{{.ID}}'],{encoding:'utf8',windowsHide:true,timeout:10000});
  return worker.status===0?Boolean(worker.stdout?.trim()):undefined;
}
function repairConfigPermissions(cwd=process.cwd(),platform=process.platform) {
  for(const name of ['config','services']){
    const directory=path.join(cwd,name);
    fs.mkdirSync(directory,{recursive:true,mode:0o755});
    if(platform!=='win32')fs.chmodSync(directory,fs.statSync(directory).mode|0o555);
  }
  const registry=path.join(cwd,'config/services.json');
  if(!fs.existsSync(registry))fs.writeFileSync(registry,'{\n  "services": {}\n}\n',{mode:0o644,flag:'wx'});
  if(platform!=='win32')fs.chmodSync(registry,0o644);
}
function servicePath(relative,cwd=process.cwd()) {
  const root=fs.realpathSync(path.join(cwd,'services'));
  if(path.isAbsolute(relative)||relative.split(/[\\/]/).includes('..'))throw Error('Use a relative Compose path inside services/, without ..');
  const file=fs.realpathSync(path.join(root,relative));
  if(!file.startsWith(root+path.sep))throw Error('Compose symlinks must stay inside services/.');
  if(!fs.statSync(file).isFile())throw Error('Choose a Compose file.');
  if(process.platform!=='win32'){
    let current=file;
    while(current!==root){
      const stat=fs.statSync(current);const required=stat.isDirectory()?0o005:0o004;
      if((stat.mode&required)!==required)throw Error(`Container cannot read ${path.relative(cwd,current)}. Run chmod ${stat.isDirectory()?'755':'644'} '${path.relative(cwd,current)}'.`);
      current=path.dirname(current);
    }
  }
  return file;
}
function starterCompose(image,port,containerPort,project,mount) {
  const app={image:image+':latest',ports:[`${port}:${containerPort}`],restart:'unless-stopped'};
  const document={services:{app}};
  if(mount){app.volumes=[`data:${mount}`];document.volumes={data:{name:project+'-data'}};}
  return JSON.stringify(document,null,2)+'\n';
}
function inspectService(command,file,service,{run=spawnSync}={}) {
  const result=run(command,['compose','-f',file,'config','--format','json'],{encoding:'utf8',windowsHide:true,timeout:15000});
  if(result.status!==0)throw Error('Compose validation failed. Check the file syntax and required variables.');
  const item=JSON.parse(result.stdout).services?.[service];
  if(!item?.image||item.build)throw Error('Select a Compose service using a published image without a build context.');
  if(item.healthcheck?.disable||item.healthcheck?.test?.[0]==='NONE')throw Error('Healthcheck is disabled. Enable an application healthcheck.');
  if(item.healthcheck?.test!==undefined){
    if(!Array.isArray(item.healthcheck.test)||item.healthcheck.test.length<2||!['CMD','CMD-SHELL'].includes(item.healthcheck.test[0]))throw Error('Define a valid CMD or CMD-SHELL healthcheck.');
    return true;
  }
  const image=run(command,['image','inspect','--format','{{json .Config.Healthcheck}}',item.image],{encoding:'utf8',windowsHide:true,timeout:15000});
  try{const health=JSON.parse(image.stdout);return image.status===0&&health?.Test?.length>1&&['CMD','CMD-SHELL'].includes(health.Test[0]);}catch{return false;}
}
async function registerService(values,command,io,{cwd=process.cwd(),run=spawnSync}={}) {
  const {prompt,choice,print=console.log}=io;
  const ask=async(label,fallback,validate)=>{
    while(true){const v=(await prompt(`  ${label}${fallback?' ['+fallback+']':''}: `)).trim()||fallback;
      if(v&&(!validate||validate(v)))return v;print('  Enter a valid value.');}
  };
  repairConfigPermissions(cwd);
  const registryFile=path.join(cwd,'config/services.json');
  const registry=JSON.parse(fs.readFileSync(registryFile,'utf8'));
  if(!registry.services||Array.isArray(registry.services)||typeof registry.services!=='object')throw Error('Fix config/services.json: services must be an object.');
  const name=await ask('Service name','',v=>/^[a-z0-9][a-z0-9_-]{0,39}$/.test(v));
  const saved=Object.hasOwn(registry.services,name)?registry.services[name]:undefined;
  if(saved&&await choice('  1) Keep existing service  2) Replace [1]: ',['1','2'],'1')==='1')return;
  const allowed=(values.GITHUB_REPOSITORIES||'').split(',').map(v=>v.trim()).filter(Boolean);
  if(!allowed.length){print('  Configure GitHub monitoring and its repository allowlist first.');return;}
  const repository=await ask('Allowlisted owner/repo',saved?.github_repository||allowed[0],v=>allowed.includes(v));
  const workflow=await ask('Workflow name',saved?.workflow_name||'Build and publish image',v=>!/[\r\n]/.test(v));
  const staging=await ask('Staging branch',saved?.staging_branch||'develop');
  const production=await ask('Production branch',saved?.production_branch||'main',v=>v!==staging);
  const image=await ask('GHCR image without tag',saved?.image_repository||'ghcr.io/'+repository.toLowerCase(),v=>/^ghcr\.io\/[a-z0-9][a-z0-9._/-]*$/.test(v)&&!v.includes('..'));
  const mode=await choice('  1) Generate starter Compose files  2) Use files under services/ [1]: ',['1','2'],'1');
  const environments={};const generated=[];
  const usedProjects=new Set(Object.entries(registry.services).filter(([key])=>key!==name).flatMap(([,entry])=>Object.values(entry.environments||{}).map(e=>e.compose_project)));
  const reservedPorts=new Set();
  for(const entry of Object.values(registry.services))for(const e of Object.values(entry.environments||{})){
    try{const rendered=run(command,['compose','-f',servicePath(e.compose_file,cwd),'config','--format','json'],{encoding:'utf8',windowsHide:true,timeout:15000});
      if(rendered.status===0)for(const item of Object.values(JSON.parse(rendered.stdout).services||{}))for(const port of item.ports||[])if(port.published)reservedPorts.add(String(port.published));
    }catch{}
  }
  let nextPort=18081;while(reservedPorts.has(String(nextPort)))nextPort++;
  let internalPort,mount,previousPort;
  if(mode==='1'){
    internalPort=await ask('Application container port','8080',v=>/^\d+$/.test(v)&&+v>0&&+v<=65535);
    if(await choice('  Named data volume? 1) No  2) Yes [1]: ',['1','2'],'1')==='2')mount=await ask('Container data directory','/data',v=>/^\/[a-zA-Z0-9_./-]+$/.test(v)&&!v.includes('..'));
  }
  for(const environment of ['staging','production']){
    const old=saved?.environments?.[environment];
    const project=await ask(`${environment} Compose project`,old?.compose_project||`${name}-${environment}`,v=>/^[a-z0-9][a-z0-9_-]{0,62}$/.test(v)&&v!==environments.staging?.compose_project&&!usedProjects.has(v));
    let relative,service;
    if(mode==='1'){
      const port=await ask(`${environment} host port`,String(nextPort),v=>/^\d+$/.test(v)&&+v>=1024&&+v<=65535&&v!==previousPort&&!reservedPorts.has(v));
      reservedPorts.add(port);nextPort=Number(port)+1;while(reservedPorts.has(String(nextPort)))nextPort++;
      previousPort=port;relative=`${name}/compose.${environment}.json`;service='app';
      const file=path.join(cwd,'services',relative);
      if(fs.existsSync(file)){print(`  ${relative} already exists. Choose existing files or another service name; it will not be overwritten.`);return;}
      generated.push({file,content:starterCompose(image,port,internalPort,project,mount)});
    }else{
      while(true){relative=await ask(`${environment} Compose path relative to services/`,old?.compose_file||`${name}/compose.${environment}.yml`);
        try{servicePath(relative,cwd);break;}catch(error){print('  '+error.message);}}
      service=await ask(`${environment} Compose service`,old?.compose_service||'app',v=>/^[-a-zA-Z0-9_]{1,63}$/.test(v));
    }
    environments[environment]={compose_project:project,compose_file:relative,compose_service:service,health_timeout_seconds:120};
  }
  const entry={github_repository:repository,workflow_name:workflow,staging_branch:staging,production_branch:production,image_repository:image,environments};
  print('  Service configuration preview (no credentials):\n'+JSON.stringify({[name]:entry},null,2));
  if(await choice('  Save service? 1) Save  2) Cancel [1]: ',['1','2'],'1')!=='1')return;
  for(const file of generated){fs.mkdirSync(path.dirname(file.file),{recursive:true,mode:0o755});fs.writeFileSync(file.file,file.content,{mode:0o644,flag:'wx'});}
  registry.services[name]=entry;
  fs.writeFileSync(registryFile,JSON.stringify(registry,null,2)+'\n',{mode:0o644});
  for(const environment of ['staging','production']){
    try {const e=environments[environment];const healthy=inspectService(command,servicePath(e.compose_file,cwd),e.compose_service,{run});
      print(`  ${healthy?'PASS':'WARN'} · ${name}/${environment}: ${healthy?'healthcheck configured; runtime health remains untested':'image healthcheck not verified locally. Add a Compose healthcheck or use an image with HEALTHCHECK; readiness is not confirmed'}.`);
    } catch(error){print(`  WARN · ${name}/${environment}: ${error.message}`);}
  }
}
module.exports={composeArgs,selectedDocker,detectWorker,repairConfigPermissions,servicePath,starterCompose,inspectService,registerService};
