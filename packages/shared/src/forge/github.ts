import { BaseForgeProvider } from './base-forge.js';
import { ForgeConflictError } from './types.js';
import type {
  ForgeContext,
  ForgeProviderName,
  OpenPrInput,
  OpenPrResult,
  PrStateResult,
} from './types.js';

interface GithubPr {
  number: number;
  html_url: string;
  state: string;
  merged?: boolean;
  merged_at?: string | null;
}

/** GitHub.com and GitHub Enterprise Server. Endpoint + body are shared verbatim with
 *  the Gitea family; only the API base and the auth header word differ. */
export class GithubForgeProvider extends BaseForgeProvider {
  readonly name: ForgeProviderName = 'github';

  defaultApiBase(host: string): string {
    return host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`;
  }

  protected authHeaders(ctx: ForgeContext): Record<string, string> {
    return { Authorization: `Bearer ${ctx.token}` };
  }

  async openPullRequest(ctx: ForgeContext, input: OpenPrInput): Promise<OpenPrResult> {
    try {
      const pr = await this.request<GithubPr>(
        ctx,
        'POST',
        `/repos/${ctx.owner}/${ctx.repo}/pulls`,
        {
          title: input.title,
          head: input.head,
          base: input.base,
          body: input.body,
        },
      );
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
    const pr = await this.request<GithubPr>(
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
    const q = new URLSearchParams({ head: `${ctx.owner}:${head}`, base, state: 'open' });
    const list = await this.request<GithubPr[]>(
      ctx,
      'GET',
      `/repos/${ctx.owner}/${ctx.repo}/pulls?${q.toString()}`,
    );
    const pr = list[0];
    return pr ? { url: pr.html_url, number: String(pr.number) } : null;
  }
}
