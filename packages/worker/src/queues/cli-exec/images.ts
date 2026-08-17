import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { getCliProviderMetadata, type CliProviderName } from '@haive/shared';
import type { CliProbePathResult } from '@haive/shared';
import { defaultDockerRunner, type DockerRunner } from '../../sandbox/docker-runner.js';
import { resolveImageTag } from '../../sandbox/image-cache.js';
import { ensureComposedImage } from '../../sandbox/composed-image-cache.js';
import { SANDBOX_WORKDIR } from '../../sandbox/sandbox-runner.js';
import type { BaseCliAdapter } from '../../cli-adapters/base-adapter.js';
import type { CliProviderRecord } from '../../cli-adapters/types.js';
import { resolveCliAuthMounts } from '../../sandbox/cli-auth-volume.js';
import {
  buildAuthProbeCommand,
  classifyAuthProbeOutput,
  detectAmpCreditsWarning,
  isAuthProbeSupported,
} from '../../cli-adapters/auth-probe.js';
import { probeOpenRouterModelCompat } from '../../cli-adapters/openrouter-compat.js';
import { resolveOpenRouterBaseUrl } from '../../cli-adapters/openrouter-proxy.js';
import { log } from './_shared.js';
import { createSandboxSpawner } from './exec-core.js';
import { handleBuildSandboxImageJob } from './handlers.js';

async function ensureProviderSandboxImage(
  db: Database,
  provider: {
    id: string;
    userId: string;
    name: string;
    cliVersion: string | null;
    sandboxDockerfileExtra: string | null;
  },
): Promise<string | null> {
  const resolution = resolveImageTag({
    name: provider.name as CliProviderName,
    cliVersion: provider.cliVersion?.trim() || null,
    providerId: provider.id,
    sandboxDockerfileExtra: provider.sandboxDockerfileExtra,
  });
  if (!resolution) return null;

  const existing = await defaultDockerRunner.inspect(resolution.tag);
  if (existing.exists) return resolution.tag;

  const fresh = await db.query.cliProviders.findFirst({
    where: eq(schema.cliProviders.id, provider.id),
    columns: { sandboxImageBuildStatus: true },
  });
  if (fresh?.sandboxImageBuildStatus === 'building') {
    throw new Error('sandbox image build is in progress, please wait for it to finish and retry');
  }

  log.info(
    { providerId: provider.id, tag: resolution.tag },
    'sandbox image cache miss, building inline',
  );
  const result = await handleBuildSandboxImageJob(db, {
    providerId: provider.id,
    userId: provider.userId,
  });
  if (!result.ok) {
    throw new Error(`sandbox image build failed: ${result.error ?? 'unknown'}`);
  }
  return result.imageTag ?? null;
}

export async function resolveSandboxImageTag(
  db: Database,
  taskId: string | null,
  provider: {
    id: string;
    userId: string;
    name: string;
    cliVersion: string | null;
    sandboxDockerfileExtra: string | null;
  },
): Promise<string | null> {
  if (taskId) {
    const composedTag = await ensureComposedImage(db, taskId, {
      name: provider.name as CliProviderName,
      cliVersion: provider.cliVersion?.trim() || null,
      sandboxDockerfileExtra: provider.sandboxDockerfileExtra,
    });
    if (composedTag) return composedTag;
  }
  return ensureProviderSandboxImage(db, provider);
}

export async function probeCliPath(
  db: Database,
  adapter: BaseCliAdapter,
  provider: CliProviderRecord,
  secrets: Record<string, string> = {},
): Promise<CliProbePathResult> {
  const startedAt = Date.now();
  const resolvedCommand = resolveProviderExecutable(adapter, provider);
  let sandboxImage: string | null;
  try {
    sandboxImage = await ensureProviderSandboxImage(db, provider);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startedAt,
    };
  }
  let authMounts: Awaited<ReturnType<typeof resolveCliAuthMounts>> = [];
  if (isAuthProbeSupported(provider.name)) {
    authMounts = resolveCliAuthMounts(
      {
        userId: provider.userId,
        providerId: provider.id,
        providerName: provider.name,
        authMode: provider.authMode,
        isolateAuth: provider.isolateAuth,
      },
      { writable: true },
    );
  }
  const spawner = createSandboxSpawner(
    provider.wrapperContent,
    sandboxImage,
    null,
    SANDBOX_WORKDIR,
    null,
    // egressDomains: a --version probe needs no model egress.
    [],
    [],
    authMounts,
  );
  try {
    const versionResult = await spawner(
      {
        command: resolvedCommand,
        args: ['--version'],
        env: provider.envVars ?? {},
      },
      { timeoutMs: 15_000 },
    );
    if (versionResult.exitCode !== 0) {
      const error =
        versionResult.error ??
        (versionResult.stderr.trim() ||
          `exit ${versionResult.exitCode ?? 'unknown'} from sandbox probe`);
      return { ok: false, error, durationMs: Date.now() - startedAt };
    }
    const versionDetail =
      versionResult.stdout.trim() || versionResult.stderr.trim() || 'binary reachable';

    if (!isAuthProbeSupported(provider.name)) {
      // Before anything about the model: does this provider have a credential at all?
      // Nothing else in this branch notices when it does not — `claude --version`
      // succeeds regardless, and the compat check below returns null without a token —
      // so a provider saved with no key reported a fully green Test and then failed
      // every step on the binary's own "Not logged in · Please run /login".
      const missingKey = resolveMissingApiKeyError(provider, secrets);
      if (missingKey) {
        return {
          ok: false,
          detail: versionDetail,
          error: missingKey,
          durationMs: Date.now() - startedAt,
        };
      }

      // OpenRouter: the binary reaching the endpoint says nothing about whether the
      // CHOSEN MODEL can run a step, and the catalog cannot predict it (a failing
      // model still advertises `tools`). One request through the real base URL finds
      // out, and unlike the CLI path it can read the upstream's actual sentence.
      //
      // Reported as a FAILED test rather than amp-style advisory. Amp's $0-balance
      // warning describes a risk; this describes a certainty — the model cannot run
      // any step that has tools, which is nearly all of them. Returning ok:true
      // alongside "cannot run a task step" is a contradiction that reads as noise,
      // and it was reported as confusing the first time it fired.
      const compatError = await resolveOpenRouterCompatWarning(provider, secrets);
      if (compatError) {
        return {
          ok: false,
          detail: versionDetail,
          error: compatError,
          durationMs: Date.now() - startedAt,
        };
      }
      return { ok: true, detail: versionDetail, durationMs: Date.now() - startedAt };
    }

    const authSpec = buildAuthProbeCommand(provider, resolvedCommand);
    const authResult = await spawner(
      {
        command: authSpec.command,
        args: authSpec.args,
        env: { ...authSpec.env, ...secrets },
      },
      { timeoutMs: 25_000 },
    );
    const classification = classifyAuthProbeOutput({
      stdout: authResult.stdout,
      stderr: authResult.stderr,
      exitCode: authResult.exitCode ?? -1,
      timedOut: authResult.timedOut,
    });
    const durationMs = Date.now() - startedAt;
    if (classification.status === 'ok') {
      // Credentials are valid; still flag foreseeable run-time blockers (e.g. an
      // amp account with $0 balance that can't run the non-interactive `amp -x`).
      const warning = provider.name === 'amp' ? detectAmpCreditsWarning(authResult.stdout) : null;
      return {
        ok: true,
        detail: versionDetail,
        durationMs,
        authStatus: 'ok',
        authMessage: classification.message,
        ...(warning ? { warning } : {}),
      };
    }
    return {
      ok: false,
      detail: versionDetail,
      error: classification.message,
      durationMs,
      authStatus: classification.status,
      authMessage: classification.message,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startedAt,
    };
  }
}

/** Wrapper CLIs that cannot run at all without a user-supplied key, mapped to the env
 *  names their adapter's own token line actually reads.
 *
 *  These three ship no `claude /login` flow — the key arrives only as a provider env var
 *  or an encrypted secret — and they sit outside isAuthProbeSupported, which is what left
 *  this uncovered: that branch runs a real `<cli> <auth probe>` and would have caught it.
 *
 *  The lists mirror each adapter's precedence expression, NOT the single canonical
 *  `apiKeyEnvName`: zai also accepts Z_AI_API_KEY (zai.ts), so checking the narrower
 *  field alone would fail a zai provider that is correctly configured. Add a name here
 *  whenever an adapter's token line gains one.
 *
 *  ollama is deliberately absent though it is the same shape of provider: it falls back
 *  to the literal `ollama` token a local daemon accepts (ollama.ts), so an empty key set
 *  is its normal in-stack state rather than a fault. */
const WRAPPER_REQUIRED_KEY_ENVS: Partial<Record<CliProviderName, readonly string[]>> = {
  openrouter: ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'],
  zai: ['Z_AI_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'],
  muse: ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'],
};

/** The Test-connection failure for a wrapper provider that has no API key at all, or
 *  null when a key is present (and for every provider outside the map above).
 *
 *  Reports only a MISSING key, never an invalid one. probeOpenRouterModelCompat treats
 *  401/403 as inconclusive on purpose (see its comment) and this keeps that contract:
 *  absence is a fact we can read locally, rejection is the upstream's opinion.
 *
 *  Deliberately carries no `authStatus`. Nothing ever writes auth_status back to `ok`
 *  for an api_key provider — assertUserAuthReady only touches subscription rows — so a
 *  status set here would outlive the user adding the key and go permanently stale. */
function resolveMissingApiKeyError(
  provider: CliProviderRecord,
  secrets: Record<string, string>,
): string | null {
  const accepted = WRAPPER_REQUIRED_KEY_ENVS[provider.name];
  if (!accepted) return null;
  const env = { ...(provider.envVars ?? {}), ...secrets };
  if (accepted.some((name) => env[name])) return null;
  const meta = getCliProviderMetadata(provider.name);
  return (
    `No ${meta.displayName} API key is configured for this provider. Add a secret named ` +
    `${meta.apiKeyEnvName ?? 'ANTHROPIC_AUTH_TOKEN'} holding your key — without it the CLI ` +
    `starts with no credentials and every task step fails with the CLI's own ` +
    `"Not logged in · Please run /login".`
  );
}

/** The Test-connection advisory for an OpenRouter provider whose selected model
 *  rejects the claude binary's request shape, or null when there is nothing to say.
 *
 *  Probes THROUGH whatever base URL the run will actually use (resolveOpenRouterBaseUrl
 *  — normally the compat proxy), not the raw gateway. That is the whole point: the
 *  proxy hoists the trailing system message that most of this class trips over, so
 *  probing openrouter.ai directly would condemn models that work perfectly well in
 *  practice. Reaching this warning now means the model fails even WITH the rewrite,
 *  or that the provider has been pointed at the raw endpoint by hand.
 *
 *  Returns null for every inconclusive outcome (no model set, no key, unreachable,
 *  auth/quota error) — see probeOpenRouterModelCompat. A false alarm here would tell
 *  the user to change a model that is actually fine, which is worse than staying
 *  quiet and letting the run report it. */
async function resolveOpenRouterCompatWarning(
  provider: CliProviderRecord,
  secrets: Record<string, string>,
): Promise<string | null> {
  if (provider.name !== 'openrouter') return null;
  const model = provider.model?.trim();
  if (!model) return null;
  const env = { ...(provider.envVars ?? {}), ...secrets };
  const token = env.ANTHROPIC_AUTH_TOKEN ?? env.ANTHROPIC_API_KEY;
  if (!token) return null;
  const baseUrl = resolveOpenRouterBaseUrl(env);
  const compat = await probeOpenRouterModelCompat({ baseUrl, token, model });
  if (compat.compatible) return null;
  const because = compat.detail ? ` Upstream said: "${compat.detail}".` : '';
  const custom = env.ANTHROPIC_BASE_URL
    ? ` This provider sets ANTHROPIC_BASE_URL by hand, so it bypasses Haive's ` +
      `OpenRouter compatibility proxy — clearing that env var may be enough to fix it.`
    : ` Haive's compatibility proxy already rewrites the request and this model still ` +
      `rejects it, so pick a different one — Anthropic models always work, and openai/*, ` +
      `x-ai/* and most others do too.`;
  return (
    `The model "${model}" rejects the request Claude Code sends, so it cannot run a ` +
    `task step.${because}${custom}`
  );
}

function resolveProviderExecutable(adapter: BaseCliAdapter, provider: CliProviderRecord): string {
  const wrapper = provider.wrapperPath?.trim();
  if (wrapper) return wrapper;
  const explicit = provider.executablePath?.trim();
  if (explicit) return explicit;
  return adapter.defaultExecutable;
}

export async function markProvidersReady(
  db: Database,
  imageTag: string,
  providerId: string,
  shared: boolean,
): Promise<void> {
  const now = new Date();
  if (shared) {
    await db
      .update(schema.cliProviders)
      .set({
        sandboxImageTag: imageTag,
        sandboxImageBuildStatus: 'ready',
        sandboxImageBuildError: null,
        sandboxImageBuiltAt: now,
        updatedAt: now,
      })
      .where(eq(schema.cliProviders.sandboxImageTag, imageTag));
  }
  await db
    .update(schema.cliProviders)
    .set({
      sandboxImageTag: imageTag,
      sandboxImageBuildStatus: 'ready',
      sandboxImageBuildError: null,
      sandboxImageBuiltAt: now,
      updatedAt: now,
    })
    .where(eq(schema.cliProviders.id, providerId));
}

export async function removeOrphanedPreviousImage(
  db: Database,
  args: { providerId: string; previousDbTag: string | null; newTag: string },
  runner: DockerRunner = defaultDockerRunner,
): Promise<{
  removed: boolean;
  reason: 'no-previous' | 'same-tag' | 'still-in-use' | 'missing' | 'remove-failed' | 'removed';
}> {
  const { previousDbTag, newTag, providerId } = args;
  if (!previousDbTag) return { removed: false, reason: 'no-previous' };
  if (previousDbTag === newTag) return { removed: false, reason: 'same-tag' };
  const stillInUse = await db.query.cliProviders.findFirst({
    where: eq(schema.cliProviders.sandboxImageTag, previousDbTag),
    columns: { id: true },
  });
  if (stillInUse) {
    log.info(
      { providerId, previousDbTag, newTag, otherProviderId: stillInUse.id },
      'keeping previous sandbox image, still referenced by another provider',
    );
    return { removed: false, reason: 'still-in-use' };
  }
  const inspected = await runner.inspect(previousDbTag);
  if (!inspected.exists) return { removed: false, reason: 'missing' };
  const removeResult = await runner.remove(previousDbTag);
  if (removeResult.ok) {
    log.info({ providerId, previousDbTag, newTag }, 'removed orphaned previous sandbox image');
    return { removed: true, reason: 'removed' };
  }
  log.warn(
    {
      providerId,
      previousDbTag,
      newTag,
      stderr: removeResult.stderr,
      error: removeResult.error,
    },
    'failed to remove orphaned previous sandbox image',
  );
  return { removed: false, reason: 'remove-failed' };
}
