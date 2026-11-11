// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { PostLoginRetryDialog } from './post-login-retry-dialog';
afterEach(cleanup);
it('3 names the retry prompt, closes on Escape and restores its opener', () => {
  function Scene() {
    const [step, setStep] = useState<string | null>(null);
    return (
      <>
        <button onClick={() => setStep('implementation')}>Complete login</button>
        <PostLoginRetryDialog stepId={step} onClose={() => setStep(null)} onRetry={() => {}} />
      </>
    );
  }
  render(<Scene />);
  const opener = screen.getByRole('button', { name: 'Complete login' });
  opener.focus();
  fireEvent.click(opener);
  expect(screen.getByRole('dialog', { name: 'Login successful' })).toBeTruthy();
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(opener);
});
it('retries only when Retry step is pressed', () => {
  const retry = vi.fn();
  const close = vi.fn();
  render(<PostLoginRetryDialog stepId="implementation" onClose={close} onRetry={retry} />);
  fireEvent.click(screen.getByRole('button', { name: 'Retry step' }));
  expect(retry).toHaveBeenCalledOnce();
  expect(close).not.toHaveBeenCalled();
});
