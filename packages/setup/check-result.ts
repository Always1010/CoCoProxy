export const EVIDENCE_STATUSES = ['pass', 'fail', 'unknown', 'not-run', 'not-applicable'] as const;
export type EvidenceStatus = typeof EVIDENCE_STATUSES[number];

/** Fixed, public explanations only; callers keep private observations outside this result. */
export interface EvidenceResult {
  id: string;
  code: string;
  status: EvidenceStatus;
  reason: string;
  action: string;
}
