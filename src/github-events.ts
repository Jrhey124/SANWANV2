export type GitHubTriggerName='github.run.completed'|'github.run.unsuccessful';
export type GitHubRunState={status:string;conclusion:string|null};
export type GitHubRunEvent={id:number;name:string;status:string;conclusion:string|null;head_branch:string;head_sha:string;html_url:string;head_repository?:{full_name:string}|null};

export function classifyGitHubRunChange(baselineReady:boolean,previous:GitHubRunState|undefined,run:GitHubRunEvent){
  if(!baselineReady||(previous&&previous.status===run.status&&previous.conclusion===run.conclusion))return undefined;
  const message=`GitHub update · **${run.head_repository?.full_name??''}** · ${run.name} · ${run.status}${run.conclusion?` / ${run.conclusion}`:''} · ${run.head_branch} @ ${run.head_sha.slice(0,7)} · ${run.html_url}`;
  const completedTransition=run.status==='completed'&&previous?.status!=='completed';
  const trigger:GitHubTriggerName|undefined=completedTransition?(run.conclusion==='success'?'github.run.completed':'github.run.unsuccessful'):undefined;
  return {message,trigger};
}

export function hasConfiguredNotificationRoute(trigger:GitHubTriggerName|undefined,actions:string[],githubChannel:boolean,errorChannel:boolean){
  if(!trigger)return false;
  return actions.some(action=>action==='notify.github'?githubChannel:action==='notify.error'&&errorChannel);
}
