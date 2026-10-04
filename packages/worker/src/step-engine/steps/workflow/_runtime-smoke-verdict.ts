/** A 4xx can be an access wall or a broken route. It proves neither health nor a
 *  defect unless the probe also found a runtime-error signature (`passed:false`).
 *  Reclassify legacy 4xx passes here too: parked gates replay persisted payloads. */
export function runtimeSmokeVerdict(smoke: {
  ran: boolean;
  passed: boolean | null;
  httpStatus: number | null;
}): 'pass' | 'fail' | 'unsure' | 'skip' {
  if (!smoke.ran) return 'skip';
  if (smoke.passed === false) return 'fail';
  if (smoke.httpStatus !== null && smoke.httpStatus >= 400 && smoke.httpStatus < 500)
    return 'unsure';
  return smoke.passed === true ? 'pass' : 'unsure';
}
