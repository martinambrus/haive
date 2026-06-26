export interface BrowserModeOption {
  value: string;
  label: string;
}

/** The browser-verification mode options, shared by 08a (its own form) and Gate-1
 *  (the pre-answer) so the two never drift. Real browser testing needs a runner
 *  with a headed-browser desktop — the DDEV runner OR the env-replicate app-runner —
 *  so `mcp` + `interactive` are offered whenever `ddevMode || appRunnerMode`. A
 *  project with no runner has nothing to test against, so only `skip` is offered.
 *
 *  `direct` is a sibling of `interactive` (manual verification), offered only when
 *  direct browser access is enabled (`directAvailable`): the agent's in-container
 *  browser is unchanged (it still backs the implementation/fix-loop MCP checks), but
 *  the USER tests in their OWN browser via a published URL instead of the in-app VNC,
 *  so no VNC panel is shown. Behaviorally it runs the interactive gate. */
export function buildBrowserModeOptions(args: {
  ddevMode: boolean;
  appRunnerMode: boolean;
  directAvailable?: boolean;
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
            label: 'Manual — you drive the live browser yourself at Gate 2 (verification approval)',
          },
          ...(args.directAvailable
            ? [
                {
                  value: 'direct',
                  label:
                    'Manual — you test in your OWN browser at Gate 2 via a URL we provide (no in-app VNC)',
                },
              ]
            : []),
        ]
      : []),
    { value: 'skip', label: 'Skip browser testing' },
  ];
}
