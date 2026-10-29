export function parseComponents(value?: string): 'all' | 'frontend' | 'backend' | 'management' | 'core';
export function validateComponentUpdate(value: unknown): { schemaVersion: 1 | 2; components: 'backend' | 'management' | 'core'; reusedInputSha256: string; baseManifestSha256: string };
export function validateFrontendUpdate(value: unknown): { schemaVersion: 1 | 2; backendInputSha256: string; baseManifestSha256: string };
export const INPUT_SCHEMA_VERSION: 2;
export interface InputRecord { path: string; field?: string; mode: string; oid: string; scope: 'frontend' | 'backend' | 'shared' | 'ignored' | 'metadata' }
export interface BuildInputs { schemaVersion: 2; backendInputSha256: string; frontendInputSha256: string; serverInputSha256: string; inputs: InputRecord[] }
export function createBuildInputs(entries: { path: string; mode: string; oid: string }[], readBlob: (entry: { path: string; mode: string; oid: string }) => Promise<Uint8Array | string>): Promise<BuildInputs>;
export function validateBuildInputs(value: unknown): BuildInputs;
