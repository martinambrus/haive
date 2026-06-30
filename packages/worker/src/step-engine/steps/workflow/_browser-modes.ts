export interface BrowserModeOption {
  value: string;
  label: string;
}

/** The browser-verification METHOD options, shared by 06-run-config / 08a (its form)
 *  and Gate-1 (the pre-answer) so the two never drift. Real browser testing needs a
 *  runner with a headed-browser desktop — the DDEV runner OR the env-replicate
 *  app-runner — so `mcp` + `interactive` are offered whenever `ddevMode ||
 *  appRunnerMode`. A project with no runner has nothing to test against, so only `skip`
 *  is offered.
 *
 *  Whether the MANUAL (`interactive`) gate is shown in-app (VNC) or as a URL for the
 *  user's OWN browser is a SEPARATE, earlier choice — the 01d-browser-access step's
 *  tasks.direct_access flag (resolveTaskDirectAccess), read at the gate — not a mode
 *  here. The agent's in-container browser (the fix-loop MCP checks) is unaffected. */
export function buildBrowserModeOptions(args: {
  ddevMode: boolean;
  appRunnerMode: boolean;
}): BrowserModeOption[] {
  const hasRunner = args.ddevMode || args.appRunnerMode;
  return [
    ...(hasRunner
      ? [
          {
            value: 'mcp',
            label:
              'Automated agent testing — the integration-tester drives the visible browser via Chrome DevTools (visual + functional)',
          },
          {
            value: 'interactive',
            label: 'Manual — you verify the running app yourself at Gate 2 (verification approval)',
          },
        ]
      : []),
    { value: 'skip', label: 'Skip browser testing' },
  ];
}
