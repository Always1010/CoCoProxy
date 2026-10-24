export class RuntimeError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'RuntimeError'; this.code = code; }
}

/** Trusted deployment data; never accepted as a browser request. */
export interface RuntimeSettings {
  schemaVersion: 1;
  stateDirectory: string;
  binaryPath: string;
  binarySha256: string;
  systemctlPath: string;
  unitPath: string;
  unitSha256: string;
  serviceUid: number;
}

export interface RuntimeUnitState {
  loadState: string;
  activeState: string;
  subState: string;
  mainPid: number;
  jobPending: boolean;
  fragmentPath: string;
  hasDropIns: boolean;
  needsReload: boolean;
  user: string;
}

/** Describes only core readiness. DNS/capture/egress need independent evidence. */
export interface CoreObservation {
  ready: boolean;
  generation: string;
  checkedAt: string;
  reason: string | null;
}
