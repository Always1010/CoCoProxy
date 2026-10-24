export class OverlayError extends Error {
  readonly code: string;
  constructor(code: string);
}
export function applyMetacubexdOverlay(directory: string, options?: {
  overlayDirectory?: string;
  manifestPath?: string;
}): Promise<{ commit: string; checked: number; written: number; unchanged: number }>;
