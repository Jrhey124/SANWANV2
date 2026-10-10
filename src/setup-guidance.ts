import { card, withCard } from './responses.js';

export type SetupArea = 'ask' | 'ci' | 'deploy' | 'schedule' | 'task';

export class SetupGuidanceError extends Error {
  constructor(
    readonly area: SetupArea,
    message: string,
    readonly settings: string[],
    readonly location: '.env' | 'config/services.json' = '.env',
    readonly extraSteps: string[] = []
  ) {
    super(message);
    this.name = 'SetupGuidanceError';
  }
}

const labels: Record<SetupArea, string> = {
  ask: 'AI assistant setup', ci: 'GitHub monitoring setup', deploy: 'Deployment setup',
  schedule: 'Schedule setup', task: 'Task notifications'
};

export function setupGuidanceCard(error: SetupGuidanceError) {
  const steps = [
    `Add or correct ${error.settings.map(setting => `\`${setting}\``).join(', ')} in \`${error.location}\`.`,
    ...error.extraSteps,
    ...(error.area === 'ask' ? ['Add `ASK_API_KEY` only if your provider requires authentication; Ollama can run without a key.'] : []),
    'Rebuild and restart SANWAN with `docker compose up -d --build`.'
  ];
  return card(labels[error.area], error.message, 'warning', [
    { name: 'What to configure', value: steps.join('\n') }
  ]);
}

/** Convert known worker-side setup omissions to safe, actionable guidance. */
export function workerSetupGuidance(message: string): SetupGuidanceError | undefined {
  if (/daemon is not rootless|rootless Docker/i.test(message)) {
    return new SetupGuidanceError('deploy', 'The deployment worker needs a rootless Linux Docker daemon.', ['DOCKER_SOCKET_PATH', 'DOCKER_SOCKET_GID', 'WORKER_TOKEN'], '.env', [
      'Start rootless Docker, then enable the deployment profile with `docker compose -f docker-compose.yml -f docker-compose.worker.yml --profile deployment up -d --build`.'
    ]);
  }
  if (/unknown locally registered service|registered compose service .* is missing/i.test(message)) {
    return new SetupGuidanceError('deploy', 'This service is not fully registered with the deployment worker.', ['service definition and Compose mappings'], 'config/services.json', [
      'Register the service and place its Compose file under `services/`.'
    ]);
  }
  if (/GHCR_USERNAME is required|GHCR login failed/i.test(message)) {
    return new SetupGuidanceError('deploy', 'Private GHCR images need a read-only package credential.', ['GHCR_USERNAME', 'GHCR_TOKEN'], '.env', [
      'Use a token with read-only package access.'
    ]);
  }
  if (/ghcr\.io.*(pull access denied|unauthorized|authentication required)|(?:pull access denied|unauthorized|authentication required).*ghcr\.io/i.test(message)) {
    return new SetupGuidanceError('deploy', 'The worker cannot pull this private GitHub Container Registry image.', ['GHCR_USERNAME', 'GHCR_TOKEN'], '.env', [
      'Use a token with read-only package access, then restart the deployment profile.'
    ]);
  }
  return undefined;
}

export function commandErrorCard(command: string, error: unknown, genericMessage = 'SANWAN could not complete that request. Check the redacted logs.') {
  if (error instanceof SetupGuidanceError) return setupGuidanceCard(error);
  return withCard(command, genericMessage);
}
