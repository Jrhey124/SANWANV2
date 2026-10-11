# Run SANWAN on Raspberry Pi 5

Use a 64-bit Linux system (`uname -m` should show `aarch64`), Node.js 22 or later, Docker Engine and Compose v2. SANWAN supports ARM64; setup builds locally on your Pi. No inbound port is required for the Discord bot.

From your SANWAN checkout:

```sh
node --version
docker info
docker compose version
node setup.js
```

Enter the Discord bot token, application ID and server ID. Optional features can be skipped. Accept the launch prompt, run the offered checks, and try `/ping` in Discord. Node is required for setup; Docker builds the application dependencies, so no host `npm install` is required just to launch the bot.

On subsequent runs, setup offers Configure, Check saved setup, or Cancel. Existing values can be kept or replaced. Setup preserves your generated encryption key and worker token. Keep a protected backup of `.env`; losing `SQLITE_KEY` makes saved data unreadable.

## GitHub and application deployments

Select **GitHub monitoring** to enter a repository token, `owner/repo` allowlist and notification channel. Organization repositories use `organization/repository`. Start monitoring before creating a new test event; each repository's initial baseline is silent.

Select **Application deployments** only when you want SANWAN to deploy apps. Deployments default to disabled. This option detects your selected daemon/socket, saves the enablement setting, configures private GHCR credentials if needed, registers services and launches the worker with the correct Compose profile. Production requires an approval channel and a different authorized user; assign the configured Discord role to that user.

The worker requires a local **rootless Linux Docker daemon**. Follow [Docker's rootless instructions](https://docs.docker.com/engine/security/rootless/) if it is missing. Setup does not install Docker or change contexts. If the selected daemon is rootful, setup can launch the bot while reporting deployments as pending. After preparing rootless Docker, rerun setup from the daemon owner's account. The detected socket is normally `/run/user/<uid>/docker.sock`; its owner/group map to container root in rootless mode, so setup uses container socket group `0` when it confirms that ownership. Keep SANWAN and its worker on the same selected daemon.

For each application, setup asks for the matching repository/workflow, staging and production branches, image path, and environment mappings. It can generate starter Compose JSON files or use existing files under `services/`. Generated environments have separate Compose projects, host ports above 1023, and optional named volumes. Existing files are never overwritten by generation. The image must implement a HEALTHCHECK or the Compose service must define a working healthcheck. Starter files use an image placeholder tag; actual releases replace that reference with a validated immutable digest.

Healthcheck validation can only inspect an inherited image healthcheck when that image is available locally. A warning about an unavailable image means readiness remains unverified; diagnostics do not pull images. Add a Compose healthcheck for immediate configuration validation, or validate the published release through `/deploy simulate` and deployment testing. A configured healthcheck does not prove that the app will become healthy.

Read-only checks show bot/Discord readiness, GitHub access, worker health, GHCR metadata access, and each service's Compose/healthcheck configuration. Actual notifications, publication, deployment and rollback require the [live CI/CD procedure](cicd-verification.md).

## Updates and troubleshooting

After updating the checkout, rerun `node setup.js` to retain settings, repair registry permissions and rebuild using the saved deployment choice. Setup detects an already-running worker when migrating older configurations without an enablement setting.

```sh
docker compose ps
docker compose logs --since 10m sanwan
```

Setup makes `config/services.json` container-readable and its parent directory searchable. Credentials remain in owner-only `.env`. For user-supplied Compose files, follow the exact permission instructions shown by setup. An unreadable or invalid service registry disables deployment processing while GitHub monitoring continues.

If deployments are enabled, inspect worker logs with:

```sh
docker compose -f docker-compose.yml -f docker-compose.worker.yml --profile deployment logs --since 10m worker
```
