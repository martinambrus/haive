import { BaseForgeProvider } from './base-forge.js';
import { ForgeConflictError } from './types.js';
import type {
  ForgeContext,
  ForgeProviderName,
  OpenPrInput,
  OpenPrResult,
  PrStateResult,
} from './types.js';

interface GitlabMr {
  iid: number;
  web_url: string;
  state: string;
  merged_at?: string | null;
}

/** GitLab.com and self-hosted GitLab. The outlier: merge_requests (not pulls),
 *  project id = URL-encoded owner/repo path, PRIVATE-TOKEN header, and MR creation
 *  needs the token's `api` scope (a clone-only token 403s). */
export class GitlabForgeProvider extends BaseForgeProvider {
  readonly name: ForgeProviderName = 'gitlab';

  defaultApiBase(host: string): string {
    return `https://${host}/api/v4`;
  }

  protected authHeaders(ctx: ForgeContext): Record<string, string> {
    return { 'PRIVATE-TOKEN': ctx.token };
  }

  private projectId(ctx: ForgeContext): string {
    return encodeURIComponent(`${ctx.owner}/${ctx.repo}`);
  }

  async openPullRequest(ctx: ForgeContext, input: OpenPrInput): Promise<OpenPrResult> {
    try {
      const mr = await this.request<GitlabMr>(
        ctx,
        'POST',
        `/projects/${this.projectId(ctx)}/merge_requests`,
        {
          source_branch: input.head,
          target_branch: input.base,
          title: input.title,
          description: input.body,
        },
      );
      return { url: mr.web_url, number: String(mr.iid) };
    } catch (err) {
      if (err instanceof ForgeConflictError) {
        const existing = await this.findOpenPullRequest(ctx, input.head, input.base);
        if (existing) return existing;
      }
      throw err;
    }
  }

  async getPullRequestState(ctx: ForgeContext, prNumber: string): Promise<PrStateResult> {
    const mr = await this.request<GitlabMr>(
      ctx,
      'GET',
      `/projects/${this.projectId(ctx)}/merge_requests/${prNumber}`,
    );
    if (mr.state === 'merged') {
      return { state: 'merged', mergedAt: mr.merged_at ? new Date(mr.merged_at) : null };
    }
    if (mr.state === 'closed') return { state: 'closed', mergedAt: null };
    // 'opened' | 'locked' -> still open.
    return { state: 'open', mergedAt: null };
  }

  private async findOpenPullRequest(
    ctx: ForgeContext,
    head: string,
    base: string,
  ): Promise<OpenPrResult | null> {
    const q = new URLSearchParams({ state: 'opened', source_branch: head, target_branch: base });
    const list = await this.request<GitlabMr[]>(
      ctx,
      'GET',
      `/projects/${this.projectId(ctx)}/merge_requests?${q.toString()}`,
    );
    const mr = list[0];
    return mr ? { url: mr.web_url, number: String(mr.iid) } : null;
  }
}
