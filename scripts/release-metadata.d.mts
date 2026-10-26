export class ReleaseMetadataError extends Error { readonly code: string; }
export function validateReleaseMetadata(catalog: any, review: any, tree: any): any;
export function validateReleaseVersion(pkg: any, lock: any, releaseTag: unknown): void;
export function validateReleaseTooling(catalog: any, tooling: any, lock: any): void;
