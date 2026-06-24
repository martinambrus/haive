import { describe, it, expect } from 'vitest';
import { gate2VerifyApprovalStep } from './09-gate-2-verify-approval.js';

describe('gate-2 restartLoop diagnosis', () => {
  it('threads captured runtime errors into the reject diagnosis', () => {
    const r = gate2VerifyApprovalStep.restartLoop!.evaluate({
      decision: 'reject',
      feedback: 'homepage looks broken',
      auditFindings: [],
      runtimeErrors: 'Browser console errors:\n- Uncaught TypeError: x is not a function',
    } as never);
    expect(r).not.toBeNull();
    expect(r!.diagnosis).toContain('homepage looks broken');
    expect(r!.diagnosis).toContain('Uncaught TypeError');
    expect(r!.diagnosis.toLowerCase()).toContain('reproduce');
  });

  it('does not restart on approve', () => {
    expect(
      gate2VerifyApprovalStep.restartLoop!.evaluate({
        decision: 'approve',
        feedback: '',
        auditFindings: [],
        runtimeErrors: '',
      } as never),
    ).toBeNull();
  });
});
