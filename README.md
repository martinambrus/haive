# hAIv<sup>e</sup>

Deterministic multi-CLI orchestration and AI agentic workflow utility. Replaces a markdown-driven Claude Code onboarding flow, an autonomous `/workflow` implementation loop, and a sandboxed local environment replication step set with a deterministic web project. Agentic CLI invocations only happen for parts that need reasoning; everything else is a TypeScript step module with a web form.

## Quickstart

Requires Docker and Docker Compose. WSL2 plus Docker Desktop is the supported developer environment.

```bash
# Clone
git clone <repo-url> haive
cd haive

# Configure
cp .env.example .env
# Edit .env: at minimum set CONFIG_ENCRYPTION_KEY and JWT_SECRET.
# Generate a 32-byte hex key:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Boot the stack (postgres, redis, mailpit, api, worker, web)
pnpm docker:dev

# Web UI
open http://localhost:3000

# Tear down
pnpm docker:down
```

### Ports (dev override)

| Service      | Host port | Container port | URL / DSN                                 |
| ------------ | --------- | -------------- | ----------------------------------------- |
| Web (Next)   | 3000      | 3000           | http://localhost:3000                     |
| API (Hono)   | 3001      | 3001           | http://localhost:3001/health              |
| PostgreSQL   | 5432      | 5432           | postgres://haive:...@localhost:5432/haive |
| Redis        | 6379      | 6379           | redis://localhost:6379                    |
| Mailpit SMTP | 1085      | 1025           | smtp://localhost:1085                     |
| Mailpit UI   | 8085      | 8025           | http://localhost:8085                     |

Mailpit ports are shifted from the upstream defaults (1025/8025) because ddev binds those on many developer machines. If you do not run ddev, you may safely move them back in `docker-compose.dev.yml`.

## Architecture

- `@haive/shared` types, schemas, crypto, logger
- `@haive/database` Drizzle ORM schemas and migrations
- `@haive/api` Hono REST API on port 3001
- `@haive/worker` BullMQ workers, step engine, CLI adapters, clawker sandbox
- `@haive/web` Next.js Conductor-style UI on port 3000

Three queues on Redis: `task-queue`, `cli-exec-queue`, `env-replicate-queue`. State of truth is PostgreSQL. Per-task sandboxes use the clawker Go binary wrapped via child_process for Docker-in-Docker isolation.

Repositories come from a git remote, an uploaded archive, or a local directory. Remote and uploaded repos are copied into the `haive_repos` volume and mounted writable into each task sandbox. A local directory is, by default, bind-mounted **read-only** so a workflow can never mutate your real working tree. Tick **"Work on a writable copy"** when adding a local directory to instead snapshot it into the `haive_repos` volume at import; the workflow then edits and commits against the copy while your original directory stays untouched. The snapshot is taken once at import (it includes the full working tree, ignored folders such as `node_modules` included, so it uses extra disk); refreshing the repository re-copies from the source and discards any in-volume changes.

See [CLAUDE.md](./CLAUDE.md) for monorepo layout, package boundaries, conventions, build commands, and constraints.

## Tech stack

Runtime and tooling

- [Node.js](https://nodejs.org/) 26
- [TypeScript](https://www.typescriptlang.org/) 5.7
- [pnpm](https://pnpm.io/) workspaces
- [Turborepo](https://turborepo.com/)
- [tsx](https://github.com/privatenumber/tsx) for dev watch
- [Prettier](https://prettier.io/)
- [Husky](https://typicode.github.io/husky/)

API and realtime

- [Hono](https://hono.dev/) 4 REST framework
- [@hono/node-server](https://github.com/honojs/node-server)
- [ws](https://github.com/websockets/ws) WebSocket server
- [jsonwebtoken](https://github.com/auth0/node-jsonwebtoken)
- [bcrypt](https://github.com/kelektiv/node.bcrypt.js)
- [prom-client](https://github.com/siimon/prom-client) metrics

Queues, cache, database

- [BullMQ](https://bullmq.io/) 5 on [Redis](https://redis.io/) 8
- [ioredis](https://github.com/redis/ioredis)
- [PostgreSQL](https://www.postgresql.org/) 18
- [Drizzle ORM](https://orm.drizzle.team/) with drizzle-kit
- [postgres.js](https://github.com/porsager/postgres) driver

Schemas and logging

- [Zod](https://zod.dev/) 4
- [pino](https://getpino.io/)

Web UI

- [Next.js](https://nextjs.org/) 16
- [React](https://react.dev/) 19
- [Tailwind CSS](https://tailwindcss.com/) 4
- [xterm.js](https://xtermjs.org/) with fit and web-links addons
- [Radix UI](https://www.radix-ui.com/) primitives
- [lucide-react](https://lucide.dev/) icons
- [class-variance-authority](https://cva.style/), [clsx](https://github.com/lukeed/clsx), [tailwind-merge](https://github.com/dcastil/tailwind-merge)

Sandbox and Docker

- [clawker](https://github.com/schmitthub/clawker) per-task sandbox (Apache 2.0 Go binary)
- [Docker Compose](https://docs.docker.com/compose/)
- [dockerode](https://github.com/apocas/dockerode)
- [tar-fs](https://github.com/mafintosh/tar-fs)

Dev services

- [Mailpit](https://mailpit.axllent.org/) local SMTP

Testing

- [Vitest](https://vitest.dev/)
- [Playwright](https://playwright.dev/)

## Development

Everything builds and runs inside containers — never `pnpm install` or
`pnpm --filter … build` on the host (it writes root-owned `node_modules` and
poisons the bind-mounted `dist`). Manage the whole stack with `scripts/dev.sh`,
aliased as `pnpm docker:dev` and `pnpm docker <cmd>`:

| Command                     | What it does                                                                                                                                                     |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm docker:dev`           | Boot the stack (GPU-aware). Alias for `scripts/dev.sh up`.                                                                                                       |
| `pnpm docker:down`          | Stop the stack; keeps all data (never `-v`).                                                                                                                     |
| `pnpm docker restart [svc]` | Recreate the stack (or one service) with the shared libs rebuilt once.                                                                                           |
| `pnpm docker logs [svc]`    | Follow logs.                                                                                                                                                     |
| `pnpm docker status`        | Show service status.                                                                                                                                             |
| `pnpm docker libs`          | Rebuild `@haive/shared` + `@haive/database` after editing their source.                                                                                          |
| `pnpm docker rebuild [svc]` | Pick up a dependency/lockfile change (rebuild image + recreate node_modules volumes). No args = full rebuild; a root/shared/database dep needs the full rebuild. |
| `pnpm docker reset`         | Full rebuild + wipe compiled `dist` to recover a stale/corrupt build. Preserves all data.                                                                        |

`rebuild`/`reset` only touch the `node_modules` and `.next` caches — data volumes
(postgres/redis/repos/…), your own `ddev-*` projects, and per-task runtimes are
never touched. Never run `down -v` or `docker volume prune` against this stack.

```bash
# Database
pnpm db:generate    # drizzle-kit generate (writes new migration files)
pnpm db:push        # drizzle-kit push (apply schema directly, dev only)
pnpm db:studio      # drizzle-kit studio

# Tests
pnpm test           # vitest across all packages
pnpm test:e2e       # playwright against dev compose stack

# Quality
pnpm typecheck
pnpm format
pnpm format:check
```

## Browser IDE (Editor tab)

Each task's Editor tab runs a full browser VS Code (code-server) on the task's
workspace, reverse-proxied through the authenticated API exactly like the Terminal
and VNC tabs. It replaces the old read-only Source viewer (which remains as the
fallback when the editor is unavailable).

- Workspace rooting: the editor is mounted on the task's git worktree ONLY (volume
  subpath), so the repo root and sibling worktrees are physically absent — a
  terminal inside the editor cannot escape to them. For worktree tasks there is no
  in-IDE git panel by design (the deterministic workflow owns all commits/merges);
  non-worktree tasks mount the full repo and get working git.
- Extensions: installed from the Open VSX registry (the Microsoft Marketplace is
  licensed to MS products only, so Pylance, C#, C/C++, Remote-\*, and Live Share are
  unavailable). Extensions live on a per-user Docker volume — install once, present
  in every task you open.
- Settings: per-user global settings.json at Settings → Editor (seeded into every
  editor session); per-project overrides in the repo's `.vscode/settings.json`,
  which VS Code layers on top.
- Lifecycle: lazy-started when you open the tab; never reaped while the tab is open;
  gracefully stopped 30 minutes after it closes. Unsaved (hot-exit) buffers live on
  a per-task volume that survives the reap, so reopening restores them.
- Image: pinned `codercom/code-server` (see `CODE_SERVER_IMAGE`). The first open
  pulls it (the tab shows a downloading state); optionally pre-pull with
  `docker pull codercom/code-server:<tag>` to avoid that wait.
- Kill-switch: Admin → "In-task editor (IDE)" (`config:ide:enabled`). OFF hides the
  Editor tab and refuses launches; the read-only Source viewer remains.
- Security: the editor sees the real worktree files and gets a worktree-scoped
  shell — the same human-trust model as the existing Terminal tab. The AI
  secret-file masking does NOT apply to the human editor. code-server runs with
  auth disabled, bound only to the internal sandbox network (never host-published);
  the API proxy (cookie-JWT + task ownership) is the sole auth boundary.

## Resource limits and WSL2 tuning

Haive runs each task's DDEV/app environment as its own set of Docker containers (a privileged Docker-in-Docker runner plus DDEV's own web/db/router, and a headed Chromium for VNC testing). Several at once can exhaust a small VM, so a machine-aware resource governor bounds them:

- Every runtime runner and CLI-exec sandbox is spawned with Docker memory and CPU caps, with memory-swap disabled so a runaway container is OOM-killed rather than driving the host into swap thrash, plus a pid cap.
- An admission gate limits how many runtimes are live at once, so concurrent DDEV/VNC tasks queue instead of overcommitting RAM.
- A reaper reclaims leaked runners (a failed task keeps its runner for retry; if never retried it is reclaimed after a grace).

Defaults auto-derive from the host's RAM and CPU count, sized conservatively for thin machines (8-16 GB). Override any value in the admin console ("Runtime resource limits" card) or via the config keys `RESOURCE_LIMITS_ENABLED`, `RUNTIME_MEMORY_MB`, `RUNTIME_CPUS`, `MAX_CONCURRENT_RUNTIMES`, `RUNTIME_IDLE_REAP_MINUTES` (0 on a number means auto-derive). Set `RESOURCE_LIMITS_ENABLED=false` to disable the caps and gate entirely.

WSL2 sizes its VM at roughly 50% of host RAM, with 25% of that as swap, unless you tune it. On a memory-constrained host, set limits in `%UserProfile%\.wslconfig` and restart WSL (`wsl --shutdown`):

```ini
[wsl2]
memory=24GB
swap=8GB
processors=12
```

The container caps above still apply inside whatever size the VM is; `.wslconfig` sets the ceiling the governor budgets against.

## Hardening

### Multi-user isolation

Every task, repository, credential, and CLI provider row is scoped by `userId`. API routes filter by the authenticated user in every query; there is no implicit admin bypass. A regression smoke test (`packages/api/test/multi-user-isolation-smoke.ts`) creates two users and asserts that user B cannot read, list, submit, action, or otherwise observe user A's resources.

### Secret-file masking

AI CLI agents run with the model-provider endpoint allowlisted, so any repo file an agent reads can be shipped to a third-party model as context — the one egress channel the firewall must keep open. To limit that, the worker hides likely-secret files (`.env` and `.env.*`, private keys and certs, SSH keys, cloud and service-account credentials, registry auth, Terraform state, database dumps, backups, Drupal `settings.local.php`, and more) from the agent: before each CLI invocation it bind-mounts empty read-only files over every match inside the agent's sandbox. The running app (DDEV / app-runner) mounts the same repo volume **without** the masks, so it still boots with the real files.

Masking is on by default and covers **untracked files only** (committed secrets are left as-is). Per repository you can adjust it on the tooling settings page: turn it off, add an **allow** list to un-mask specific files, or add a **deny-extend** list to mask extra globs (for example `**/*.sql` if your repo keeps SQL dumps rather than schema migrations). The built-in deny list lives in `DEFAULT_SECRET_DENY_GLOBS` (`@haive/shared`); `CONFIG_KEYS.SECRET_MASK_ENABLED` is a global kill-switch.

### Terminal control characters

`Ctrl+C` (0x03) and `Ctrl+D` (0x04) bytes are stripped from WebSocket input before being forwarded to the PTY so an accidental keystroke cannot tear down a long-running CLI session. To forward them explicitly the client sends a `set_control_passthrough` frame with `allow: true`; sending `allow: false` restores the default block. Pure helpers `scanOauthPrompts` and `stripControlBytes` are exported from `packages/api/src/routes/terminal.ts` and unit-tested in `packages/api/test/terminal-parser.test.ts`.

### OAuth prompt detection

The terminal server parses CLI OAuth verification URLs out of PTY output (ANSI sequences stripped, trailing punctuation trimmed, rolling buffer capped) and emits an `oauth_prompt` frame with the URL and an inferred service (`claude`, `codex`, `gemini`, `grok`, `amp`). Clients can render this as a clickable link instead of forcing the user to copy the URL out of the raw terminal view.

### Container cleanup

On task completion, failure, or cancellation, the worker destroys every container row associated with the task via `cleanupTaskContainers` in `packages/worker/src/queues/task-queue.ts`. A `containers.destroyed` task event records the reason and count. The runner is injectable via `setContainerCleanupRunner` so tests can assert cleanup without touching a real Docker daemon; see `packages/worker/test/container-cleanup-smoke.ts`.

### Per-task resource limits

`POST /tasks` accepts an optional `resourceLimits: { memoryLimitMb?: number, cpuLimitMilli?: number }` object. Values land on the task row and flow through `loadTaskResourceLimits` into the container manager, which emits `--memory {mb}m` and `--cpus {cores}` flags when spawning clawker. Bounds: 128 MiB ≤ memory ≤ 65536 MiB, 100 ≤ CPU (millicores) ≤ 16000. Unit tests in `packages/worker/test/resource-limits.test.ts`.

### Step error recovery

Failed steps surface **Retry** and **Skip** buttons in the task detail page; `waiting_form` steps also expose a Skip. Both post to `POST /tasks/:id/steps/:stepId/action` with `{ action: 'retry' | 'skip', note? }`. Retry resets the step to `pending`, clears the error, moves the task to `running`, and enqueues `ADVANCE_STEP`. Skip marks the step `skipped` and advances to the next step (or completes the task if there is no next step). Verified by `packages/api/test/step-retry-skip-smoke.ts`.

### Docker socket exposure

The worker container mounts a Docker socket at `/var/run/docker.sock` inside the container so clawker can drive Docker-in-Docker. With the default `DOCKER_SOCKET=/var/run/docker.sock` setting this is the root-privileged host daemon, which means a worker-container compromise is effectively root on the host. Do not run the default setup on a machine where untrusted code executes outside the sandbox.

#### Rootless Docker (recommended for hardened deployments)

Install Docker's rootless mode on the host (see the upstream walkthrough at `docs.docker.com/engine/security/rootless/`), start the rootless daemon as your user, then point the worker at the rootless socket via `.env`:

```bash
# One-time host setup (as a non-root user):
dockerd-rootless-setuptool.sh install
systemctl --user start docker

# In haive/.env:
DOCKER_SOCKET=/run/user/1000/docker.sock  # substitute your uid from `id -u`
```

Bring the stack up with `pnpm docker:dev`. The worker container still sees `/var/run/docker.sock` internally (via `DOCKER_HOST=unix:///var/run/docker.sock`), but the host side is now the unprivileged rootless daemon. A container escape at that point lands the attacker in the unprivileged user's rootless namespace, not as root on the host.

Caveats: rootless Docker uses user-namespaced uid mapping, so files written inside per-task containers will not be owned by uid 0 on the host; clawker's bind-mount copy mode handles this correctly. Networking still uses the `haive-network` bridge. Rootless does not support `--privileged` containers, but hAIv<sup>e</sup>'s per-task sandboxes never request privilege so this is not a regression.

## Acknowledgements

The workflow DAG design is directly inspired by [SWE-AF](https://github.com/Agent-Field/SWE-AF).

## License

MIT. Copyright (c) 2026 Martin Ambrus. See [LICENSE](./LICENSE).
