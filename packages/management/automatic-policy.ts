// Older policies omit enabled and remain active.
export type AutoGroupPolicy = { enabled?: boolean; preferred: string[]; fallback: string[]; returnToPreferred: boolean };
export type ProbeTarget = { url: string; expectedStatus: number };
export type AutoProbeSettings = { primary: ProbeTarget; secondary: ProbeTarget; timeoutMs: number; slowMs: number };

export const DEFAULT_AUTO_PROBES: AutoProbeSettings = {
  primary: { url: 'https://www.gstatic.com/generate_204', expectedStatus: 204 },
  secondary: { url: 'https://cp.cloudflare.com/generate_204', expectedStatus: 204 },
  timeoutMs: 3000, slowMs: 1500,
};

export class AutomaticSettingsError extends Error {
  readonly code = 'AUTO_SETTINGS_INVALID';
  constructor() { super('Automatic selection settings are invalid.'); this.name = 'AutomaticSettingsError'; }
}

function invalid(): never { throw new AutomaticSettingsError(); }
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some(key => !keys.includes(key))) return invalid();
  return object;
}

/** Node existence and group aliases are checked against the active configuration by the adapter. */
export function parseAutoGroupPolicy(value: unknown): AutoGroupPolicy {
  const input = record(value, ['enabled', 'preferred', 'fallback', 'returnToPreferred']);
  if ('enabled' in input && typeof input.enabled !== 'boolean') return invalid();
  const names = (value: unknown): string[] => {
    if (!Array.isArray(value) || value.some(name => typeof name !== 'string' || !name.trim()
      || name !== name.trim() || name.length > 256 || /[\u0000-\u001f\u007f]/u.test(name)
      || /^(DIRECT|REJECT|REJECT-DROP|PASS|COMPATIBLE)$/iu.test(name))) return invalid();
    return [...value] as string[];
  };
  const preferred = names(input.preferred), fallback = names(input.fallback);
  const all = [...preferred, ...fallback];
  if ((!preferred.length && input.enabled !== false) || all.length > 32 || new Set(all).size !== all.length || typeof input.returnToPreferred !== 'boolean') return invalid();
  return { ...('enabled' in input ? { enabled: input.enabled as boolean } : {}), preferred, fallback, returnToPreferred: input.returnToPreferred };
}

export function parseAutoProbeSettings(value: unknown): AutoProbeSettings {
  const input = record(value, ['primary', 'secondary', 'timeoutMs', 'slowMs']);
  const target = (value: unknown): ProbeTarget => {
    const input = record(value, ['url', 'expectedStatus']);
    if (typeof input.url !== 'string' || input.url.length > 2048 || !Number.isInteger(input.expectedStatus)
      || Number(input.expectedStatus) < 100 || Number(input.expectedStatus) > 599) return invalid();
    let url: URL;
    try { url = new URL(input.url); } catch { return invalid(); }
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash || url.search
      || input.url.includes('?') || input.url.includes('#')) return invalid();
    return { url: url.href, expectedStatus: input.expectedStatus as number };
  };
  if (!Number.isInteger(input.timeoutMs) || Number(input.timeoutMs) < 1000 || Number(input.timeoutMs) > 10000
    || !Number.isInteger(input.slowMs) || Number(input.slowMs) < 500 || Number(input.slowMs) > 10000) return invalid();
  return { primary: target(input.primary), secondary: target(input.secondary), timeoutMs: input.timeoutMs as number, slowMs: input.slowMs as number };
}
