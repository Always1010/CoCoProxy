export function parseComponents(value?: string): 'all' | 'frontend';
export function backendInputSha256(entries: { path: string; mode: string; oid: string }[]): string;
export function validateFrontendUpdate(value: unknown): { schemaVersion: 1; backendInputSha256: string; baseManifestSha256: string };
