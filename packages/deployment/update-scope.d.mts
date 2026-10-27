export function parseComponents(value?: string): 'all' | 'frontend' | 'backend';
export function reusedInputSha256(entries: { path: string; mode: string; oid: string }[], components: string): string;
export function validateComponentUpdate(value: unknown): { schemaVersion: 1; components: 'backend'; reusedInputSha256: string; baseManifestSha256: string };
export function backendInputSha256(entries: { path: string; mode: string; oid: string }[]): string;
export function validateFrontendUpdate(value: unknown): { schemaVersion: 1; backendInputSha256: string; baseManifestSha256: string };
