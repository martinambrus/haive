import { BaseForgeProvider } from './base-forge.js';
import { ForgeConflictError } from './types.js';
import type {
  ForgeContext,
  ForgeProviderName,
  OpenPrInput,
  OpenPrResult,
  PrStateResult,
} from './types.js';

interface BbCloudPr {
  id: number;
  state: string;
  updated_on?: string;
  links?: { html?: { href?: string } };
  source?: { branch?: { name?: string } };
  destination?: { branch?: { name?: string } };
}

/** Bitbucket Cloud (bitbucket.org). Distinct from Bitbucket Server: workspace/repo_slug
 *  path, source/destination.branch.name body. App passwords auth via Basic
 *  username:password; workspace/repo access tokens via Bearer. */
export class BitbucketCloudForgeProvider extends BaseForgeProvider {
  readonly name: ForgeProviderName = 'bitbucket_cloud';

  defaultApiBase(_host: string): string {
    return 'https://api.bitbucket.org/2.0';
  }

  protected authHeaders(ctx: ForgeContext): Record<string, string> {
    if (ctx.username) {
      const basic = Buffer.from(`${ctx.username}:${ctx.token}`).toString('base64');
      return { Authorization: `Basic ${basic}` };
    }
    return { Authorization: `Bearer ${ctx.token}` };
  }

  async openPullRequest(ctx: ForgeContext, input: OpenPrInput): Promise<OpenPrResult> {
    try {
      const pr = await this.request<BbCloudPr>(
        ctx,
        'POST',
        `/repositories/${ctx.owner}/${ctx.repo}/pullrequests`,
        {
          title: input.title,
          description: input.body,
          source: { branch: { name: input.head } },
          destination: { branch: { name: input.base } },
        },
      );
      return toResult(pr);
    } catch (err) {
      if (err instanceof ForgeConflictError) {
        const existing = await this.findOpenPullRequest(ctx, input.head, input.base);
        if (existing) return existing;
      }
      throw err;
    }
  }

  async getPullRequestState(ctx: ForgeContext, prNumber: string): Promise<PrStateResult> {
    const pr = await this.request<BbCloudPr>(
      ctx,
      'GET',
      `/repositories/${ctx.owner}/${ctx.repo}/pullrequests/${prNumber}`,
    );
    if (pr.state === 'MERGED') {
      return { state: 'merged', mergedAt: pr.updated_on ? new Date(pr.updated_on) : null };
    }
    if (pr.state === 'DECLINED' || pr.state === 'SUPERSEDED') {
      return { state: 'closed', mergedAt: null };
    }
    return { state: 'open', mergedAt: null };
  }

  private async findOpenPullRequest(
    ctx: ForgeContext,
    head: string,
    base: string,
  ): Promise<OpenPrResult | null> {
    const list = await this.request<{ values?: BbCloudPr[] }>(
      ctx,
      'GET',
      `/repositories/${ctx.owner}/${ctx.repo}/pullrequests?state=OPEN`,
    );
    const pr = (list.values ?? []).find(
      (p) => p.source?.branch?.name === head && p.destination?.branch?.name === base,
    );
    return pr ? toResult(pr) : null;
  }
}

function toResult(pr: BbCloudPr): OpenPrResult {
  return { url: pr.links?.html?.href ?? '', number: String(pr.id) };
}
