export interface StageExplicitReleaseOptions {
  sourceDir: string;
  serverDir: string;
  runtimeDependencies: string;
  core: string;
  output: string;
  frontendUpdate?: { schemaVersion: 1 | 2; backendInputSha256: string; baseManifestSha256: string };
  componentUpdate?: { schemaVersion: 1 | 2; components: 'backend' | 'management' | 'core'; reusedInputSha256: string; baseManifestSha256: string };
  /** Code-only fixture override. Never supplied by deployment JSON or CLI. */
  reviewedCoreSha256?: string;
}
export class ReleaseStageError extends Error { readonly code: string; }
export function stageExplicitRelease(options: StageExplicitReleaseOptions): Promise<{
  staged: true; commit: string; fileCount: number; totalBytes: number; manifestSha256: string;
}>;
