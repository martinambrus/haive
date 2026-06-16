export interface BrowserModeOption {
  value: string;
  label: string;
}

/** The browser-verification mode options, shared by 08a (its own form) and Gate-1
 *  (the pre-answer) so the two never drift. `mcp` and `interactive` both need a
 *  runner with a headed-browser desktop — the DDEV runner OR the env-replicate
 *  app-runner — so both are offered whenever `ddevMode || appRunnerMode`. `headless`
 *  (no runner needed) + `skip` are always available. */
export function buildBrowserModeOptions(args: {
  ddevMode: boolean;
  appRunnerMode: boolean;
}): BrowserModeOption[] {
  const hasRunner = args.ddevMode || args.appRunnerMode;
  return [
    {
      value: 'headless',
      label: 'Automated checks — HTTP status, console & network errors (no runner needed)',
    },
    ...(hasRunner
      ? [
          {
            value: 'mcp',
            label:
              'Automated agent testing — the integration-tester drives the visible browser via Chrome DevTools (visual + functional)',
          },
          {
            value: 'interactive',
            label: 'Interactive testing — you drive the headed Chrome in the Browser panel',
          },
        ]
      : []),
    { value: 'skip', label: 'Skip browser testing' },
  ];
}
