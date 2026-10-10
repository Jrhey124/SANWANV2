import type { APIEmbed } from 'discord.js';

export type Tone = 'info' | 'success' | 'warning' | 'error';
export const responseColors: Record<Tone, number> = { info: 0x5865f2, success: 0x2ecc71, warning: 0xf1c40f, error: 0xe74c3c };
const labels: Record<Tone, string> = { info: 'Information', success: 'Success', warning: 'Attention', error: 'Error' };
const titles: Record<string, string> = { ping: 'Connection check', help: 'Command guide', ci: 'GitHub Actions', deploy: 'Deployment', task: 'Tasks', note: 'Notes', schedule: 'Schedules', logs: 'Logs', errors: 'Error logs', status: 'System status', ask: 'AI assistant' };

export function shorten(text: string, max: number): string {
  const marker = '\n… (shortened)';
  if (text.length <= max) return text;
  let prefix = text.slice(0, max - marker.length - 4);
  if ((prefix.match(/```/g)?.length ?? 0) % 2) prefix += '\n```';
  return prefix + marker;
}

export function card(title: string, description = '', tone: Tone = 'info', fields: NonNullable<APIEmbed['fields']> = []) {
  // Stay below the 6,000-character total limit, including names and footer.
  const embed: APIEmbed = { title: shorten(title, 256), color: responseColors[tone], footer: { text: `SANWAN • ${labels[tone]}` } };
  if (description) embed.description = shorten(description, 3500);
  let remaining = 5800 - embed.title!.length - (embed.description?.length ?? 0) - embed.footer!.text.length;
  embed.fields = [];
  for (const field of fields.slice(0, 25)) {
    const name = shorten(field.name || 'Details', 256);
    if (remaining < name.length + 30) break;
    const value = shorten(field.value || '—', Math.min(1024, remaining - name.length));
    embed.fields.push({ ...field, name, value });
    remaining -= name.length + value.length;
  }
  if (embed.fields.length < fields.length) embed.footer!.text += ' • Additional details omitted';
  return { content: '', embeds: [embed], allowedMentions: { parse: [] as never[] } };
}

function messageTone(text: string): Tone {
  if (/^(You are not authorized|Only the server owner|This SANWAN installation|SANWAN (encountered|could not)|The release was not completed)/i.test(text)) return 'error';
  if (/^(No |Your inbox is empty|This (approval|deployment approval)|A different authorized|Repository is not|GitHub polling is|Deadline must|Provide at least|Enter at least|Use a schedule|Log source names|That model is not|Please wait|SANWAN is handling)/i.test(text) || /^Production .*approval request/i.test(text) || /^(Task|Note|Schedule) .*was not found\./i.test(text)) return 'warning';
  if (/^(Created|Updated|Removed|Saved|Added|Reminder sent|Simulation passed|Staging release is healthy|Active AI model set|Production .* is healthy)/i.test(text)) return 'success';
  return 'info';
}

export function withCard<T extends { content?: string; embeds?: APIEmbed[]; files?: unknown }>(command: string, input: T | string) {
  const options = typeof input === 'string' ? {} : input;
  if (typeof input !== 'string' && input.embeds) return { ...options, content: input.content ?? '', embeds: input.embeds };
  const text = typeof input === 'string' ? input : input.content ?? 'Your export is attached.';
  const tone = messageTone(text);
  const detail = /^(You are not authorized|Only the server owner)/i.test(text) ? `${text}\nAsk the server owner to grant an authorized role.` : text;
  return { ...options, ...card(titles[command] ?? 'Deployment approval', detail, tone) };
}

export function latencyLabel(latency: number) { return Number.isFinite(latency) && latency >= 0 ? `${latency} ms` : 'Not measured yet'; }
export function pingCard(latency: number) {
  return card('Connection check', 'Pong. SANWAN is responding.', 'success', [
    { name: 'Database', value: 'Ready', inline: true }, { name: 'Gateway latency', value: latencyLabel(latency), inline: true }
  ]);
}
export function helpCard() {
  return card('Command guide', 'Choose a command below. Discord shows its available options as you type.', 'info', [
    { name: 'Health & diagnostics', value: '`/ping` · `/status network` · `/status resources` · `/status disks`\n`/logs list` · `/logs show` · `/errors` — inspect operational logs.' },
    { name: 'GitHub & deployments', value: '`/ci status` — recent workflow runs.\n`/deploy simulate`, `release`, `status`, `start`, `stop`, `restart`, `rollback` — manage registered services.' },
    { name: 'Tasks & notes', value: '`/task create` · `/task list` · `/task update` · `/task describe` · `/task remove` · `/task bump`\n`/note add` · `/note list` · `/note search` · `/note remove` · `/note export` · `/note exportall` · `/note push` · `/note pop`' },
    { name: 'Schedules & AI', value: '`/schedule set` · `/schedule ontrigger` · `/schedule list` · `/schedule history` · `/schedule unset`\n`/ask question` · `/ask config` · `/ask models` · `/ask switch`' },
    { name: 'Access & approvals', value: 'Services must be registered by the host owner. Production releases and rollbacks require a different authorized approver. Restricted commands require the server owner or an authorized role.' }
  ]);
}

export function deploymentCard(action: string, service: string, environment: string, result: Record<string, unknown>) {
  const fields = [{ name: 'Service', value: service, inline: true }, { name: 'Environment', value: environment, inline: true }];
  for (const key of ['status', 'health', 'digest', 'active_digest', 'previous_digest', 'active_sha', 'previous_sha', 'image', 'planned_image', 'running']) {
    if (result[key] !== undefined && result[key] !== null) fields.push({ name: key.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase()), value: key === 'status' ? deploymentStatus(String(result[key])) : String(result[key]), inline: false });
  }
  const description = action === 'status' ? 'Current service details.' : action === 'simulate' ? 'Simulation passed. Compose security checks passed; no service was changed.' : `The ${action} operation completed.`;
  return card(`Deployment • ${action}`, description, action === 'status' ? 'info' : 'success', fields);
}

export function ciStatusCard(repository: string, runs: Array<{name:string;status:string;conclusion:string|null;head_branch:string;head_sha:string;html_url:string}>, activityStatus: string, activityFailed = false) {
  const fields = [
    {name:'Activity monitor',value:activityStatus},
    ...runs.map(run => ({
      name:run.name,
      value:`**${run.conclusion ?? run.status}**\nBranch: ${run.head_branch} · Commit: ${run.head_sha.slice(0,7)}\n[View workflow run](${run.html_url})`
    }))
  ];
  return card('GitHub Actions',runs.length ? repository : `No workflow runs found for ${repository}.`,activityFailed ? 'warning' : 'info',fields);
}

function deploymentStatus(status: string): string {
  if (!/^[\[{]/.test(status.trim())) return status;
  try {
    let containers: Array<{Name?: string; State?: string; Status?: string; Health?: string}>;
    try { const parsed = JSON.parse(status); containers = Array.isArray(parsed) ? parsed : [parsed]; }
    catch { containers = status.trim().split(/\r?\n/).map(line => JSON.parse(line)); }
    return containers.map(c => `${c.Name ?? 'Container'}: ${c.State ?? c.Status ?? 'unknown'}${c.Health ? ` • ${c.Health}` : ''}`).join('\n') || 'Stopped';
  } catch { return 'Container status could not be displayed. Check the worker logs.'; }
}
