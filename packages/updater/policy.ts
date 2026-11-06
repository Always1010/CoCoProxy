import { UpdateError } from './types.ts';

export interface UpdateSettings {
  schemaVersion: 1;
  enabled: boolean;
  intervalDays: number;
  timeZone: string;
  windowStart: string;
  windowEnd: string;
}

export const DEFAULT_UPDATE_SETTINGS: Readonly<UpdateSettings> = Object.freeze({ schemaVersion: 1, enabled: false,
  intervalDays: 7, timeZone: 'Asia/Shanghai', windowStart: '03:00', windowEnd: '05:00' });
const MINUTE = 60_000;
const DAY = 1440 * MINUTE;
const clocks = new Map<string, Intl.DateTimeFormat>();
const fail = (): never => { throw new UpdateError('UPDATER_SETTINGS_INVALID'); };

export function parseUpdateSettings(input: unknown): UpdateSettings {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail();
  const fields = Object.getOwnPropertyDescriptors(input);
  const keys = ['schemaVersion', 'enabled', 'intervalDays', 'timeZone', 'windowStart', 'windowEnd'];
  if (Reflect.ownKeys(fields).length !== keys.length || keys.some(key => !fields[key]?.enumerable || !('value' in fields[key]))) fail();
  const value = Object.fromEntries(keys.map(key => [key, fields[key].value]));
  if (value.schemaVersion !== 1 || typeof value.enabled !== 'boolean' || !Number.isInteger(value.intervalDays)
    || value.intervalDays < 1 || value.intervalDays > 365 || typeof value.timeZone !== 'string' || value.timeZone.length > 80
    || !/^[A-Za-z][A-Za-z0-9_+./-]*$/.test(value.timeZone)) fail();
  for (const key of ['windowStart', 'windowEnd']) if (typeof value[key] !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value[key])) fail();
  if (value.windowStart === value.windowEnd) fail();
  try { clock(value.timeZone); } catch { fail(); }
  return value as unknown as UpdateSettings;
}

function clock(timeZone: string) {
  let formatter = clocks.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    // Do not let invalid client zones grow an unbounded cache.
    if (clocks.size >= 32) clocks.clear();
    clocks.set(timeZone, formatter);
  }
  return formatter;
}

function parts(at: number, timeZone: string): Record<string, string> {
  return Object.fromEntries(clock(timeZone).formatToParts(at).filter(item => item.type !== 'literal').map(item => [item.type, item.value]));
}
export function localDate(at: number, timeZone: string): string {
  const p = parts(at, timeZone); return `${p.year}-${p.month}-${p.day}`;
}
export function addDays(date: string, days: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new UpdateError('UPDATER_STATE_INVALID', 503);
  const value = Date.parse(date + 'T00:00:00Z');
  if (!Number.isFinite(value) || new Date(value).toISOString().slice(0, 10) !== date) throw new UpdateError('UPDATER_STATE_INVALID', 503);
  return new Date(value + days * DAY).toISOString().slice(0, 10);
}
const minutes = (value: string): number => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));

/** Resolve wall time against both sides of a DST change. Missing minutes move forward. */
function instant(date: string, minute: number, timeZone: string, end = false): number {
  const naive = Date.parse(date + 'T00:00:00Z') + minute * MINUTE;
  const offsets = new Set<number>();
  for (const delta of [-36, -12, 0, 12, 36]) {
    const at = naive + delta * 3600_000, p = parts(at, timeZone);
    offsets.add(Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`) - at);
  }
  for (let shift = 0; shift <= 180; shift++) {
    const wall = naive + shift * MINUTE;
    const matches: number[] = [];
    for (const offset of offsets) {
      const at = wall - offset, p = parts(at, timeZone);
      if (Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`) === wall) matches.push(at);
    }
    if (matches.length) return end ? Math.max(...matches) : Math.min(...matches);
  }
  throw new UpdateError('UPDATER_TIME_UNAVAILABLE', 503);
}

export interface UpdateWindow { date: string; start: number; end: number }
export function updateWindow(date: string, settings: UpdateSettings): UpdateWindow {
  addDays(date, 0);
  const start = instant(date, minutes(settings.windowStart), settings.timeZone);
  const end = instant(minutes(settings.windowEnd) <= minutes(settings.windowStart) ? addDays(date, 1) : date,
    minutes(settings.windowEnd), settings.timeZone, true);
  return { date, start, end };
}

/** A missed due date catches up once in the next daily permitted window. */
export function nextUpdateWindow(at: number, dueDate: string | null, settings: UpdateSettings): UpdateWindow {
  const today = localDate(at, settings.timeZone);
  const previous = updateWindow(addDays(today, -1), settings);
  if ((!dueDate || previous.date >= dueDate) && at >= previous.start && at < previous.end) return previous;
  let date = dueDate && dueDate > today ? addDays(dueDate, 0) : today;
  let window = updateWindow(date, settings);
  if (at >= window.end) { date = addDays(date, 1); window = updateWindow(date, settings); }
  return window;
}

export function scheduleChanged(before: UpdateSettings, after: UpdateSettings): boolean {
  return before.enabled !== after.enabled || before.intervalDays !== after.intervalDays || before.timeZone !== after.timeZone
    || before.windowStart !== after.windowStart || before.windowEnd !== after.windowEnd;
}
