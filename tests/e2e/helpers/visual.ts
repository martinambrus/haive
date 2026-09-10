/**
 * The guard that keeps visual baselines meaningful.
 *
 * A screenshot comparison is only as stable as the thing that renders it, and this repo's dev host
 * (WSL2) and its CI runner (`ubuntu-latest`) do not render identically — different fonts and
 * hinting, despite both being "linux". `scripts/visual.sh` therefore runs this project inside a
 * pinned Playwright image on both sides, and sets HAIVE_VISUAL_RUNNER to say so.
 *
 * Without this guard, `playwright test --project=visual` run directly would compare
 * container-made baselines against host rendering and fail on antialiasing — or, far worse, be run
 * with `--update-snapshots` and quietly REPLACE good baselines with host-specific ones that then
 * fail for everybody else. Refusing to start is the cheap end of that.
 */
export function assertPinnedRunner(): void {
  if (process.env.HAIVE_VISUAL_RUNNER === '1') return;
  throw new Error(
    'The visual project must run inside the pinned Playwright image. Use `pnpm test:visual` ' +
      '(scripts/visual.sh), not `playwright test --project=visual` directly — baselines taken ' +
      'anywhere else are not comparable to the ones in CI.',
  );
}
