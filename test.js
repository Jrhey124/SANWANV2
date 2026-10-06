const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isHealthy, writeHeartbeat, writeHeartbeatAfterReady, clearHeartbeat } = require('./dist/health.js');
const { classifyGitHubRunChange, hasConfiguredNotificationRoute } = require('./dist/github-events.js');
const { isDiscordId, validateComposeConfig } = require('./setup.js');
const { findDockerCommand } = require('./docker-cli.js');
const { guildCommandRoute } = require('./dist/discord-registration.js');
const { readContainerLimits } = require('./dist/resource-limits.js');

async function main(){
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sanwan-test-'));
try {
  const cgroupV2=path.join(temp,'cgroup-v2');fs.mkdirSync(cgroupV2);
  fs.writeFileSync(path.join(cgroupV2,'memory.max'),String(512*1024**2));
  fs.writeFileSync(path.join(cgroupV2,'memory.current'),String(128*1024**2));
  fs.writeFileSync(path.join(cgroupV2,'cpu.max'),'150000 100000');
  assert.deepEqual(readContainerLimits(cgroupV2),{memoryLimitBytes:512*1024**2,memoryUsageBytes:128*1024**2,cpuQuotaCores:1.5});
  const cgroupV1=path.join(temp,'cgroup-v1');fs.mkdirSync(path.join(cgroupV1,'memory'),{recursive:true});fs.mkdirSync(path.join(cgroupV1,'cpu'));
  fs.writeFileSync(path.join(cgroupV1,'memory/memory.limit_in_bytes'),String(1024*1024**2));
  fs.writeFileSync(path.join(cgroupV1,'memory/memory.usage_in_bytes'),String(256*1024**2));
  fs.writeFileSync(path.join(cgroupV1,'cpu/cpu.cfs_quota_us'),'50000');fs.writeFileSync(path.join(cgroupV1,'cpu/cpu.cfs_period_us'),'100000');
  assert.deepEqual(readContainerLimits(cgroupV1),{memoryLimitBytes:1024*1024**2,memoryUsageBytes:256*1024**2,cpuQuotaCores:0.5});
  console.log('PASS: resource status reads container limits from both cgroup v1 and v2.');
  const heartbeatPath=path.join(temp,'health');
  assert.equal(isHealthy(heartbeatPath),false,'missing Discord readiness heartbeat must be unhealthy');
  writeHeartbeat(heartbeatPath,1_000);
  assert.equal(isHealthy(heartbeatPath,60_000),true,'fresh Discord readiness heartbeat must be healthy');
  assert.equal(isHealthy(heartbeatPath,61_001),false,'stale Discord readiness heartbeat must be unhealthy');
  writeHeartbeat(heartbeatPath,70_000);
  assert.equal(isHealthy(heartbeatPath,69_999),false,'future-dated heartbeat must be unhealthy');
  clearHeartbeat(heartbeatPath);
  assert.equal(isHealthy(heartbeatPath),false,'shutdown must clear readiness heartbeat');
  const registrationHeartbeat=path.join(temp,'registration-health');
  await assert.rejects(writeHeartbeatAfterReady(async()=>{throw new Error('registration failed');},registrationHeartbeat,10_000),/registration failed/);
  assert.equal(isHealthy(registrationHeartbeat,10_000),false,'failed guild command registration must not mark the bot healthy');
  await writeHeartbeatAfterReady(async()=>{},registrationHeartbeat,10_000);
  assert.equal(isHealthy(registrationHeartbeat,10_000),true,'successful guild command registration must mark the bot healthy');
  console.log('PASS: container readiness reflects fresh Discord heartbeats and expires after disconnect.');
  assert.equal(isDiscordId('12345678901234567'),true,'17-digit Discord IDs must be accepted');
  assert.equal(isDiscordId('12345678901234567890'),true,'20-digit Discord IDs must be accepted');
  assert.equal(isDiscordId('1234567890123456'),false,'short IDs must be rejected');
  assert.equal(isDiscordId('1234567890123456x'),false,'non-numeric IDs must be rejected');
  console.log('PASS: setup accepts only Discord snowflake IDs of 17–20 digits.');
  const setupTestDir=path.join(temp,'setup');fs.mkdirSync(setupTestDir);
  const savedEnv='DISCORD_TOKEN=preserved-existing-value\n';
  fs.writeFileSync(path.join(setupTestDir,'.env'),savedEnv,{mode:0o600});
  const mockCompose=(status)=> (command,args,options)=>{
    assert.equal(command,'fake-docker');
    assert.deepEqual(args,['compose','-f','docker-compose.yml','--env-file',args[args.indexOf('--env-file')+1],'config','--quiet']);
    const temporaryEnv=args[args.indexOf('--env-file')+1];
    assert.equal(options.env.SANWAN_ENV_FILE,temporaryEnv);
    const tempPath=path.join(options.cwd,temporaryEnv);
    assert.match(fs.readFileSync(tempPath,'utf8'),/DISCORD_TOKEN=temporary-secret/);
    if(process.platform!=='win32') assert.equal(fs.statSync(tempPath).mode&0o777,0o600,'temporary credentials must be owner-only');
    return {status,stdout:'',stderr:''};
  };
  assert.equal(validateComposeConfig('fake-docker',['compose','-f','docker-compose.yml'],'DISCORD_TOKEN=temporary-secret\n',{cwd:setupTestDir,run:mockCompose(0)}),true);
  assert.deepEqual(fs.readdirSync(setupTestDir),['.env'],'successful validation removes the temporary credential file');
  assert.equal(fs.readFileSync(path.join(setupTestDir,'.env'),'utf8'),savedEnv,'successful validation does not rewrite an existing .env');
  assert.throws(()=>validateComposeConfig('fake-docker',['compose','-f','docker-compose.yml'],'DISCORD_TOKEN=temporary-secret\n',{cwd:setupTestDir,run:mockCompose(1)}),/existing \.env was left unchanged/);
  assert.deepEqual(fs.readdirSync(setupTestDir),['.env'],'failed validation removes the temporary credential file');
  assert.equal(fs.readFileSync(path.join(setupTestDir,'.env'),'utf8'),savedEnv,'failed validation preserves an existing .env');
  console.log('PASS: Compose validation protects existing credentials and removes its private temporary env file.');
  assert.equal(findDockerCommand('linux',{},()=>false),'docker');
  const windowsDockerPath='C:\\Users\\tester\\AppData\\Local\\Programs\\DockerDesktop\\resources\\bin\\docker.exe';
  assert.equal(findDockerCommand('win32',{LOCALAPPDATA:'C:\\Users\\tester\\AppData\\Local'},candidate=>candidate===windowsDockerPath),windowsDockerPath);
  const programFilesDockerPath='C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe';
  assert.equal(findDockerCommand('win32',{LOCALAPPDATA:'C:\\missing',ProgramFiles:'C:\\Program Files'},candidate=>candidate===programFilesDockerPath),programFilesDockerPath);
  assert.equal(findDockerCommand('win32',{},()=>false),'docker.exe','Windows PATH lookup must remain available as fallback');
  console.log('PASS: setup and uninstall share Docker CLI discovery for Linux and Docker Desktop on Windows.');
  assert.equal(guildCommandRoute('12345678901234567','98765432109876543'),'/applications/12345678901234567/guilds/98765432109876543/commands');
  assert.throws(()=>guildCommandRoute('invalid','98765432109876543'),/DISCORD_APPLICATION_ID/);
  assert.throws(()=>guildCommandRoute('12345678901234567','invalid'),/DISCORD_GUILD_ID/);
  console.log('PASS: Discord slash command registration targets only the configured guild and validates both IDs.');

  const run={id:7,name:'CI',status:'completed',conclusion:'success',head_branch:'main',head_sha:'1234567890abcdef',html_url:'https://github.com/example/repo/actions/runs/7',head_repository:{full_name:'example/repo'}};
  assert.equal(classifyGitHubRunChange(false,undefined,run),undefined,'initial repository baseline must not emit events');
  assert.equal(classifyGitHubRunChange(true,{status:'completed',conclusion:'success'},run),undefined,'unchanged workflow runs must not emit duplicate events');
  const running=classifyGitHubRunChange(true,{status:'queued',conclusion:null},{...run,status:'in_progress',conclusion:null});
  assert.equal(running.trigger,undefined,'in-progress updates must not fire completion triggers');
  assert.equal(classifyGitHubRunChange(true,{status:'in_progress',conclusion:null},run).trigger,'github.run.completed');
  assert.equal(classifyGitHubRunChange(true,{status:'in_progress',conclusion:null},{...run,conclusion:'failure'}).trigger,'github.run.unsuccessful');
  assert.equal(hasConfiguredNotificationRoute('github.run.completed',['notify.github'],true,false),true);
  assert.equal(hasConfiguredNotificationRoute('github.run.completed',['notify.github'],false,true),false,'success routes require the GitHub channel');
  assert.equal(hasConfiguredNotificationRoute('github.run.unsuccessful',['notify.error'],false,true),true);
  assert.equal(hasConfiguredNotificationRoute('github.run.unsuccessful',['notify.error'],true,false),false,'failure routes require the error channel');
  console.log('PASS: GitHub run transitions fire only once at completion and require their configured notification channel.');

  const appRun = spawnSync(process.execPath, ['dist/index.js'], {
    cwd: process.cwd(),
    env: { ...process.env, SQLITE_KEY: 'a'.repeat(64), DATA_DIR: path.join(temp, 'db'), LOG_DIR: path.join(temp, 'logs'), DISCORD_TOKEN: '' },
    encoding: 'utf8'
  });
  assert.equal(appRun.status, 0, appRun.stderr);
  assert.match(appRun.stdout, /setup mode ready/);
  const dbPath = path.join(temp, 'db', 'sanwan.db');
  assert.ok(fs.existsSync(dbPath));
  assert.notEqual(fs.readFileSync(dbPath).subarray(0, 16).toString('utf8'), 'SQLite format 3\0', 'database must be encrypted at rest');

  const Database = require('better-sqlite3-multiple-ciphers');
  const db = new Database(dbPath);
  db.pragma("cipher='sqlcipher'");
  db.key(Buffer.from('a'.repeat(64), 'utf8'));
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x => x.name);
  for (const name of ['task','note','inbox','schedule','schedule_history','github_run','pending_deployment','staging_deployment','event']) {
    assert.ok(tables.includes(name), `missing persistent ${name} table`);
  }
  assert.equal(Number(db.prepare("INSERT INTO task(title,assignee,deadline) VALUES('test task','owner','2026-12-31')").run().lastInsertRowid), 1);
  assert.equal(Number(db.prepare("INSERT INTO note(title,body) VALUES('test note','private text')").run().lastInsertRowid), 1);
  db.close();

  const wrongKey = spawnSync(process.execPath, ['dist/index.js'], {
    cwd: process.cwd(),
    env: { ...process.env, SQLITE_KEY: 'wrong-key'.repeat(8), DATA_DIR: path.join(temp, 'db'), LOG_DIR: path.join(temp, 'logs'), DISCORD_TOKEN: '' },
    encoding: 'utf8'
  });
  assert.notEqual(wrongKey.status, 0, 'wrong encryption key must fail to open the database');

  const legacyDir=path.join(temp,'legacy');
  const legacyDbDir=path.join(legacyDir,'db');
  fs.mkdirSync(legacyDbDir,{recursive:true});
  const legacyDb=new Database(path.join(legacyDbDir,'sanwan.db'));
  legacyDb.pragma("cipher='sqlcipher'");
  legacyDb.key(Buffer.from('a'.repeat(64),'utf8'));
  legacyDb.exec('CREATE TABLE schedule (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, interval_seconds INTEGER NOT NULL, action TEXT NOT NULL, next_run TEXT NOT NULL, updated_at TEXT NOT NULL)');
  legacyDb.prepare('INSERT INTO schedule(name,interval_seconds,action,next_run,updated_at) VALUES(?,?,?,?,?)').run('legacy-poll',60,'github.poll',new Date(Date.now()+60_000).toISOString(),new Date().toISOString());
  legacyDb.close();
  const migrationRun=spawnSync(process.execPath,['dist/index.js'],{
    cwd:process.cwd(),
    env:{...process.env,SQLITE_KEY:'a'.repeat(64),DATA_DIR:legacyDbDir,LOG_DIR:path.join(legacyDir,'logs'),DISCORD_TOKEN:''},
    encoding:'utf8'
  });
  assert.equal(migrationRun.status,0,migrationRun.stderr);
  const migratedDb=new Database(path.join(legacyDbDir,'sanwan.db'));
  migratedDb.pragma("cipher='sqlcipher'");
  migratedDb.key(Buffer.from('a'.repeat(64),'utf8'));
  const scheduleColumns=migratedDb.pragma('table_info(schedule)').map(column=>column.name);
  assert.ok(scheduleColumns.includes('trigger'),'existing schedule table must migrate the event trigger column');
  assert.equal(migratedDb.prepare('SELECT trigger FROM schedule WHERE name=?').get('legacy-poll').trigger,'interval','existing schedules must remain interval schedules');
  migratedDb.prepare(`INSERT INTO schedule(name,interval_seconds,action,next_run,updated_at,trigger) VALUES(?,0,?,'',?,?)
    ON CONFLICT(name) DO UPDATE SET interval_seconds=0,action=excluded.action,next_run='',updated_at=excluded.updated_at,trigger=excluded.trigger`)
    .run('ci-failed','notify.error',new Date().toISOString(),'github.run.unsuccessful');
  const eventSchedule=migratedDb.prepare('SELECT interval_seconds,action,next_run,trigger FROM schedule WHERE name=?').get('ci-failed');
  assert.deepEqual(eventSchedule,{interval_seconds:0,action:'notify.error',next_run:'',trigger:'github.run.unsuccessful'});
  migratedDb.prepare("UPDATE schedule SET interval_seconds=?,action=?,next_run=?,updated_at=?,trigger='interval' WHERE name=?")
    .run(120,'github.poll',new Date(Date.now()+120_000).toISOString(),new Date().toISOString(),'ci-failed');
  assert.equal(migratedDb.prepare('SELECT trigger FROM schedule WHERE name=?').get('ci-failed').trigger,'interval','replacing a trigger schedule with a timer must restore interval mode');
  migratedDb.close();
  console.log('PASS: encrypted existing databases migrate schedules while preserving interval behavior.');

  const workerRoot = path.join(temp, 'worker');
  const servicesRoot = path.join(workerRoot, 'services');
  const serviceDirectory = path.join(servicesRoot, 'app');
  const stateDirectory = path.join(workerRoot, 'state');
  const tmpDirectory = path.join(workerRoot, 'tmp');
  fs.mkdirSync(serviceDirectory, { recursive: true });
  fs.mkdirSync(stateDirectory, { recursive: true });
  fs.mkdirSync(tmpDirectory, { recursive: true });
  fs.writeFileSync(path.join(serviceDirectory, 'compose.yml'), 'services: {}\n');
  const serviceConfig = { services: { app: {
    github_repository: 'owner/repository', workflow_name: 'Build and publish image',
    staging_branch: 'develop', production_branch: 'main', image_repository: 'example.com/owner/app',
    environments: {
      staging: { compose_project: 'app-staging', compose_file: 'app/compose.yml', compose_service: 'app', health_timeout_seconds: 10 },
      production: { compose_project: 'app-production', compose_file: 'app/compose.yml', compose_service: 'app' }
    }
  } } };
  const configPath = path.join(workerRoot, 'services.json');
  fs.writeFileSync(configPath, JSON.stringify(serviceConfig));
  const fakeDocker = path.join(workerRoot, 'fake-docker.cjs');
  fs.writeFileSync(fakeDocker, `
    const a=process.argv.slice(2); const out=x=>process.stdout.write(x);
    if(a[0]==='info') out(process.env.FAKE_DOCKER_ROOTFUL==='1'?'[]':'["name=rootless"]');
    else if(a.includes('config')) {
      const service={healthcheck:{test:['CMD','true']}};
      if(process.env.FAKE_DOCKER_UNSAFE==='1') service.volumes=[{type:'bind'}];
      if(process.env.FAKE_DOCKER_INDIRECT==='1') service.volumes_from=['host-container:/'];
      if(process.env.FAKE_DOCKER_TRAVERSAL==='1') service.volumes=[{type:'volume',source:'../../host-path'}];
      out(JSON.stringify({services:{app:service}}));
    }
    else if(a[0]==='image'&&a[1]==='inspect') {
      const image=a.at(-1); const sha=image.includes(':sha-')?image.split(':sha-')[1]:(process.env.FAKE_DOCKER_EXPECTED_SHA||'a'.repeat(40));
      const hex=(sha[0]||'a').repeat(64); const label=process.env.FAKE_DOCKER_BAD_REVISION==='1'?'f'.repeat(40):sha;
      out(JSON.stringify(['example.com/owner/app@sha256:'+hex])+'|'+label);
    } else if(a[0]==='compose'&&a.includes('up')) {
      const fs=require('node:fs'); const override=a[a.indexOf('-f',a.indexOf('-f')+1)+1];
      if(override&&fs.existsSync(override)) fs.writeFileSync(process.env.FAKE_DOCKER_ACTIVE_FILE,JSON.parse(fs.readFileSync(override,'utf8')).services.app.image);
    } else if(a.includes('-q')) out('abcdef0123456789abcdef0123456789');
    else if(a[0]==='inspect') {const active=require('node:fs').readFileSync(process.env.FAKE_DOCKER_ACTIVE_FILE,'utf8');out('running|'+(active===process.env.FAKE_DOCKER_UNHEALTHY_DIGEST?'unhealthy':'healthy'));}
  `);
  const workerEnv = {
    ...process.env,
    SERVICES_CONFIG: configPath,
    SERVICES_ROOT: servicesRoot,
    WORKER_STATE_DIR: stateDirectory,
    WORKER_TMP_DIR: tmpDirectory,
    WORKER_TOKEN: 'c'.repeat(64),
    DOCKER_CLI: process.execPath,
    DOCKER_CLI_ARGS: JSON.stringify([fakeDocker]),
    DOCKER_HOST: 'unix:///test',
    FAKE_DOCKER_EXPECTED_SHA: 'a'.repeat(40)
  };
  workerEnv.FAKE_DOCKER_ACTIVE_FILE=path.join(workerRoot,'active-digest');
  const workerCode = `
    const assert=require('node:assert/strict'); const fs=require('node:fs');
    const {handle,server}=require('./dist/worker.js');
    (async()=>{
      await assert.rejects(handle({operation:'status',service:'missing',environment:'staging'}),/Unknown locally registered service/);
      const sim=await handle({operation:'simulate',service:'app',environment:'staging',sha:'a'.repeat(40)});
      assert.equal(sim.changed,false);
      assert.equal(sim.planned_image,'example.com/owner/app:sha-'+'a'.repeat(40));
      assert.equal(fs.readdirSync(process.env.WORKER_TMP_DIR).some(name=>name.startsWith('sanwan-docker-config')),false,'simulation removes its temporary Docker credential directory');
      const status=await handle({operation:'status',service:'app',environment:'staging'});
      assert.equal(status.status,'stopped');
      assert.equal(fs.readdirSync(process.env.WORKER_TMP_DIR).some(name=>name.startsWith('sanwan-docker-config')),false,'status removes its temporary Docker credential directory');
      const prepared=await handle({operation:'prepare',service:'app',environment:'production',sha:'a'.repeat(40)});
      assert.ok(prepared.digest.startsWith('example.com/owner/app@sha256:'));
      assert.ok(prepared.digest.endsWith('a'.repeat(64)));
      await handle({operation:'deploy',service:'app',environment:'staging',sha:'a'.repeat(40),digest:prepared.digest});
      await assert.rejects(handle({operation:'deploy',service:'app',environment:'staging',sha:'c'.repeat(40),digest:prepared.digest}),/revision/);
      await handle({operation:'deploy',service:'app',environment:'staging',sha:'b'.repeat(40)});
      await assert.rejects(handle({operation:'rollback',service:'app',environment:'staging',expected_digest:'f'.repeat(64)}),/changed since approval/);
      const rollback=await handle({operation:'rollback',service:'app',environment:'staging',expected_digest:prepared.digest});
      assert.equal(rollback.digest,prepared.digest);
      await handle({operation:'deploy',service:'app',environment:'staging',sha:'b'.repeat(40)});
      process.env.FAKE_DOCKER_UNHEALTHY_DIGEST=prepared.digest;
      await assert.rejects(handle({operation:'rollback',service:'app',environment:'staging',expected_digest:prepared.digest}),/Rollback failed; current release restored/);
      delete process.env.FAKE_DOCKER_UNHEALTHY_DIGEST;
      const recovered=await handle({operation:'status',service:'app',environment:'staging'});
      assert.ok(recovered.active_digest.endsWith('b'.repeat(64)),'failed rollback keeps the current release recorded as active');
      assert.equal(fs.readFileSync(process.env.FAKE_DOCKER_ACTIVE_FILE,'utf8'),recovered.active_digest,'failed rollback restores the running current release');
      await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
      const response=await fetch('http://127.0.0.1:'+server.address().port+'/v1/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({operation:'status',service:'app',environment:'staging'})});
      assert.equal(response.status,401);
      await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
      console.log('PASS: worker authenticates requests, pins approval digests, deploys healthy releases, and restores the active release when rollback fails health checks.');
    })().catch(e=>{console.error(e);process.exitCode=1;server.close();});
  `;
  const runWorkerTest = (env, code = workerCode) => spawnSync(process.execPath, ['-e', code], { cwd: process.cwd(), env, encoding: 'utf8' });
  const workerRun = runWorkerTest(workerEnv);
  assert.equal(workerRun.status, 0, workerRun.stderr);
  process.stdout.write(workerRun.stdout);

  const corruptState = runWorkerTest({ ...workerEnv, WORKER_STATE_DIR: path.join(workerRoot, 'corrupt-state') }, `
    const assert=require('node:assert/strict'); const fs=require('node:fs');
    fs.mkdirSync(process.env.WORKER_STATE_DIR,{recursive:true}); fs.writeFileSync(process.env.WORKER_STATE_DIR+'/releases.json','{broken');
    const {handle}=require('./dist/worker.js');
    handle({operation:'simulate',service:'app',environment:'staging'}).then(()=>{throw Error('corrupt state was accepted')}).catch(e=>{assert.match(e.message,/Persistent deployment state is invalid/);console.log('PASS: worker refuses release changes when durable state is corrupt.');});
  `);
  assert.equal(corruptState.status, 0, corruptState.stderr); process.stdout.write(corruptState.stdout);

  const unsafe = runWorkerTest({ ...workerEnv, WORKER_STATE_DIR: path.join(workerRoot, 'unsafe-state'), FAKE_DOCKER_UNSAFE: '1' }, `
    const assert=require('node:assert/strict'); const {handle}=require('./dist/worker.js');
    handle({operation:'simulate',service:'app',environment:'staging'}).then(()=>{throw Error('unsafe bind mount was accepted')}).catch(e=>{assert.match(e.message,/bind mounts and host paths are prohibited/);console.log('PASS: worker refuses host bind mounts.');});
  `);
  assert.equal(unsafe.status, 0, unsafe.stderr); process.stdout.write(unsafe.stdout);

  for (const [flag, message, expected] of [
    ['FAKE_DOCKER_INDIRECT', 'indirect mounts', /indirect mount/],
    ['FAKE_DOCKER_TRAVERSAL', 'volume path traversal', /Only named volumes/]
  ]) {
    const run = runWorkerTest({ ...workerEnv, WORKER_STATE_DIR: path.join(workerRoot, flag), [flag]: '1' }, `
      const assert=require('node:assert/strict'); const {handle}=require('./dist/worker.js');
      handle({operation:'simulate',service:'app',environment:'staging'}).then(()=>{throw Error('unsafe Compose setting was accepted')}).catch(e=>{assert.ok(e.message.includes(${JSON.stringify(expected.source)}),e.message);console.log('PASS: worker refuses ${message}.');});
    `);
    assert.equal(run.status, 0, run.stderr); process.stdout.write(run.stdout);
  }

  const rootful = runWorkerTest({ ...workerEnv, WORKER_STATE_DIR: path.join(workerRoot, 'rootful-state'), FAKE_DOCKER_ROOTFUL: '1', ALLOW_ROOTFUL_DOCKER:'true' }, `
    const assert=require('node:assert/strict'); const {handle}=require('./dist/worker.js');
    handle({operation:'simulate',service:'app',environment:'staging'}).then(()=>{throw Error('rootful daemon was accepted')}).catch(e=>{assert.match(e.message,/not rootless/);console.log('PASS: worker refuses all operations on a rootful Docker daemon, even with the former override set.');});
  `);
  assert.equal(rootful.status, 0, rootful.stderr); process.stdout.write(rootful.stdout);

  const rootfulStartup=spawnSync(process.execPath,['dist/worker.js'],{
    cwd:process.cwd(),
    env:{...workerEnv,WORKER_STATE_DIR:path.join(workerRoot,'rootful-startup-state'),FAKE_DOCKER_ROOTFUL:'1',ALLOW_ROOTFUL_DOCKER:'true',WORKER_PORT:'0'},
    encoding:'utf8',timeout:5000
  });
  assert.equal(rootfulStartup.status,1,rootfulStartup.stderr);
  assert.match(rootfulStartup.stderr,/Worker startup refused:.*not rootless/);
  console.log('PASS: worker startup refuses a rootful daemon before opening its HTTP API.');

  const badRevision = runWorkerTest({ ...workerEnv, WORKER_STATE_DIR: path.join(workerRoot, 'bad-revision-state'), FAKE_DOCKER_BAD_REVISION: '1' }, `
    const assert=require('node:assert/strict'); const {handle}=require('./dist/worker.js');
    handle({operation:'deploy',service:'app',environment:'staging',sha:'d'.repeat(40)}).then(()=>{throw Error('mismatched revision was accepted')}).catch(e=>{assert.match(e.message,/revision label/);console.log('PASS: worker rejects images whose revision label differs from the requested SHA.');});
  `);
  assert.equal(badRevision.status, 0, badRevision.stderr); process.stdout.write(badRevision.stdout);

  console.log('PASS: bot initializes encrypted storage and rejects an incorrect database key.');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
}

main().catch(error=>{console.error(error);process.exitCode=1;});
