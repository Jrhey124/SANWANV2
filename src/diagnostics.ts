import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3-multiple-ciphers';
import { PermissionsBitField } from 'discord.js';
import { isHealthy } from './health';

type Result = {status:'PASS'|'WARN'|'FAIL'|'SKIP'; name:string; detail:string};
export async function runDiagnostics(env:NodeJS.ProcessEnv=process.env, request:typeof fetch=fetch, workerEnabled=false, activeModel?:()=>string|undefined):Promise<Result[]> {
  const results:Result[]=[];
  const add=(status:Result['status'],name:string,detail:string)=>results.push({status,name,detail});
  const check=async(name:string,action:()=>Promise<void>,fix='Check access and settings with node setup.js, then rebuild and start.')=>{
    try { await action(); } catch(error) {
      const message=error instanceof Error?error.message:'';
      const safe=/^HTTP \d{3}$/.test(message)?message:'Connection failed or timed out';
      add('FAIL',name,safe+'. '+fix);
    }
  };
  const get=async(url:string,headers:Record<string,string>={})=>{
    const response=await request(url,{headers,signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error('HTTP '+response.status);
    return response.json();
  };
  try { add(isHealthy()?'PASS':'FAIL','Discord heartbeat',isHealthy()?'Gateway and command-registration heartbeat is fresh.':'Heartbeat is missing or stale. Check startup logs and rebuild through node setup.js.'); }
  catch { add('FAIL','Discord heartbeat','Heartbeat could not be read. Check startup logs.'); }
  let botId='';
  const discord=(path:string)=>get('https://discord.com/api/v10'+path,{Authorization:'Bot '+env.DISCORD_TOKEN});
  if(!env.DISCORD_TOKEN) add('FAIL','Discord identity','Bot token missing; configure Discord with node setup.js.');
  else await check('Discord identity',async()=>{const user=await discord('/users/@me');if(!user.bot)throw new Error('Not a bot');botId=user.id;add('PASS','Discord identity','Bot token accepted.');});
  const guild=env.DISCORD_GUILD_ID;
  if(guild && env.DISCORD_TOKEN){
    await check('Discord server',async()=>{await discord('/guilds/'+guild);add('PASS','Discord server','Configured server is accessible.');});
    if(env.DISCORD_APPLICATION_ID)await check('Slash commands',async()=>{
      const commands=await discord('/applications/'+env.DISCORD_APPLICATION_ID+'/guilds/'+guild+'/commands');
      const required=['help','ping','ci','deploy','task','note','schedule','logs','errors','status','ask'];
      const missing=required.filter(name=>!commands.some((command:{name:string})=>command.name===name));
      add(missing.length?'FAIL':'PASS','Slash commands',missing.length?'Missing commands: '+missing.join(', ')+'. Rebuild and start through node setup.js.':'All expected commands are registered.');
    });
    else add('FAIL','Slash commands','Application ID missing; configure Discord with node setup.js.');
  }else add('FAIL','Discord server','Discord token or server ID is missing. Use node setup.js.');
  for(const setting of ['GITHUB_CHANNEL_ID','TASK_CHANNEL_ID','ERROR_CHANNEL_ID','APPROVAL_CHANNEL_ID']){
    if(!env[setting]){add('SKIP',setting,'Optional notification channel is not configured.');continue;}
    await check(setting,async()=>{
      if(!botId||!guild)throw new Error('Discord unavailable');
      const channel=await discord('/channels/'+env[setting]);
      if(channel.guild_id!==guild){add('FAIL',setting,'Channel belongs to a different server. Replace its ID through node setup.js.');return;}
      if(![0,5].includes(channel.type)){add('WARN',setting,'Use a server text or announcement channel for these notifications.');return;}
      const roles=await discord('/guilds/'+guild+'/roles');
      const member=await discord('/guilds/'+guild+'/members/'+botId);
      let permissions=new PermissionsBitField();
      for(const role of roles)if(role.id===guild||member.roles.includes(role.id))permissions.add(BigInt(role.permissions));
      if(!permissions.has(PermissionsBitField.Flags.Administrator)){
        const overwrites=channel.permission_overwrites??[];
        const apply=(entries:Array<{allow:string;deny:string}>)=>{
          let allow=0n,deny=0n;for(const item of entries){allow|=BigInt(item.allow);deny|=BigInt(item.deny);}
          permissions.remove(deny);permissions.add(allow);
        };
        apply(overwrites.filter((o:{id:string})=>o.id===guild));
        apply(overwrites.filter((o:{type:number;id:string})=>o.type===0&&member.roles.includes(o.id)));
        apply(overwrites.filter((o:{type:number;id:string})=>o.type===1&&o.id===botId));
      }
      const needed=[PermissionsBitField.Flags.ViewChannel,PermissionsBitField.Flags.SendMessages];
      if(setting==='APPROVAL_CHANNEL_ID')needed.push(PermissionsBitField.Flags.EmbedLinks);
      const allowed=permissions.has(needed);
      add(allowed?'PASS':'FAIL',setting,allowed?'Bot can access and send messages here (no test message sent).':'Grant View Channel and Send Messages; approval cards also need Embed Links.');
    });
  }
  const repos=(env.GITHUB_REPOSITORIES??'').split(',').map(x=>x.trim()).filter(Boolean);
  if(!repos.length&&!env.GITHUB_TOKEN)add('SKIP','GitHub','Optional integration is not configured.');
  else if(!repos.length||!env.GITHUB_TOKEN)add('FAIL','GitHub','Token and repository allowlist are both required. Use node setup.js.');
  else for(const repo of repos){
    if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)){add('FAIL','GitHub repository','Invalid owner/repository in allowlist; replace it with node setup.js.');continue;}
    for(const [label,suffix] of [['repository',''],['workflow runs','/actions/runs?per_page=1'],['activity feed','/events?per_page=1']])await check('GitHub '+repo+' '+label,async()=>{
      await get('https://api.github.com/repos/'+repo+suffix,{Authorization:'Bearer '+env.GITHUB_TOKEN,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'});
      add('PASS','GitHub '+repo+' '+label,'API access works; empty results are valid. This does not prove future event delivery.');
    });
  }
  if(!env.ASK_PROVIDER&&!env.ASK_BASE_URL&&!env.ASK_MODEL)add('SKIP','AI','Optional integration is not configured.');
  else await check('AI model access',async()=>{
    let model:string|undefined;
    try { model=activeModel?activeModel():readActiveModel(env); } catch { add('FAIL','AI active model','Cannot read the saved active model from encrypted storage. Check database and SQLITE_KEY settings.');return; }
    model ||= env.ASK_MODEL;
    if(!['ollama','openai-compatible'].includes(env.ASK_PROVIDER??'')||!env.ASK_BASE_URL||!model){add('FAIL','AI model access','Configure provider, base URL, and model using node setup.js.');return;}
    const url=new URL(env.ASK_BASE_URL);
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('Invalid URL');
    if(env.ASK_API_KEY&&url.protocol!=='https:'&&!['localhost','127.0.0.1','::1','ollama','host.docker.internal'].includes(url.hostname))throw new Error('Insecure URL');
    const payload=await get(env.ASK_BASE_URL.replace(/\/+$/,'')+(env.ASK_PROVIDER==='ollama'?'/api/tags':'/models'),env.ASK_API_KEY?{Authorization:'Bearer '+env.ASK_API_KEY}:{});
    const models=env.ASK_PROVIDER==='ollama'?payload.models?.map((m:{name:string})=>m.name):payload.data?.map((m:{id:string})=>m.id);
    add(models?.includes(model)?'PASS':'FAIL','AI model access',models?.includes(model)?'Active model is listed. Generation, quota, and billing are not tested.':'Active model is unavailable. Select an available model with /ask switch or node setup.js.');
  });
  if(!workerEnabled)add('SKIP','Deployment worker','Optional worker is not enabled.');
  else {
    await check('Deployment worker health',async()=>{const data=await get((env.WORKER_URL??'http://worker:8877')+'/health');if(data.ok!==true)throw new Error('Unhealthy');add('PASS','Deployment worker health','Worker health endpoint is ready.');});
    await check('Service registry',async()=>{
      const registry=JSON.parse(readFileSync(env.SERVICES_CONFIG??'/config/services.json','utf8'));
      if(!registry.services||typeof registry.services!=='object'||Array.isArray(registry.services))throw new Error('Invalid registry');
      const services=Object.values(registry.services) as Array<Record<string,any>>;
      const valid=services.every(s=>s.github_repository&&s.workflow_name&&s.staging_branch&&s.production_branch&&s.image_repository&&['staging','production'].every(e=>s.environments?.[e]?.compose_file&&s.environments[e].compose_project&&s.environments[e].compose_service));
      add(!services.length?'WARN':valid?'PASS':'FAIL','Service registry',!services.length?'No services registered. Configure config/services.json.':valid?'Service registry has required fields. Deployment execution is not tested.':'Missing service or environment fields; update config/services.json.');
    },'Check config/services.json for valid JSON and required service mappings.');
  }
  for(const row of results)for(const name of ['DISCORD_TOKEN','GITHUB_TOKEN','ASK_API_KEY','GHCR_TOKEN','SQLITE_KEY','WORKER_TOKEN']){
    const secret=env[name];
    if(secret&&secret.length>=8){row.name=row.name.replaceAll(secret,'[REDACTED]');row.detail=row.detail.replaceAll(secret,'[REDACTED]');}
  }
  return results;
}

function readActiveModel(env:NodeJS.ProcessEnv):string|undefined {
  const db=new Database((env.DATA_DIR??'/app/data')+'/sanwan.db',{readonly:true,fileMustExist:true});
  try { db.pragma("cipher = 'sqlcipher'");db.key(Buffer.from(env.SQLITE_KEY??'','utf8'));return (db.prepare("SELECT value FROM setting WHERE key='ask_model'").get() as {value:string}|undefined)?.value; }
  finally {db.close();}
}
if(require.main===module)runDiagnostics(process.env,fetch,process.argv.includes('--worker-enabled')).then(results=>console.log(JSON.stringify(results))).catch(()=>{console.log(JSON.stringify([{status:'FAIL',name:'Diagnostics',detail:'Checks could not finish. Check local logs.'}]));process.exitCode=1;});
