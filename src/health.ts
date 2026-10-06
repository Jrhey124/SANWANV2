import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const heartbeatPath=process.env.SANWAN_HEALTH_FILE??join(tmpdir(),'sanwan-health');
const maxAgeMs=60_000;

export function writeHeartbeat(path=heartbeatPath,now=Date.now()){
  writeFileSync(path,String(now),{mode:0o600});
}

export async function writeHeartbeatAfterReady(registerCommands:()=>Promise<unknown>,path=heartbeatPath,now=Date.now()){
  await registerCommands();
  writeHeartbeat(path,now);
}

export function clearHeartbeat(path=heartbeatPath){
  try{unlinkSync(path);}catch(error){if(!(error instanceof Error)||!('code' in error)||error.code!=='ENOENT')throw error;}
}

export function isHealthy(path=heartbeatPath,now=Date.now()){
  if(!existsSync(path))return false;
  const timestamp=Number(readFileSync(path,'utf8'));
  return Number.isFinite(timestamp)&&timestamp<=now&&now-timestamp<=maxAgeMs;
}

if(require.main===module)process.exit(isHealthy()?0:1);
