import { BaseForgeProvider } from './base-forge.js';
import { ForgeConflictError } from './types.js';
import type {
  ForgeContext,
  ForgeProviderName,
  OpenPrInput,
  OpenPrResult,
  PrStateResult,
} from './types.js';

interface GiteaPr {
  number: number;
  html_url: string;
  state?: string;
  merged?: boolean;
  merged_at?: string | null;
  head?: { ref?: string };
  base?: { ref?: string };
}

/** Gitea, Forgejo, Codeberg (a Forgejo instance), and Gogs. All expose the same
 *  /api/v1 pull-request API; keyed on that stable core so a Forgejo/Gitea divergence
 *  in newer endpoints does not affect PR create/read. */
export class GiteaForgeProvider extends BaseForgeProvider {
  readonly name: ForgeProviderName = 'gitea';

  defaultApiBase(host: string): string {
    return `https://${host}/api/v1`;
  }

  protected authHeaders(ctx: ForgeContext): Record<string, string> {
    return { Authorization: `token ${ctx.token}` };
  }

  async openPullRequest(ctx: ForgeContext, input: OpenPrInput): Promise<OpenPrResult> {
    try {
      const pr = await this.request<GiteaPr>(ctx, 'POST', `/repos/${ctx.owner}/${ctx.repo}/pulls`, {
        title: input.title,
        head: input.head,
        base: input.base,
        body: input.body,
      });
      return { url: pr.html_url, number: String(pr.number) };
    } catch (err) {
      if (err instanceof ForgeConflictError) {
        const existing = await this.findOpenPullRequest(ctx, input.head, input.base);
        if (existing) return existing;
      }
      throw err;
    }
  }

  async getPullRequestState(ctx: ForgeContext, prNumber: string): Promise<PrStateResult> {
    const pr = await this.request<GiteaPr>(
      ctx,
      'GET',
      `/repos/${ctx.owner}/${ctx.repo}/pulls/${prNumber}`,
    );
    if (pr.merged || pr.merged_at) {
      return { state: 'merged', mergedAt: pr.merged_at ? new Date(pr.merged_at) : null };
    }
    if (pr.state === 'closed') return { state: 'closed', mergedAt: null };
    return { state: 'open', mergedAt: null };
  }

  private async findOpenPullRequest(
    ctx: ForgeContext,
    head: string,
    base: string,
  ): Promise<OpenPrResult | null> {
    // Gitea's list endpoint filters by state, not branch, so match head/base client-side.
    const list = await this.request<GiteaPr[]>(
      ctx,
      'GET',
      `/repos/${ctx.owner}/${ctx.repo}/pulls?state=open`,
    );
    const pr = list.find((p) => p.head?.ref === head && p.base?.ref === base);
    return pr ? { url: pr.html_url, number: String(pr.number) } : null;
  }
}
