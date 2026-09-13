import { describe, expect, it } from 'vitest';
import { emptyMcpSurface, mcpSurfacePrompt } from '../src/sandbox/mcp-surface.js';

// MEASURED on `01-env-detect`, which runs with `disableTools: true` (`--tools ''`): the
// surface block told the model to "discover with grep / ripgrep instead", a fallback it has
// no shell to run. glm-5.3 followed it on two separate repos, answering with prose and a
// `cat wp-includes/version.php` block instead of the required JSON, three attempts each,
// until the retry budget was spent and the step fell back to deterministic detection. Other
// models ignored the instruction and answered from the prompt, which is what made a prompt
// contradiction look like one model being bad at the step.
describe('mcpSurfacePrompt with no built-in tools', () => {
  const noTools = () => mcpSurfacePrompt(emptyMcpSurface(), { noBuiltInTools: true });

  it('never offers grep or ripgrep to a run that has no shell', () => {
    const p = noTools();
    expect(p).not.toMatch(/ripgrep/i);
    expect(p).not.toMatch(/\bgrep\b/i);
  });

  it('says plainly that nothing is wired and where the answer comes from', () => {
    const p = noTools();
    expect(p).toContain('NO tools are wired into this run');
    expect(p).toContain('Answer from the material below');
  });

  it('prefers null over a guess, since the model cannot go and look', () => {
    expect(noTools()).toMatch(/emit null for that field rather than a guess/);
  });

  it('still gives the grep fallback to a run that DOES have built-in tools', () => {
    // The default path is unchanged: a rag-less step with a shell is told to grep, which is
    // the advice that made this block worth having in the first place.
    const p = mcpSurfacePrompt(emptyMcpSurface());
    expect(p).toMatch(/grep \/ ripgrep/);
    expect(p).not.toContain('NO tools are wired into this run');
  });
});
