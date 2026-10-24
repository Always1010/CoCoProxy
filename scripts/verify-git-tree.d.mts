export class GitTreeError extends Error {
  readonly code: string;
  constructor(code: 'CLI_USAGE' | 'DIRECTORY_INVALID' | 'IO_ERROR' | 'MANIFEST_INPUT_INVALID' | 'MANIFEST_INVALID' | 'SIZE_LIMIT' | 'TREE_MISMATCH' | 'TREE_UNSTABLE');
}
export function verifyGitTree(directory: string, manifest: unknown): Promise<{ verified: true; commit: string; fileCount: number }>;
