# T645: filter the sandbox's path to the in-stack Ollama

> Status: approved 2026-11-13, in progress.

## Context

A CLI sandbox backed by the in-stack Ollama joins `haive-models` (`worker/src/sandbox/sandbox-runner.ts` ~:445-456; compose `haive-models`, internal). On that network it reaches `ollama:11434` directly. A prompt-injected agent can therefore call `/api/pull`, `/api/create`, `/api/delete`, `/api/copy` or `/api/push` on the shared daemon. That bypasses the pull policy from T634 (#1130), and the agent can delete other users' models.

The fix: sandboxes reach a filtering proxy instead of the daemon. The proxy forwards only inference and read-only endpoints.

Measured on 2026-11-13: claude-code 2.1.323 from the sandbox image ran through a logging passthrough to the real daemon with `qwen3.5:0.8b`. Its whole traffic was `POST /v1/messages?beta=true` and `HEAD /api/hello`, with and without `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, which Haive does not set.

The only models-network consumer is a Claude-family CLI whose `ANTHROPIC_BASE_URL` host is in `IN_STACK_OLLAMA_HOSTS` (`ollama`, `<id>-ollama`; `inStackModelsHost`, sandbox-runner.ts :53). The worker and the api reach the daemon over `haive-network`: `/api/tags`, `/api/ps`, `/api/embed`, plus pulls, all from logs. They are unaffected.

## Approach: a gate that answers to the daemon's names on the models network

The design needs no change to any provider env, stored row or worker code.

- **New service `ollama-gate`.** It lives in `docker/ollama-gate/` (`server.mjs` plus `Dockerfile`) and copies the `ollama-thinking-proxy` pattern: Node built-ins only, `node:26-bookworm-slim`, `USER node`.
  - It is dual-homed. On `haive-network` it forwards to `ollama:11434`.
  - On `haive-models` it carries the network aliases `ollama` and `${HAIVE_INSTALL_ID:-haive}-ollama`.
  - It listens on 11434, so `http://ollama:11434` inside a sandbox resolves to the gate.
- **`ollama` service leaves `haive-models`.** It stays on `haive-network`. Container-name DNS resolves only on attached networks, so the gate's aliases are the only answer on `haive-models`. Update the compose comments.
- **Allowlist.** The gate checks method plus exact raw pathname; the query string is ignored for matching and forwarded untouched. Allowed:
  - Inference: `POST` `/v1/messages`, `/v1/messages/count_tokens`, `/v1/chat/completions`, `/v1/completions`, `/v1/embeddings`, `/api/chat`, `/api/generate`, `/api/embed`, `/api/embeddings`.
  - Read-only: `GET`/`HEAD` `/`, `/api/version`, `/api/tags`, `/api/ps`, `/api/hello` (measured probe), `/v1/models`, `/v1/models/<name>`, and `POST /api/show`.
  - Everything else gets 403 with a JSON `{error:{type:'forbidden',message}}`, naming nothing internal. That covers pull, push, create, delete, copy, `/api/blobs/*` and any future admin endpoint.
  - No path normalization or decoding. A raw path with `..`, a `%2F`/`%2E` encoding, a trailing slash or a case variant is not an exact match and is refused.
  - `X-HTTP-Method-Override` and similar headers are dropped before forwarding.
- **Forwarding.** Stream both ways (SSE included), keep headers, set host to upstream, and answer 502 JSON on upstream error. Copy the shape of thinking-proxy `forward()`. Pure helper `isAllowed(method, rawUrl)` is exported for unit tests.
- **Shipping.**
  - Add `docker-compose.run.yml` with the release image `haive-ollama-gate`.
  - Add the service to the `release.yml` matrix at both lists, :44 and :143.
  - Add the folder to `dependabot.yml` (:70).
  - Check `build-channel.mjs` and channel boot checks for image lists.
  - Check any compose/release parity test.
- **Docs.**
  - `docs/architecture/sandbox.md`: a models-network paragraph stating what the gate allows and why.
  - `api-auth.md:195`: drop the "Known limit" sentence and point to the gate.
  - `cli-adapters.md` if it lists sidecars.

## Rollback

Revert the PR. Compose puts `ollama` back on `haive-models` and drops the gate. On the dev stack, run `pnpm docker restart ollama` and remove the orphan gate container. No data or schema is touched, and the model volume is never involved.

## Execution

- Codex driver at high effort in worktree `sec-OGT`, branch `fix/T645-ollama-gate`.
- Sonnet review at xhigh (security, a new network boundary).
- PR, bots, CI. Merge only with 0 live CLIs and 0 running steps. Deploy with `pnpm docker restart ollama` (it leaves `haive-models`) and bring the new service up through dev.sh.

## Verification

- Unit (red-first on base where it applies; the gate is new, so the controls are its own tests plus a compose structure test):
  - every allowed pair forwards;
  - pull, delete, create, copy, push, blobs, unknown paths, `..`, encoded and trailing-slash variants, wrong method, and case variants all get 403 and never reach upstream (a fake upstream counts the calls);
  - SSE passes through;
  - compose: `ollama` is not on `haive-models`, and the gate is on both networks with both aliases.
- Live on the dev stack, with owned throwaway containers only:
  1. A throwaway container on `haive-models` gets `GET http://ollama:11434/api/tags` 200, and `POST /api/delete` and `POST /api/pull` 403. The daemon logs show no request for them.
  2. Repeat the measured claude-binary run (`qwen3.5:0.8b`) through `http://ollama:11434` on `haive-models`: the run succeeds.
  3. Worker embeddings still work: an `/api/embed` from the worker IP appears in the daemon logs, and api model listing works.
  4. `docker exec haive-ollama ollama list` shows the same models before and after.
