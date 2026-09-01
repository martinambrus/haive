# Haive agent instructions

## Container-only development

Treat `scripts/dev.sh` as the only supported entry point for the development
stack lifecycle. Run it through `pnpm docker <command>` (or
`bash scripts/dev.sh <command>`). Do not run raw `docker compose` lifecycle or
build commands from WSL, and do not run host-side `pnpm install`, `pnpm build`,
or `pnpm --filter ... build`. Direct host rebuilds have previously left the
bind-mounted build output and dependency volumes stale or inconsistent with the
running containers.

Use the repository commands for their documented purposes:

- `pnpm docker:dev` or `pnpm docker up` starts the stack.
- `pnpm docker restart [service...]` recreates services and rebuilds shared
  libraries once.
- `pnpm docker rebuild [service...]` handles dependency or lockfile changes and
  recreates the appropriate dependency volumes. Use it without a service for
  root, shared, or database dependency changes.
- `pnpm docker reset` recovers stale or corrupt compiled output while preserving
  application data.
- `pnpm docker libs` rebuilds `@haive/database` and `@haive/shared` with one
  container writer.
- `pnpm docker logs|status|down` handles the remaining stack lifecycle. Never
  add `-v` or prune this project's volumes.

For source-only changes to the API, worker, or web app, first rely on the
bind-mounted source and the service's dev watcher. Confirm the loaded source and
logs before deciding that a restart or rebuild is necessary. If a check has no
repository wrapper, run it inside the matching existing service container;
`docker exec` for diagnostics or tests is acceptable, but it must not be used to
install dependencies or rebuild runtime artifacts.

Before restarting or rebuilding the worker, inspect active tasks. Recreating the
worker can interrupt live CLI terminals and in-progress task steps.
