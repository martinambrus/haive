import { describe, expect, it } from 'vitest';
import { promptNamesAgentPath } from '@haive/shared';
import { HOUSE_RULES_END, emptyProjectFacetSet } from '@haive/shared/global-kb';
import { agentIsolationApplies } from './dispatcher.js';
import type { DispatchRequest } from './dispatcher.js';
import {
  HOUSE_RULES_MARKER,
  disabledSelection,
  selectHouseRules,
  withHouseRules,
  type HouseRuleCandidate,
} from './house-rules.js';
import { SANDBOX_WORKDIR } from '../sandbox/sandbox-runner.js';
import { agentDefinitionGuidance } from '../step-engine/steps/_retrieval-guidance.js';
import { globalKbDigestPrompt, selectDigest } from '../step-engine/steps/_global-kb-digest.js';

/** A request that IS isolated, so each case below flips exactly one condition. */
function isolatedRequest(over: Partial<DispatchRequest> = {}): DispatchRequest {
  return {
    providers: [],
    input: {
      kind: 'prompt',
      prompt: 'Review the change set and report findings.',
      capabilities: ['tool_use'],
    },
    invokeOpts: {},
    agentIsolation: true,
    ...over,
  } as DispatchRequest;
}

describe('agentIsolationApplies', () => {
  it('holds when all seven conditions hold', () => {
    expect(agentIsolationApplies(isolatedRequest())).toBe(true);
  });

  it('is off when the kill switch is off or unset', () => {
    expect(agentIsolationApplies(isolatedRequest({ agentIsolation: false }))).toBe(false);
    expect(agentIsolationApplies(isolatedRequest({ agentIsolation: undefined }))).toBe(false);
  });

  it('is off for a sub-agent dispatch', () => {
    // The sub-agent kinds rebuild each sub-step's spec worker-side, so they behave as today.
    const req = isolatedRequest({
      input: {
        kind: 'subagent',
        spec: { subAgents: [], synthesisPrompt: '' },
        capabilities: ['tool_use'],
      },
    } as Partial<DispatchRequest>);
    expect(agentIsolationApplies(req)).toBe(false);
  });

  it('is off when the invocation writes files', () => {
    // A tmpfs mask is writable, so an edit to a masked agent file would vanish with the container.
    const req = isolatedRequest();
    (req.input as { capabilities: string[] }).capabilities = ['tool_use', 'file_write'];
    expect(agentIsolationApplies(req)).toBe(false);
  });

  it('is off when the invocation may spawn native sub-agents', () => {
    const req = isolatedRequest();
    (req.input as { capabilities: string[] }).capabilities = ['tool_use', 'subagents'];
    expect(agentIsolationApplies(req)).toBe(false);
  });

  it('is off when the step declared agentPool "*"', () => {
    expect(agentIsolationApplies(isolatedRequest({ agentPool: '*' }))).toBe(false);
  });

  it('is off when the PROMPT names an agent path', () => {
    const req = isolatedRequest();
    (req.input as { prompt: string }).prompt = 'Review .claude/agents/peer-reviewer.md';
    expect(agentIsolationApplies(req)).toBe(false);
  });

  it('IGNORES an agent path inside one of Haive own marker blocks', () => {
    // Every marker's pointer names `.claude/agents/<id>.md` by construction. Counting those would
    // isolate nothing at all, and the block never reaches the model — the rewrite replaces it.
    const req = isolatedRequest();
    (req.input as { prompt: string }).prompt = `Do the work.\n${agentDefinitionGuidance(
      'peer-reviewer',
      'Follow .claude/agents/peer-reviewer.md if it exists.',
    )}\nThen report.`;
    expect(agentIsolationApplies(req)).toBe(true);
  });

  it('is off when a persona BODY names an agent path', () => {
    // Bodies are scanned verbatim: a replacer's return value is never rescanned, so a marker block
    // or a pointer inside a body reaches the model as written and must end isolation.
    const req = isolatedRequest({
      agentBodies: { 'peer-reviewer': 'Also read .claude/agents/security-auditor.md first.' },
    });
    expect(agentIsolationApplies(req)).toBe(false);
  });

  it('is off when the repository instructions name an agent path, or could not be scanned', () => {
    expect(agentIsolationApplies(isolatedRequest({ instructionsNameAgentPath: true }))).toBe(false);
    // An explicit false is the scanned-and-clean verdict and keeps isolation.
    expect(agentIsolationApplies(isolatedRequest({ instructionsNameAgentPath: false }))).toBe(true);
  });

  // The seventh condition. `adaptPrompt` splices two blocks in AFTER this rule returns, and both carry
  // text Haive did not write, so the prompt argument alone cannot answer for them.
  it('is off when a repository-named MCP SERVER names an agent path', () => {
    const req = isolatedRequest({
      mcpSurface: {
        ragOnly: false,
        rag: { enabled: false, apiUrl: '', token: '' },
        chromeDevtools: { enabled: false, version: '' },
        ddevControl: { enabled: false, apiUrl: '', token: '' },
        // A repository's own `.claude/mcp_settings.json` keys, taken verbatim by loadUserMcpServers.
        userServers: { '.claude/agents/foo': { command: 'npx' } },
      },
    } as Partial<DispatchRequest>);
    expect(agentIsolationApplies(req)).toBe(false);
  });

  it('is off when a global-KB digest TITLE names an agent path', () => {
    const req = isolatedRequest({
      globalKbDigest: {
        entries: [{ category: 'standards', title: '.claude/agents/foo' }],
        omitted: 0,
        scanSaturated: false,
      },
    });
    expect(agentIsolationApplies(req)).toBe(false);
  });

  it('is off when a global-KB digest DESCRIPTION names an agent path', () => {
    const req = isolatedRequest({
      globalKbDigest: {
        entries: [
          {
            category: 'standards',
            title: 'A house rule',
            description: 'Read .claude/agents/reviewer.md before you review.',
          },
        ],
        omitted: 0,
        scanSaturated: false,
      },
    });
    expect(agentIsolationApplies(req)).toBe(false);
  });

  // The cap drops trailing punctuation before its ellipsis, so a token the raw text does not match
  // can render as one that does: `.claude/agents-` is a different segment, `.claude/agents` is the
  // directory. The digest normalises once and the rule scans what that produced, so the two agree.
  it('scans a description as the digest rendered it, cap and all', () => {
    const raw = `${'a'.repeat(270)} .claude/agents- ${'x'.repeat(60)}`;
    expect(promptNamesAgentPath(raw, SANDBOX_WORKDIR)).toBe(false);

    const digest = selectDigest(
      [{ title: 'A house rule', category: 'standards', facets: {}, description: raw }],
      emptyProjectFacetSet(),
    );
    expect(promptNamesAgentPath(globalKbDigestPrompt(digest.entries), SANDBOX_WORKDIR)).toBe(true);
    expect(agentIsolationApplies(isolatedRequest({ globalKbDigest: digest }))).toBe(false);
  });

  it('is off when the injected agent RULES name an agent path', () => {
    const rules = '- Before reviewing, read .claude/agents/reviewer.md.';
    expect(agentIsolationApplies(isolatedRequest(), rules)).toBe(false);
    // The pre-check runs before a provider is known and so without the rules: it stays permissive.
    expect(agentIsolationApplies(isolatedRequest())).toBe(true);
    expect(agentIsolationApplies(isolatedRequest(), '- Keep changes small.')).toBe(true);
  });

  it('KEEPS isolation for benign external text, and for none at all', () => {
    // The condition is about the CONTENT of those blocks, not their presence: a surface and a digest
    // that name nothing must not cost a dispatch its isolation.
    const benign = isolatedRequest({
      mcpSurface: {
        ragOnly: false,
        rag: { enabled: true, apiUrl: 'http://api:3001', token: 't' },
        chromeDevtools: { enabled: false, version: '' },
        ddevControl: { enabled: false, apiUrl: '', token: '' },
        userServers: { 'company-docs': { command: 'npx' } },
      },
      globalKbDigest: {
        entries: [
          {
            category: 'standards',
            title: 'Escape every interpolated label',
            description: 'Applies to any template that builds markup from stored text.',
          },
        ],
        omitted: 0,
        scanSaturated: false,
      },
    } as Partial<DispatchRequest>);
    expect(agentIsolationApplies(benign)).toBe(true);
    // And the shapes a direct resolveDispatch caller passes: absent, null, empty.
    expect(agentIsolationApplies(isolatedRequest({ mcpSurface: null }))).toBe(true);
    expect(
      agentIsolationApplies(
        isolatedRequest({ globalKbDigest: { entries: [], omitted: 0, scanSaturated: false } }),
      ),
    ).toBe(true);
  });

  it('scans a SHADOWED server name too, and that is deliberate', () => {
    // Only `reachableUserServerNames` knows which servers this run would actually render, and it needs
    // the emitted-server set, which depends on render options this pure rule does not have. Scanning
    // the superset costs a dispatch its context saving; duplicating the shadowing logic would put two
    // copies of it in the tree, and shadowing is run-time state — a name shadowed today renders
    // tomorrow, so isolation keyed on it would flicker per run for one repository.
    const req = isolatedRequest({
      mcpSurface: {
        ragOnly: false,
        // `haive-rag` enabled, so a user server of that name IS shadowed and never rendered.
        rag: { enabled: true, apiUrl: 'http://api:3001', token: 't' },
        chromeDevtools: { enabled: false, version: '' },
        ddevControl: { enabled: false, apiUrl: '', token: '' },
        userServers: { '.claude/agents/shadowed': { command: 'npx' }, 'haive-rag': {} },
      },
    } as Partial<DispatchRequest>);
    expect(agentIsolationApplies(req)).toBe(false);
  });

  describe('with house rules', () => {
    const rule = (over: Partial<HouseRuleCandidate> = {}): HouseRuleCandidate => ({
      id: '00000001-0000-4000-8000-000000000001',
      hash: 'hr1:1',
      title: 'Escape every label',
      category: 'best_practice',
      description: 'Escape labels before markup.',
      body: 'Escape each label before it reaches markup.\n',
      spec: { mode: 'always' },
      enforcedAt: null,
      ...over,
    });
    const shown = (rules: HouseRuleCandidate[], changedFiles: string[] = []) =>
      selectHouseRules({ mode: 'write', rules, changedFiles });
    const asked = { houseRules: { mode: 'write' as const } };

    it('holds for benign rules', () => {
      const req = isolatedRequest({ ...asked, houseRuleSelection: shown([rule()]) });
      expect(agentIsolationApplies(req)).toBe(true);
    });

    it.each([
      ['title', { title: 'Read .claude/agents/reviewer.md' }],
      ['description', { description: 'See .claude/agents/reviewer.md.' }],
      ['body', { body: 'Before reviewing, read .claude/agents/reviewer.md.\n' }],
    ])('is off when the injected rules name an agent path in their %s', (_field, over) => {
      const selection = shown([rule(over)]);
      expect(promptNamesAgentPath(selection.block!, SANDBOX_WORKDIR)).toBe(true);
      expect(
        agentIsolationApplies(isolatedRequest({ ...asked, houseRuleSelection: selection })),
      ).toBe(false);
    });

    it('is off when a glob on the scope line names one', () => {
      const selection = shown(
        [rule({ spec: { mode: 'files', globs: ['.claude/agents/*.md'] } })],
        ['.claude/agents/x.md'],
      );
      expect(selection.block).toContain('Applies to files matching: .claude/agents/*.md');
      expect(
        agentIsolationApplies(isolatedRequest({ ...asked, houseRuleSelection: selection })),
      ).toBe(false);
    });

    it('scans only what is injected: nothing for a dispatch that did not ask, or has nothing to show', () => {
      const naming = shown([rule({ body: 'Read .claude/agents/reviewer.md.\n' })]);
      expect(agentIsolationApplies(isolatedRequest({ houseRuleSelection: naming }))).toBe(true);
      expect(
        agentIsolationApplies(isolatedRequest({ ...asked, houseRuleSelection: shown([]) })),
      ).toBe(true);
      expect(
        agentIsolationApplies(
          isolatedRequest({ ...asked, houseRuleSelection: disabledSelection() }),
        ),
      ).toBe(true);
    });

    it('is unchanged by a stored block at the top of a re-fed prompt', () => {
      const stored = withHouseRules(
        'Review the change set.',
        `${HOUSE_RULES_MARKER}\nRead .claude/agents/reviewer.md.\n${HOUSE_RULES_END}`,
      );
      const req = isolatedRequest();
      (req.input as { prompt: string }).prompt = stored;
      expect(agentIsolationApplies(req)).toBe(true);
    });

    it('still sees an agent path a marker quoted further down carries', () => {
      const req = isolatedRequest();
      (req.input as { prompt: string }).prompt =
        `Review.\n${HOUSE_RULES_MARKER}\nRead .claude/agents/reviewer.md.\n${HOUSE_RULES_END}`;
      expect(agentIsolationApplies(req)).toBe(false);
    });
  });
});
