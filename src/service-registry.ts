import {existsSync,readFileSync} from 'node:fs';
import {SetupGuidanceError} from './setup-guidance';
export type EnvironmentName='staging'|'production';
export type ServiceSpec={github_repository:string;workflow_name:string;staging_branch:string;production_branch:string;image_repository:string;environments:Record<EnvironmentName,{compose_project:string;compose_file:string;compose_service:string;health_timeout_seconds?:number}>};
export type ServiceRegistry={services:Record<string,ServiceSpec>};
export function readServiceRegistry(servicesConfigPath:string):ServiceRegistry {
  if(!existsSync(servicesConfigPath)) return {services:{}};
  let source:string;
  try{source=readFileSync(servicesConfigPath,'utf8');}catch{throw new SetupGuidanceError('deploy','The service registry is unreadable by the container.',['container-readable registry'],'config/services.json',['Run node setup.js to repair registry permissions.']);}
  let data:ServiceRegistry;
  try { data=JSON.parse(source) as ServiceRegistry; }
  catch { throw new SetupGuidanceError('deploy', 'The local service registry could not be read as JSON.', ['valid services object'], 'config/services.json', ['Check the file syntax and keep each service definition under the top-level `services` key.']); }
  if(!data||!data.services||typeof data.services!=='object'||Array.isArray(data.services)) throw new SetupGuidanceError('deploy', 'The local service registry is missing its services object.', ['services object'], 'config/services.json');
  for(const service of Object.values(data.services)){
    if(!service||['github_repository','workflow_name','staging_branch','production_branch','image_repository'].some(key=>typeof (service as unknown as Record<string,unknown>)[key]!=='string'||!(service as unknown as Record<string,unknown>)[key]))throw new SetupGuidanceError('deploy','A registered service is incomplete.',['repository, workflow, branches and image'],'config/services.json');
    if(['staging','production'].some(environment=>{const mapping=service.environments?.[environment as EnvironmentName];return !mapping||['compose_file','compose_project','compose_service'].some(key=>typeof (mapping as unknown as Record<string,unknown>)[key]!=='string'||!(mapping as unknown as Record<string,unknown>)[key]);}))throw new SetupGuidanceError('deploy','A registered service lacks environment mappings.',['staging and production Compose mappings'],'config/services.json');
  }
  return data;
}

export function monitoringRegistry(file:string,onFailure:(error:unknown)=>void):ServiceRegistry {
  try{return readServiceRegistry(file);}catch(error){onFailure(error);return {services:{}};}
}
