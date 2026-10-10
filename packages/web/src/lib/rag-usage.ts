import type { RagUsageAssessment } from './api-client';

export function ragUsageStyle(assessment?: RagUsageAssessment | null) {
  switch (assessment?.status) {
    case 'used':
      return { label: 'Used', className: 'bg-emerald-500/10', title: assessment.reason };
    case 'unused':
      return { label: 'Unused', className: 'bg-amber-500/10', title: assessment.reason };
    case 'unknown':
      return { label: 'Unclear', className: '', title: assessment.reason };
    default:
      return {
        label: 'Not assessed',
        className: '',
        title: 'Reviewed when the workflow finalizes.',
      };
  }
}
