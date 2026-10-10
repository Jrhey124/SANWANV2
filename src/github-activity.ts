import type Database from 'better-sqlite3';

export type RepositoryEvent = {
  id: string; type: string; created_at: string;
  actor?: { login?: string };
  payload?: { ref?: string; ref_type?: string; head?: string; before?: string };
};
export type ActivityPollResult =
  | {status:'checked'|'baseline'}
  | {status:'already-checking'}
  | {status:'waiting'; nextPollAt:number};
const inFlight = new Set<string>();

export function activityMessage(repository: string, event: RepositoryEvent): string | undefined {
  const payload = event.payload;
  const actor = event.actor?.login ?? 'Unknown user';
  const root = `https://github.com/${repository}`;
  if (event.type === 'PushEvent' && payload?.ref?.startsWith('refs/heads/')) {
    const branch = payload.ref.slice('refs/heads/'.length);
    const sha = payload.head;
    if (!sha || !/^[a-f0-9]{40}$/i.test(sha) || /^0+$/.test(sha)) return undefined;
    return `GitHub push · **${repository}** · ${actor} pushed to **${branch}** · ${sha.slice(0,7)} · ${root}/commit/${sha}`;
  }
  if ((event.type === 'CreateEvent' || event.type === 'DeleteEvent') && payload?.ref_type === 'branch' && payload.ref) {
    const created = event.type === 'CreateEvent';
    return `GitHub branch ${created ? 'created' : 'deleted'} · **${repository}** · ${actor} ${created ? 'created' : 'deleted'} **${payload.ref}** · ${created ? `${root}/tree/${encodeURIComponent(payload.ref)}` : root}`;
  }
  return undefined;
}

export function initializeActivityStorage(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS github_activity_seen (
    repository TEXT NOT NULL, event_id TEXT NOT NULL, PRIMARY KEY(repository,event_id));
    CREATE TABLE IF NOT EXISTS github_activity_baseline (repository TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS github_activity_poll (repository TEXT PRIMARY KEY, next_poll INTEGER NOT NULL);`);
}

export async function pollRepositoryActivity(db: Database.Database, repository: string, token: string,
  notify: (message: string) => Promise<boolean>, request: typeof fetch = fetch, now: () => number = Date.now): Promise<ActivityPollResult> {
  const repo = repository.toLowerCase();
  if (inFlight.has(repo)) return {status:'already-checking'};
  const pollState = db.prepare('SELECT next_poll FROM github_activity_poll WHERE repository=?').get(repo) as {next_poll:number}|undefined;
  if (pollState && pollState.next_poll > now()) return {status:'waiting',nextPollAt:pollState.next_poll};
  inFlight.add(repo);
  try {
    const ready = Boolean(db.prepare('SELECT repository FROM github_activity_baseline WHERE repository=?').get(repo));
    const seen = db.prepare('SELECT event_id FROM github_activity_seen WHERE repository=? AND event_id=?');
    const events: RepositoryEvent[] = [];
    // GitHub exposes at most 300 recent events; fetch all pages before changing the baseline.
    for (let page=1; page<=3; page++) {
      const response = await request(`https://api.github.com/repos/${repository}/events?per_page=100&page=${page}`, {
        headers: {Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'},
        signal: AbortSignal.timeout(10000)
      });
      const interval = Number(response.headers.get('X-Poll-Interval') ?? 60);
      const retry = Number(response.headers.get('Retry-After') ?? 0);
      const wait = Math.max(60, Number.isFinite(interval) ? interval : 60, Number.isFinite(retry) ? retry : 0);
      db.prepare('INSERT INTO github_activity_poll(repository,next_poll) VALUES(?,?) ON CONFLICT(repository) DO UPDATE SET next_poll=MAX(next_poll,excluded.next_poll)').run(repo,now()+wait*1000);
      if (!response.ok) throw new Error(`GitHub activity request failed for ${repository} (HTTP ${response.status}).`);
      const batch = await response.json() as RepositoryEvent[];
      if (!Array.isArray(batch) || batch.some(event => typeof event.id !== 'string' || typeof event.type !== 'string')) {
        throw new Error(`GitHub activity response was invalid for ${repository}.`);
      }
      events.push(...batch);
      if (batch.length < 100) break;
    }
    const record = db.prepare('INSERT OR IGNORE INTO github_activity_seen(repository,event_id) VALUES(?,?)');
    for (const event of events.reverse()) {
      if (seen.get(repo,event.id)) continue;
      const message = activityMessage(repository,event);
      if (ready && message && !await notify(message)) continue;
      record.run(repo,event.id);
    }
    db.prepare('INSERT OR IGNORE INTO github_activity_baseline(repository) VALUES(?)').run(repo);
    return {status:ready?'checked':'baseline'};
  } finally {
    inFlight.delete(repo);
  }
}

export function activityPollLabel(result: ActivityPollResult, notificationChannelAvailable = true): string {
  switch (result.status) {
    case 'checked': return notificationChannelAvailable ? 'Checked for new pushes and branch changes.' : 'Checked; GitHub notification channel is not configured.';
    case 'baseline': return 'Initial baseline saved; existing activity was not announced.';
    case 'already-checking': return 'A poll for this repository is already in progress.';
    case 'waiting': return `GitHub polling interval has not elapsed; try again <t:${Math.ceil(result.nextPollAt/1000)}:R>.`;
  }
}
