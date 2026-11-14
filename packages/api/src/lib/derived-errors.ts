import { HttpError } from '../context.js';

export class DerivedTaskAdmissionError extends HttpError {
  constructor(readonly issues: readonly unknown[]) {
    super(409, 'The derived task type cannot be admitted', 'derived_admission_refused');
  }
}
