import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { privateRead, atomicWrite } from '../storage/private-files.ts';
import { readAutomaticBindings, type AutomaticEvent } from './automatic-bindings.ts';
import { WorkspaceError } from './workspace.ts';

export const AUTOMATIC_HISTORY_LIMIT = 50;
export const AUTOMATIC_HISTORY_AGE = 7 * 24 * 60 * 60 * 1000;
export const AUTOMATIC_HISTORY_FILE_LIMIT = 8 * 1024 * 1024;
const FILE_LIMIT = AUTOMATIC_HISTORY_FILE_LIMIT;
type History = { version: 1; scopes: { scope: string; events: AutomaticEvent[] }[];
  clearedPending?: { scope: string; group: string; id: string; at: number }[] };

/** Keep each scheme/group independent; the byte ceiling also bounds unusually long names. */
export function retainAutomaticEvents(events: AutomaticEvent[], now = Date.now()): AutomaticEvent[] {
  const counts = new Map<string, number>();
  const ids = new Set<string>();
  return events.filter(event => event.at > now - AUTOMATIC_HISTORY_AGE)
    .sort((a, b) => a.at - b.at).reverse().filter(event => {
      if (event.id && ids.has(event.id)) return false;
      if (event.id) ids.add(event.id);
      const count = counts.get(event.group) ?? 0;
      counts.set(event.group, count + 1);
      return count < AUTOMATIC_HISTORY_LIMIT;
    }).reverse();
}

export function parseAutomaticHistory(input: unknown): History {
  try {
    const value = input as History;
    const name = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 1024 && !/[\x00-\x1f\x7f]/.test(v);
    if (value?.version !== 1 || !Array.isArray(value.scopes) || value.scopes.length > 1000 ||
        (value.clearedPending !== undefined && (!Array.isArray(value.clearedPending) || value.clearedPending.length > 1000 ||
          value.clearedPending.some(e => !e || typeof e.scope !== 'string' || e.scope.length > 16384 || !name(e.group) ||
            typeof e.id !== 'string' || !/^[a-f0-9-]{36}$/.test(e.id) || !Number.isFinite(e.at) || e.at < 0))) ||
        value.scopes.some(s => !s || typeof s.scope !== 'string' || s.scope.length > 16384 || !Array.isArray(s.events) || s.events.length > 50000 ||
          s.events.some(e => !e || typeof e.id !== 'string' || !/^[a-f0-9-]{36}$/.test(e.id) || !Number.isFinite(e.at) || e.at < 0 ||
            !name(e.group) || !name(e.from) || !name(e.to) || !name(e.reason) ||
            [e.fromPool, e.toPool].some(pool => pool !== undefined && pool !== 'preferred' && pool !== 'fallback')))) throw new Error();
    return value;
  } catch { throw new WorkspaceError('AUTO_HISTORY_CORRUPT'); }
}

/** All writes, including initial import and expiry, use the common transaction lock. */
export class AutomaticHistoryStore {
  private readonly root: string;
  constructor(root: string) { this.root = root; }

  async read(): Promise<History> {
    try {
      return parseAutomaticHistory(JSON.parse(await privateRead(join(this.root, 'automatic-history.json'), FILE_LIMIT)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new WorkspaceError('AUTO_HISTORY_CORRUPT');
      // Import legacy confirmed events once. An existing empty archive is authoritative after clear.
      const legacy = await readAutomaticBindings(this.root);
      return { version: 1, scopes: legacy ? [{ scope: legacy.scope, events: legacy.events.map(e => ({ ...e,
        id: e.id ?? createHash('sha256').update(JSON.stringify([legacy.scope, e])).digest('hex').slice(0, 36) })) }] : [] };
    }
  }

  async write(history: History): Promise<void> {
    const now = Date.now();
    history.scopes = history.scopes.map(s => ({ scope: s.scope, events: retainAutomaticEvents(s.events, now) })).filter(s => s.events.length);
    history.clearedPending = history.clearedPending?.filter(e => e.at > now - AUTOMATIC_HISTORY_AGE).slice(-1000);
    // Bound the whole archive as well as each group, evicting the oldest events first.
    let bytes = Buffer.byteLength(JSON.stringify(history));
    while (bytes > FILE_LIMIT || history.scopes.length > 1000) {
      const oldest = history.scopes.reduce<typeof history.scopes[number] | undefined>((a, b) => !a || b.events[0].at < a.events[0].at ? b : a, undefined);
      if (!oldest || (history.clearedPending?.length && history.clearedPending[0].at < oldest.events[0].at)) {
        bytes -= Buffer.byteLength(JSON.stringify(history.clearedPending!.shift())) + 1;
        continue;
      }
      bytes -= Buffer.byteLength(JSON.stringify(oldest.events.shift())) + 1;
      if (!oldest.events.length) history.scopes.splice(history.scopes.indexOf(oldest), 1);
    }
    const contents = JSON.stringify(history);
    try { if (await privateRead(join(this.root, 'automatic-history.json'), FILE_LIMIT) === contents) return; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await atomicWrite(this.root, 'automatic-history.json', contents);
  }

  async append(scope: string, event: AutomaticEvent): Promise<void> {
    const history = await this.read();
    if (history.clearedPending?.some(e => e.scope === scope && e.group === event.group && e.id === event.id)) return;
    let target = history.scopes.find(s => s.scope === scope);
    if (!target) history.scopes.push(target = { scope, events: [] });
    target.events = [...target.events.filter(e => e.id !== event.id), event];
    await this.write(history);
  }

  async clear(scope: string, group: string, pendingId?: string): Promise<void> {
    const history = await this.read();
    const target = history.scopes.find(s => s.scope === scope);
    if (target) target.events = target.events.filter(e => e.group !== group);
    if (pendingId) history.clearedPending = [...(history.clearedPending ?? []).filter(e => e.scope !== scope || e.group !== group),
      { scope, group, id: pendingId, at: Date.now() }];
    await this.write(history);
  }
}
