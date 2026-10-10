# SANWAN

SANWAN is a self-hosted Discord bot for GitHub Actions monitoring and Docker Compose deployment. The bot uses Discord's outbound Gateway connection and polls GitHub over HTTPS, so it needs no public inbound endpoint.

## Run the bot

Prerequisites: Docker Engine with Compose v2, Node.js 22+ for setup, a Discord bot, and a configured GitHub token if using CI.

1. Invite the bot to your server using the `bot` and `applications.commands` OAuth scopes.
2. Run `node setup.js` in an interactive terminal on the host (PowerShell works with Docker Desktop). The four-step wizard asks for Discord credentials first, then lets you configure GitHub, AI, or advanced settings now or on a later run. It hides secret input, checks Docker and Compose, generates `SQLITE_KEY` and `WORKER_TOKEN`, and creates local config folders. At the end, accept the prompt to build and start SANWAN in Docker. If Docker Desktop is not running, setup still saves `.env` and shows the launch command.
3. If you skip the setup launch prompt, start it later with `docker compose up -d --build`, then try `/ping`.

Slash commands are registered to the configured Discord server on startup, so they become available there without waiting for global command propagation.

The bot container runs as an unprivileged user without a Docker socket, drops Linux capabilities, and has a read-only root filesystem. Its Docker healthcheck tracks a short-lived heartbeat written only while the Discord client is ready. Its encrypted SQLite database and logs use Docker-managed volumes. Setup gives `.env` owner-only permissions on Linux; keep it and backups protected.

## Configure and test GitHub monitoring

Run `node setup.js` and choose **2) GitHub monitoring** under optional features. Enter a GitHub token, a comma-separated repository allowlist such as `Jrhey124/Sanwan`, and the Discord channel ID for GitHub notifications. If a value is already configured, setup lets you keep or replace it. The token input is hidden.

SANWAN polls GitHub Actions workflow runs and repository activity for each allowed repository once per minute, respecting a longer activity polling interval if GitHub requests one. /ci status also refreshes activity for the selected repository before listing workflow runs. It reports workflow state changes, pushes to branches (even without workflows), and branch creation or deletion. Activity messages include the repository, actor, branch, and a relevant GitHub link; push messages also include the commit. Each repository's first successful activity poll establishes a saved baseline without announcing historical activity. Workflow monitoring also records its initial baseline silently. Saved event IDs prevent repeated activity notifications after restarts; failed channel delivery is retried while the event remains in GitHub's feed.

To test activity monitoring, finish setup and accept its build/start prompt. Run /ci status for the allowlisted repository to request an activity refresh, then push a new commit, create a branch, or delete a test branch and run /ci status again. The response says whether it checked, is already checking, or is waiting for GitHub's allowed polling interval. These notifications require the GitHub notification channel and the bot's permission to send messages there. No workflow is required. If no channel is configured, observed events are recorded silently and are not replayed when a channel is added later.

For workflow monitoring, enable GitHub Actions and trigger a new workflow run after SANWAN's baseline poll. `/ci status` shows recent workflow runs; **No workflow runs found** means GitHub returned no Actions runs, even if push or branch monitoring works. `/schedule ontrigger` continues to support workflow completion events, with notifications routed to the GitHub or error channel.

The fine-grained token must have access to the allowlisted repositories, with **Metadata: read** for activity and **Actions: read** for workflow runs. GitHub's [repository events API](https://docs.github.com/en/rest/activity/events#list-repository-events) can delay activity by 30 seconds to 6 hours and exposes at most 300 events from the past 30 days. SANWAN checks up to three pages of activity and the latest 10 workflow runs per repository. Activity outside that window can be missed during long downtime or heavy traffic. Tag events are not announced. Monitoring uses outbound HTTPS; no webhook endpoint is needed.

## Check setup connectivity

After setup builds and starts SANWAN, choose **Run checks** to run read-only diagnostics inside the bot container. To check again later, run `node setup.js` and choose **Check saved setup** when the existing configuration is detected. Checks-only mode does not rewrite configuration or generate new secrets. The checks use the running container's settings; rebuild through setup after changing configuration.

Results use **PASS**, **WARN**, **FAIL**, and **SKIP** with explanations and next steps. The checks cover Docker health and the Discord heartbeat, bot identity, server access, registered commands, notification-channel permissions, GitHub repository/workflow/activity access, the saved active AI model, and the enabled worker's health and service registry. Empty workflow or activity feeds count as successful access. Unconfigured optional integrations are skipped. Container startup waiting is limited to 60 seconds and network requests to 15 seconds each; failures do not undo setup or stop other checks.

These checks do not send Discord messages, create branches, generate AI responses, or deploy services. A listed AI model does not prove quota or billing availability. Permission checks do not prove message delivery, and a working activity endpoint does not prove that GitHub has published a particular event. Test those behaviors using normal Discord commands and a fresh repository event after the initial monitoring baseline.

## Configure services and deployments

The deployment worker is separate and stays off unless explicitly enabled. On the host, copy and edit `config/services.example.json` as `config/services.json`, copy `templates/service-compose.yml` into `services/<service>/`, and adapt it for your app. The Compose definitions must use published images, named volumes, and an image healthcheck. The worker rejects build contexts, bind mounts, privileged containers, host namespaces, devices, added capabilities, and unsafe security settings.

Copy `templates/service-workflow.yml` to the target application's `.github/workflows/`. Adapt its test and build steps. It publishes `ghcr.io/<owner>/<repo>:sha-<commit>` with the source revision label used by the worker. Set the configured workflow name and staging/production branches to match the workflow and repository.

The worker requires a **rootless Docker daemon** and its Unix socket. It checks the daemon before opening its HTTP API and refuses to start against a rootful engine. Set `DOCKER_SOCKET_PATH` and `DOCKER_SOCKET_GID` in `.env` to that daemon's socket and group, then enable the worker profile:

```sh
docker compose -f docker-compose.yml -f docker-compose.worker.yml --profile deployment up -d --build
```

The worker is on an internal Compose network and is the only container with the Docker socket. Do not enable it against a rootful daemon. Private GHCR images need a separate read-only package token in `GHCR_TOKEN` and its account name in `GHCR_USERNAME`; never use a write-scoped token.

The first successful post-start push to a configured staging branch deploys automatically. `/deploy release` deploys an exact successful staging commit or requests production approval. Production requests expire after 24 hours, require a different authorized user to approve, and are checked again against the latest successful production workflow before the worker acts. The production request resolves and displays the immutable image digest before approval; the worker deploys that exact digest. Production rollbacks also require another authorized approver and are bound to the exact previous digest. The worker checks health and restores the prior healthy digest if a release fails.

## Discord commands

- `/help`, `/ping`
- `/ci status` for allowlisted GitHub repositories; polling runs once per minute and can post to the optional GitHub channel
- `/deploy simulate`, `release`, `status`, `start`, `stop`, `restart`, and `rollback`
- `/task` create, list all tasks by default (or filter to open), update, describe, remove, and bump, with optional channel notifications and automatic 24-hour, 1-hour, and overdue reminders
- `/note` add, list, search, remove, export, export all, and a per-user push/pop inbox
- `/schedule set` repeats registered GitHub polling or task-reminder actions; `/schedule ontrigger` routes completed or unsuccessful workflows detected by polling to the GitHub or error channel
- `/logs list` shows available sources; `/logs show` and `/errors` read bounded lines from a named source (defaults to `sanwan`); worker output stays available through Docker logs
- `/status` reports SANWAN process, data-volume, Discord, and GitHub connectivity
- `/ask` uses configured Ollama or OpenAI-compatible chat, model listing, and authorized model switching

All commands are limited to the configured Discord server. CI and deployment controls require the server owner or a locally configured role. Task deletion and schedule changes require the same authorization. The production approval creator cannot approve their own request.

For example, `/schedule ontrigger name:ci-failed trigger:github.run.unsuccessful action:notify.error` routes newly failed configured workflow runs to `ERROR_CHANNEL_ID`. Event schedules run only on state changes observed by GitHub polling; they do not require a public inbound webhook.

## Local development and tests

Run `npm ci`, `npm test`, then `npm start`. With no `DISCORD_TOKEN`, the app initializes and checks encrypted storage in diagnostic mode. `test.js` exercises encrypted storage, worker authentication, rootless enforcement, service allowlisting, unsafe Compose rejection, image revision checks, health, and digest rollback using a mock Docker CLI.

The included `.github/workflows/container.yml` tests SANWAN and builds both Docker targets on pull requests. It publishes the bot image for `linux/amd64` and `linux/arm64` on pushes to `main` and version tags. The service workflow template is for applications SANWAN will deploy.

## Platform limits

The bot container targets Linux x64 and ARM64. Windows hosts can run it through Docker Desktop's Linux-container backend. The bot works with Docker Desktop's standard engine; the optional deployment worker requires a rootless Linux Docker Engine and refuses a rootful daemon ([Docker rootless mode](https://docs.docker.com/engine/security/rootless/)). GitHub events are detected by outbound polling, so no public webhook endpoint is required; direct webhook delivery, cron expressions, arbitrary shell commands, and remote multi-host workers are not implemented. `/ask` sends only the question text to its configured provider; it does not receive automatic access to notes, logs, or secrets.

`node uninstall.js` asks for `STOP` before removing containers. It preserves volumes and `.env` by default; entering `PURGE` also erases the encrypted database, logs, worker state, and `.env`. Locally registered service definitions are preserved.
