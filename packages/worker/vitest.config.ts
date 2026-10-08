import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Git-spawning tests pass 5 s on a loaded host; a hung test still fails, later.
  test: { testTimeout: 20_000 },
});
