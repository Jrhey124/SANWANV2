import type Database from 'better-sqlite3';
export type WorkflowRun={id:number;name:string;event:string;head_branch:string;head_sha:string;status:string;conclusion:string|null;run_number:number;head_repository?:{full_name:string}|null};
export type CandidateService={github_repository:string;workflow_name:string;staging_branch:string;production_branch:string};
export function newestSuccessful(runs:WorkflowRun[],service:CandidateService,environment:'staging'|'production') {
  const branch=environment==='staging'?service.staging_branch:service.production_branch;
  return runs.filter(r=>r.name===service.workflow_name&&r.event==='push'&&r.head_repository?.full_name.toLowerCase()===service.github_repository.toLowerCase()&&r.head_branch===branch&&r.status==='completed'&&r.conclusion==='success'&&Number.isSafeInteger(r.run_number)&&r.run_number>0).sort((a,b)=>b.run_number-a.run_number||b.id-a.id)[0];
}
// Persist the greatest successful run observed, including baseline runs. An older
// response can never lower this cursor, even after a restart or manual rollback.
export function candidateReady(db:Database.Database,service:string,environment:string,run:WorkflowRun,baseline:boolean,wasSuccessful:boolean,scope='') {
  db.exec('CREATE TABLE IF NOT EXISTS deployment_cursor(service TEXT NOT NULL,environment TEXT NOT NULL,run_number INTEGER NOT NULL,sha TEXT NOT NULL,eligible INTEGER NOT NULL,PRIMARY KEY(service,environment))');
  if(!(db.prepare('PRAGMA table_info(deployment_cursor)').all() as Array<{name:string}>).some(column=>column.name==='scope'))db.exec("ALTER TABLE deployment_cursor ADD COLUMN scope TEXT NOT NULL DEFAULT ''");
  let cursor=db.prepare('SELECT run_number,sha,eligible,scope FROM deployment_cursor WHERE service=? AND environment=?').get(service,environment) as {run_number:number;sha:string;eligible:number;scope:string}|undefined;
  if(cursor?.scope!==scope)cursor=undefined;
  if(cursor&&run.run_number<cursor.run_number)return false;
  if(cursor&&run.run_number===cursor.run_number)return cursor.sha===run.head_sha&&Boolean(cursor.eligible)&&baseline;
  const eligible=baseline&&!wasSuccessful;
  db.prepare('INSERT INTO deployment_cursor(service,environment,run_number,sha,eligible,scope) VALUES(?,?,?,?,?,?) ON CONFLICT(service,environment) DO UPDATE SET run_number=excluded.run_number,sha=excluded.sha,eligible=excluded.eligible,scope=excluded.scope').run(service,environment,run.run_number,run.head_sha,Number(eligible),scope);
  return eligible;
}
function releaseScope(service:CandidateService,environment:'staging'|'production'){
  return JSON.stringify([service.github_repository.toLowerCase(),service.workflow_name,environment==='staging'?service.staging_branch:service.production_branch]);
}
export function recordManualStaging(db:Database.Database,name:string,service:CandidateService,sha:string,runNumber:number){
  if(!Number.isSafeInteger(runNumber)||runNumber<1)throw new Error('Verified workflow run number is unavailable.');
  candidateReady(db,name,'staging',{id:0,name:service.workflow_name,event:'push',head_branch:service.staging_branch,head_sha:sha,status:'completed',conclusion:'success',run_number:runNumber},true,true,releaseScope(service,'staging'));
}

export type DeploymentNotice={kind:'healthy'|'failed';service:string;sha:string;detail:string};
export async function processDeploymentCandidates(db:Database.Database,services:Record<string,CandidateService>,runs:WorkflowRun[],baseline:boolean,successfulBefore:Set<number>,enabled:boolean,worker:(body:Record<string,unknown>)=>Promise<Record<string,unknown>>,verify:(service:CandidateService,sha:string)=>Promise<void>,notify:(notice:DeploymentNotice)=>Promise<void>){
  for(const [serviceName,service] of Object.entries(services)){
    const production=newestSuccessful(runs,service,'production');
    if(production&&candidateReady(db,serviceName,'production',production,baseline,successfulBefore.has(production.id),releaseScope(service,'production'))){
      const approvals=db.prepare("SELECT id,sha FROM pending_deployment WHERE service=? AND environment='production' AND operation='release' AND status='pending'").all(serviceName) as Array<{id:number;sha:string}>;
      if(approvals.some(a=>a.sha!==production.head_sha)){
        let current=false;try{await verify(service,production.head_sha);current=true;}catch{}
        if(current)for(const approval of approvals)if(approval.sha!==production.head_sha)db.prepare("UPDATE pending_deployment SET status='superseded' WHERE id=? AND status='pending'").run(approval.id);
      }
    }
    const run=newestSuccessful(runs,service,'staging');
    if(!run)continue;
    const prior=db.prepare('SELECT status,attempts FROM staging_deployment WHERE service=? AND sha=?').get(serviceName,run.head_sha) as {status:string;attempts:number}|undefined;
    const recordedAttempt=Boolean(prior&&prior.status!=='healthy');
    if(!candidateReady(db,serviceName,'staging',run,baseline,successfulBefore.has(run.id)&&!recordedAttempt,releaseScope(service,'staging'))||!enabled)continue;
    if(prior?.status==='healthy')continue;
    if(prior?.status==='deploying'){
      try{const current=await worker({operation:'status',service:serviceName,environment:'staging'});
        if(current.active_sha===run.head_sha){db.prepare("UPDATE staging_deployment SET status='healthy',detail='recovered from worker state',updated_at=? WHERE service=? AND sha=?").run(new Date().toISOString(),serviceName,run.head_sha);continue;}
      }catch{}
    }
    if(prior&&prior.attempts>=3)continue;
    if(prior)db.prepare("UPDATE staging_deployment SET status='deploying',attempts=attempts+1,updated_at=? WHERE service=? AND sha=?").run(new Date().toISOString(),serviceName,run.head_sha);
    else db.prepare("INSERT INTO staging_deployment(service,sha,status,detail,attempts) VALUES(?,?,'deploying','automatic successful CI deployment',1)").run(serviceName,run.head_sha);
    let notice:DeploymentNotice;
    try{
      const result=await worker({operation:'deploy',service:serviceName,environment:'staging',sha:run.head_sha});
      db.prepare("UPDATE staging_deployment SET status='healthy',detail=?,updated_at=? WHERE service=? AND sha=?").run(String(result.digest??'healthy'),new Date().toISOString(),serviceName,run.head_sha);
      notice={kind:'healthy',service:serviceName,sha:run.head_sha,detail:String(result.digest??'healthy')};
    }catch(error){
      const detail=error instanceof Error?error.message:'deployment failed';
      db.prepare("UPDATE staging_deployment SET status='failed',detail=?,updated_at=? WHERE service=? AND sha=?").run(detail.slice(0,500),new Date().toISOString(),serviceName,run.head_sha);
      notice={kind:'failed',service:serviceName,sha:run.head_sha,detail};
    }
    await notify(notice);
  }
}
