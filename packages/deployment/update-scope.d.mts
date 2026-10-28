export function parseComponents(value?: string): 'all' | 'frontend' | 'backend' | 'management' | 'core';
export function reusedInputSha256(entries: { path: string; mode: string; oid: string }[], components: string, management?: Record<string, unknown>): string;
export function validateComponentUpdate(value: unknown): { schemaVersion: 1; components: 'backend' | 'management' | 'core'; reusedInputSha256: string; baseManifestSha256: string };
export function backendInputSha256(entries: { path: string; mode: string; oid: string }[]): string;
export function validateFrontendUpdate(value: unknown): { schemaVersion: 1; backendInputSha256: string; baseManifestSha256: string };
