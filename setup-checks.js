const fs = require('node:fs');
const {composeArgs} = require('./setup-deployments.js');
const { spawnSync } = require('node:child_process');
const { findDockerCommand } = require('./docker-cli.js');

async function runSavedChecks({run=spawnSync,now=Date.now,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),print=console.log}={}) {
  const docker=findDockerCommand();
  const values={};
  if(fs.existsSync('.env'))for(const line of fs.readFileSync('.env','utf8').split(/\r?\n/)){const i=line.indexOf('=');if(i>0)values[line.slice(0,i)]=line.slice(i+1);}
  const base=composeArgs(values);
  const invoke=(args,timeout=10000)=>run(docker,args,{encoding:'utf8',windowsHide:true,timeout});
  const report=(status,name,detail)=>print(`  ${status} · ${name}: ${detail}`);
  print('\nSANWAN connectivity checks (read-only)');
  const engine=invoke(['version','--format','{{.Server.Version}}']);
  if(engine.status!==0){report('FAIL','Docker','Engine unavailable. Start Docker Desktop or Docker Engine, then run node setup.js.');return;}
  const idResult=invoke([...base,'ps','-q','sanwan']);
  const id=idResult.stdout?.trim();
  if(idResult.status!==0||!id){report('FAIL','Container','SANWAN is not running. Launch it through node setup.js.');return;}
  const deadline=now()+60000;
  let state;
  while(now()<deadline){
    const inspected=invoke(['inspect','--format','{{json .State}}',id],Math.max(1,Math.min(5000,deadline-now())));
    try {state=inspected.status===0?JSON.parse(inspected.stdout):undefined;}catch{state=undefined;}
    if(!state?.Running){report('FAIL','Container','Container is stopped or inaccessible. Check Docker logs and launch through node setup.js.');return;}
    if(!state.Health||state.Health.Status==='healthy')break;
    await sleep(Math.min(2000,Math.max(0,deadline-now())));
  }
  if(state?.Health?.Status!=='healthy')report('WARN','Container health','Healthcheck is not ready after the startup wait. Check startup logs.');
  else report('PASS','Container health','Container is running and healthy.');
  const projectResult=invoke(['inspect','--format','{{index .Config.Labels "com.docker.compose.project"}}',id]);
  const project=projectResult.stdout?.trim();
  if(projectResult.status!==0||!project){report('FAIL','Diagnostics','Cannot determine Compose project. Retry through node setup.js.');return;}
  const workers=invoke(['ps','-a','--filter','label=com.docker.compose.project='+project,'--filter','label=com.docker.compose.service=worker','--format','{{.ID}}']);
  if(workers.status!==0){report('FAIL','Diagnostics','Cannot inspect the optional worker. Check Docker access.');return;}
  const args=[...base,'exec','-T','sanwan','node','dist/diagnostics.js'];
  if(workers.stdout?.trim()||values.DEPLOYMENTS_ENABLED==='true')args.push('--worker-enabled');
  const result=invoke(args,600000);
  let rows;
  try{rows=JSON.parse(result.stdout);}catch{}
  if(!Array.isArray(rows)||!rows.length){report('FAIL','Diagnostics','Checks are unavailable in this container. Rebuild and start through node setup.js.');return;}
  for(const row of rows){
    if(!['PASS','WARN','FAIL','SKIP'].includes(row.status)||typeof row.name!=='string'||typeof row.detail!=='string')continue;
    report(row.status,row.name,row.detail);
  }
  print('  These checks do not send Discord messages, generate AI answers, or deploy services.');
}
module.exports={runSavedChecks};
