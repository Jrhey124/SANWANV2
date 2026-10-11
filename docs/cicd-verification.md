# Verify CI/CD on your Pi

Live scenarios below are **UNVERIFIED** until performed on your host. Automated tests use mocked Docker/GitHub responses and cannot prove Discord delivery or actual deployments.

## Prepare a disposable app

Use a dedicated GitHub test repository, test Discord channels, and isolated service projects/ports/volumes. Copy `templates/cicd-app/` into the repository root. Copy `templates/service-workflow.yml` from SANWAN into that repo as `.github/workflows/publish.yml`. Run `npm install --package-lock-only`, commit the resulting lockfile, and create `develop` and `main` branches. The workflow name is **Build and publish image** and publishes ARM64 and AMD64 images as `ghcr.io/<lowercase-owner>/<lowercase-repository>:sha-<full-commit>` with revision labels.

Use `node setup.js` on the Pi to configure GitHub monitoring, rootless application deployments, and a new disposable service. Register that workflow/repository and image, choose generated files, container port 8080, distinct host ports such as 18081/18082, and separate project names. Assign the authorized role to a second Discord user and use a third account without authorization for rejection tests. Production approvals need another user; do not use a real application's service name or volumes.

The app's Dockerfile includes a healthcheck. To validate configuration before that image is available locally, add this equivalent healthcheck to each generated Compose service:

```json
"healthcheck": {
  "test": ["CMD", "node", "-e", "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],
  "interval": "5s",
  "timeout": "2s",
  "retries": 3
}
```

Rerun setup, keeping the service, to restart the worker after editing its files. Wait for the first monitoring baseline before publishing a test change.

## Run the scenarios

1. Open a PR with a healthy change. Confirm tests run and publication is skipped. Set `failTests` to true in `release.json`, push to `develop`, and confirm tests fail, publish is skipped, no image exists for that SHA, and staging stays unchanged. Restore the flag.
2. Change the release ID and push a healthy `develop` release. Confirm workflow success, its SHA image and revision label, automatic staging deployment after background polling, a healthy release response, and notification delivery. Repeat polls and restart SANWAN; confirm that the same SHA is not deployed again and an older run does not replace it.
3. Publish a healthy `main` release. Run `/deploy release service:<test-service> environment:production commit:<full-sha>`. Confirm self-approval and unauthorized approval are rejected. Have the second authorized user approve; confirm the running immutable reference matches the approval's digest and the health response shows the expected release.
4. Request a commit without a matching successful workflow; confirm rejection. Create approval A, then publish newer successful production release B; confirm A becomes unusable. Check before and after background polling: approval revalidation must reject A either way. To test revision mismatch, publish a deliberately incorrect revision label in the disposable repo only; confirm release preparation rejects it without changing the running service.
5. With healthy staging active, set `unhealthy` to true and `failTests` to false, change the release ID, and push `develop`. The workflow must succeed but deployment must fail health checks and restore the previous healthy release/digest. Restore `unhealthy` afterwards.
6. Publish two healthy releases and run `/deploy rollback` for staging. Confirm the previous release becomes active. Repeat for production; require a different user's approval and confirm the pinned rollback digest. Restart the worker and check that active/previous state remains correct.

Use normal `/ci status` and `/deploy status` commands alongside runtime evidence. `/ci status` refreshes activity; it does not invoke automatic staging deployment. Background workflow polling runs once per minute.

```sh
curl --fail http://localhost:18081/health
curl --fail http://localhost:18082/health
docker ps --filter label=com.docker.compose.project=<test-project>
docker inspect <app-container> --format '{{.Config.Image}} {{.Image}} {{json .State.Health}}'
docker image inspect <immutable-image-reference> --format '{{index .Config.Labels "org.opencontainers.image.revision"}}'
docker compose -f docker-compose.yml -f docker-compose.worker.yml --profile deployment restart worker
docker compose -f docker-compose.yml -f docker-compose.worker.yml --profile deployment logs --since 15m sanwan worker
```

Compare the immutable reference in `Config.Image` to SANWAN's digest; Docker image IDs can differ from registry manifest digests. Do not record `.env`, authorization headers or raw credentials. Redact operational logs before sharing.

## Evidence and cleanup

For every scenario retain UTC time, expected and actual behavior, result (`PASS`, `FAIL`, or `UNVERIFIED`), workflow URL, full commit SHA, approval/running digests, revision label, health response and redacted logs. Mark PASS only when the running service matches the expectation. Keep evidence outside the test repository's Docker build context.

Stop only the disposable application's exact Compose projects using their registered files. Preserve evidence and volumes until review is complete; remove only the test named volumes if you later choose to erase them. Remove the test service through a deliberate registry edit, rerun setup to reload the worker, and revoke dedicated tokens/delete the test repository when finished. Do not use `down -v` on the real SANWAN deployment.
