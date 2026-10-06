import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type ContainerLimits={memoryLimitBytes?:number;memoryUsageBytes?:number;cpuQuotaCores?:number};

function readNumber(path:string):number|undefined{
  try{const value=Number(readFileSync(path,'utf8').trim());return Number.isFinite(value)&&value>0?value:undefined;}catch{return undefined;}
}

export function readContainerLimits(root='/sys/fs/cgroup'):ContainerLimits{
  const v2Memory=readFileSyncOptional(join(root,'memory.max'));
  const memoryLimitBytes=v2Memory!==undefined&&v2Memory!=='max'?readNumber(join(root,'memory.max')):readNumber(join(root,'memory/memory.limit_in_bytes'));
  const v2Usage=readNumber(join(root,'memory.current'));
  const memoryUsageBytes=v2Usage??readNumber(join(root,'memory/memory.usage_in_bytes'));
  const cpuMax=readFileSyncOptional(join(root,'cpu.max'));
  let cpuQuotaCores:number|undefined;
  if(cpuMax){
    const [quota,period]=cpuMax.split(/\s+/).map(Number);
    if(Number.isFinite(quota)&&Number.isFinite(period)&&quota>0&&period>0)cpuQuotaCores=quota/period;
  }else{
    const quota=readNumber(join(root,'cpu/cpu.cfs_quota_us'));
    const period=readNumber(join(root,'cpu/cpu.cfs_period_us'));
    if(quota&&period)cpuQuotaCores=quota/period;
  }
  return {memoryLimitBytes,memoryUsageBytes,cpuQuotaCores};
}

function readFileSyncOptional(path:string):string|undefined{try{return readFileSync(path,'utf8').trim();}catch{return undefined;}}
