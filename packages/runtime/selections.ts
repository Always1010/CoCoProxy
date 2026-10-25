import { request } from 'node:http';
import { canonicalJson } from '../config/index.ts';
import type { JsonObject, JsonValue } from '../config/index.ts';
import { RuntimeError } from './types.ts';

type Selection = { group: string; name: string };
const record = (value: JsonValue | undefined): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Every manual selection is deterministic on restart; cached choices are forbidden. */
export function manualSelections(config: JsonObject): Selection[] | null {
  if (!record(config.profile) || config.profile['store-selected'] !== false) return null;
  if (!Array.isArray(config['proxy-groups'])) return null;
  const choices: Selection[] = [];
  for (const value of config['proxy-groups']) {
    if (!record(value)) return null;
    if (value.type !== 'select') continue;
    if (typeof value.name !== 'string' || !Array.isArray(value.proxies) || value.proxies.length === 0 ||
        !value.proxies.every(name => typeof name === 'string') || new Set(value.proxies).size !== value.proxies.length || value.use !== undefined) return null;
    choices.push({ group: value.name, name: value.proxies[0] as string });
  }
  return choices;
}

/** Only reordering the same members of existing select groups can skip restart. */
export function selectionChanges(previous: JsonObject, target: JsonObject): Selection[] | null {
  const oldChoices = manualSelections(previous), choices = manualSelections(target);
  if (!oldChoices || !choices) return null;
  const normalize = (config: JsonObject): JsonObject => ({ ...config, 'proxy-groups': (config['proxy-groups'] as JsonValue[]).map(value => {
    if (!record(value) || value.type !== 'select') return value;
    return { ...value, proxies: [...value.proxies as string[]].sort() };
  }) });
  if (canonicalJson(normalize(previous)) !== canonicalJson(normalize(target))) return null;
  return choices.filter((choice, index) => choice.name !== oldChoices[index]?.name);
}

/** Fixed authenticated loopback requests; one deadline bounds headers and body. */
async function controller(port: number, secret: string, group?: string, name?: string): Promise<unknown> {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || typeof secret !== 'string' ||
      (group !== undefined && (typeof group !== 'string' || group.length > 256)) ||
      (name !== undefined && (group === undefined || typeof name !== 'string' || name.length > 256))) {
    throw new RuntimeError('CONTROLLER_SELECTION_FAILED');
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value?: unknown, failed = false) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (failed) reject(new RuntimeError('CONTROLLER_SELECTION_FAILED')); else resolve(value);
    };
    const body = name === undefined ? undefined : JSON.stringify({ name });
    const req = request({ hostname: '127.0.0.1', family: 4, port, path: group === undefined ? '/proxies' : `/proxies/${encodeURIComponent(group)}`,
      method: body === undefined ? 'GET' : 'PUT', agent: false,
      headers: { Authorization: `Bearer ${secret}`, Connection: 'close', ...(body === undefined ? {} : {
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }) } }, response => {
      const chunks: Buffer[] = []; let length = 0;
      const fail = () => { response.destroy(); req.destroy(); finish(undefined, true); };
      if (body === undefined ? response.statusCode !== 200 : response.statusCode !== 204) { fail(); return; }
      response.on('data', (chunk: Buffer) => { length += chunk.length; if (length > 16 * 1024 * 1024) fail(); else chunks.push(chunk); });
      response.on('error', () => finish(undefined, true)); response.on('aborted', () => finish(undefined, true));
      response.on('end', () => {
        try { finish(body === undefined ? JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) : undefined); }
        catch { finish(undefined, true); }
      });
    });
    const timer = setTimeout(() => { req.destroy(); finish(undefined, true); }, 1000);
    req.on('error', () => finish(undefined, true)); req.end(body);
  });
}

export async function setControllerSelection(port: number, secret: string, group: string, name: string): Promise<void> {
  await controller(port, secret, group, name);
}

export async function verifyControllerSelections(port: number, secret: string, selections: Selection[]): Promise<void> {
  const value = await controller(port, secret);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new RuntimeError('CONTROLLER_SELECTION_MISMATCH');
  const proxies = (value as Record<string, unknown>).proxies;
  if (proxies === null || typeof proxies !== 'object' || Array.isArray(proxies) || Object.keys(proxies).length > 6016) {
    throw new RuntimeError('CONTROLLER_SELECTION_MISMATCH');
  }
  for (const selection of selections) {
    const proxy = Object.hasOwn(proxies, selection.group) ? (proxies as Record<string, unknown>)[selection.group] : null;
    if (proxy === null || typeof proxy !== 'object' || Array.isArray(proxy) ||
        (proxy as Record<string, unknown>).type !== 'Selector' || (proxy as Record<string, unknown>).now !== selection.name) {
      throw new RuntimeError('CONTROLLER_SELECTION_MISMATCH');
    }
  }
}
