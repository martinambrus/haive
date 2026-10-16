import { BaseForgeProvider } from './base-forge.js';
import { assertPrNumber } from './op-args.js';
import { ForgeConflictError } from './types.js';
import type {
  ForgeContext,
  ForgeProviderName,
  OpenPrInput,
  OpenPrResult,
  PrStateResult,
} from './types.js';

interface BbServerPr {
  id: number;
  state: string;
  closedDate?: number;
  links?: { self?: { href?: string }[] };
  fromRef?: { displayId?: string };
  toRef?: { displayId?: string };
}

interface BbServerPage {
  values?: BbServerPr[];
  isLastPage?: boolean;
  nextPageStart?: number;
}

const OPEN_PR_PAGE_SIZE = 50;
const OPEN_PR_MAX_PAGES = 20;

/** Bitbucket Server / Data Center. Distinct API from Bitbucket Cloud:
 *  /rest/api/1.0 base, projects/{key}/repos/{slug} path, fromRef/toRef body with
 *  full refs/heads/ ids, HTTP access token via Bearer. */
export class BitbucketServerForgeProvider extends BaseForgeProvider {
  readonly name: ForgeProviderName = 'bitbucket_server';

  defaultApiBase(host: string): string {
    return `https://${host}/rest/api/1.0`;
  }

  protected authHeaders(ctx: ForgeContext): Record<string, string> {
    return { Authorization: `Bearer ${ctx.token}` };
  }

  async openPullRequest(ctx: ForgeContext, input: OpenPrInput): Promise<OpenPrResult> {
    try {
      const pr = await this.request<BbServerPr>(
        ctx,
        'POST',
        `/projects/${ctx.owner}/repos/${ctx.repo}/pull-requests`,
        {
          title: input.title,
          description: input.body,
          fromRef: { id: `refs/heads/${input.head}` },
          toRef: { id: `refs/heads/${input.base}` },
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
    assertPrNumber(prNumber);
    const pr = await this.request<BbServerPr>(
      ctx,
      'GET',
      `/projects/${ctx.owner}/repos/${ctx.repo}/pull-requests/${prNumber}`,
    );
    if (pr.state === 'MERGED') {
      return { state: 'merged', mergedAt: pr.closedDate ? new Date(pr.closedDate) : null };
    }
    if (pr.state === 'DECLINED') return { state: 'closed', mergedAt: null };
    return { state: 'open', mergedAt: null };
  }

  private async findOpenPullRequest(
    ctx: ForgeContext,
    head: string,
    base: string,
  ): Promise<OpenPrResult | null> {
    let start = 0;
    for (let page = 0; page < OPEN_PR_MAX_PAGES; page += 1) {
      const query = new URLSearchParams({
        state: 'OPEN',
        direction: 'OUTGOING',
        start: String(start),
        limit: String(OPEN_PR_PAGE_SIZE),
      });
      const list = await this.request<BbServerPage>(
        ctx,
        'GET',
        `/projects/${ctx.owner}/repos/${ctx.repo}/pull-requests?${query.toString()}`,
      );
      const pr = (list.values ?? []).find(
        (p) => p.fromRef?.displayId === head && p.toRef?.displayId === base,
      );
      if (pr) return toResult(pr);
      if (list.isLastPage !== false || list.nextPageStart === undefined) break;
      start = list.nextPageStart;
    }
    return null;
  }
}

function toResult(pr: BbServerPr): OpenPrResult {
  return { url: pr.links?.self?.[0]?.href ?? '', number: String(pr.id) };
}
