import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { FileTransactionStore } from '../transaction/index.ts';
import { atomicWrite, inspectPrivateDirectory, privateRead } from '../storage/private-files.ts';
import { ManagementError, exactRecord } from './http.ts';
import type { Workspace } from './workspace.ts';

export type SiteTarget = { id: string; name: string; url: string; category: string };
export const BUILTIN_SITE_TARGETS: readonly SiteTarget[] = [
  ['google', 'Google', 'https://www.gstatic.com/generate_204', '常用'],
  ['cloudflare', 'Cloudflare', 'https://cp.cloudflare.com/generate_204', '常用'],
  ['github', 'GitHub', 'https://github.com/', '常用'],
  ['openai', 'OpenAI', 'https://chatgpt.com/', 'AI'],
  ['claude', 'Claude', 'https://claude.ai/', 'AI'],
  ['gemini', 'Gemini', 'https://gemini.google.com/', 'AI'],
  ['youtube', 'YouTube', 'https://www.youtube.com/generate_204', '视频与社交'],
  ['netflix', 'Netflix', 'https://www.netflix.com/', '视频与社交'],
  ['disney', 'Disney+', 'https://www.disneyplus.com/', '视频与社交'],
  ['tiktok', 'TikTok', 'https://www.tiktok.com/', '视频与社交'],
  ['x', 'X', 'https://x.com/', '视频与社交'],
  ['telegram', 'Telegram', 'https://telegram.org/', '视频与社交'],
  ['microsoft', 'Microsoft', 'https://www.microsoft.com/', '更多服务'],
  ['apple', 'Apple', 'https://www.apple.com/', '更多服务'],
  ['meta', 'Meta', 'https://www.meta.com/', '更多服务'],
  ['discord', 'Discord', 'https://discord.com/', '更多服务'],
  ['steam', 'Steam', 'https://store.steampowered.com/', '更多服务'],
].map(([id, name, url, category]) => ({ id: id!, name: name!, url: url!, category: category! }));

export type SiteSettings = { version: 1; revision: number; custom: SiteTarget[]; groups: Record<string, Record<string, string[]>> };
const fail = (code = 'SITE_SETTINGS_INVALID'): never => { throw new ManagementError(code, /CONFLICT|IN_USE/.test(code) ? 409 : 400); };
const safeName = (value: unknown, limit = 256): value is string => typeof value === 'string' && value.length > 0 && value.length <= limit &&
  !/[\x00-\x1f\x7f]/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);
const record = (input: unknown): Record<string, unknown> => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail();
  return input as Record<string, unknown>;
};

/** Registered HTTPS targets are explicit admin choices; raw arbitrary probe URLs remain denied. */
export function siteUrl(input: unknown): string {
  if (typeof input !== 'string' || input.length > 2048 || /[\s\x00-\x1f\x7f]/.test(input)) return fail();
  let url: URL;
  try { url = new URL(input); } catch { return fail(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port || isIP(url.hostname) ||
      !url.hostname.includes('.') || /(^|\.)(localhost|local|internal|test|invalid)$/.test(url.hostname) ||
      !/^[a-z0-9.-]+$/.test(url.hostname)) return fail();
  return url.href;
}

export const siteScope = (workspace: Pick<Workspace, 'mode' | 'subscriptionId' | 'sourceIds'>): string => createHash('sha256')
  .update(JSON.stringify([workspace.mode, workspace.mode === 'subscription' ? workspace.subscriptionId : [...workspace.sourceIds].sort()])).digest('hex');

function parse(input: unknown): SiteSettings {
  const data = exactRecord(input, ['version', 'revision', 'custom', 'groups']);
  if (data.version !== 1 || !Number.isSafeInteger(data.revision) || (data.revision as number) < 0 ||
      !Array.isArray(data.custom) || data.custom.length > 32) return fail();
  const custom = data.custom.map(input => {
    const target = exactRecord(input, ['id', 'name', 'url', 'category']);
    if (typeof target.id !== 'string' || !/^custom-[a-f0-9-]{36}$/.test(target.id) || !safeName(target.name, 80) || target.category !== '自定义') return fail();
    return { id: target.id, name: target.name, url: siteUrl(target.url), category: '自定义' };
  });
  const ids = new Set([...BUILTIN_SITE_TARGETS, ...custom].map(target => target.id));
  if (ids.size !== BUILTIN_SITE_TARGETS.length + custom.length || new Set([...BUILTIN_SITE_TARGETS, ...custom].map(target => target.url)).size !== ids.size) return fail();
  const groups = record(data.groups);
  if (Object.keys(groups).length > 128) return fail();
  for (const [scope, input] of Object.entries(groups)) {
    if (!/^[a-f0-9]{64}$/.test(scope)) return fail();
    const selections = record(input);
    if (Object.keys(selections).length > 100) return fail();
    for (const [group, selected] of Object.entries(selections)) {
      if (!safeName(group, 1024) || !Array.isArray(selected) || selected.length > 16 || new Set(selected).size !== selected.length ||
          selected.some(id => typeof id !== 'string' || !ids.has(id))) return fail();
    }
  }
  return { version: 1, revision: data.revision as number, custom, groups: groups as SiteSettings['groups'] };
}

/** Separate from routing preferences: saving detection choices never applies/restarts a core. */
export class SiteProbeStore {
  readonly files: FileTransactionStore;
  readonly enabled: boolean;
  constructor(root: string, enabled = true) { this.files = new FileTransactionStore(root); this.enabled = enabled; }
  targets(settings: SiteSettings): SiteTarget[] { return [...BUILTIN_SITE_TARGETS, ...settings.custom]; }
  async read(): Promise<SiteSettings> {
    try {
      await inspectPrivateDirectory(this.files.root);
      return parse(JSON.parse(await privateRead(join(this.files.root, 'site-probes.json'), 1_048_576)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, revision: 0, custom: [], groups: {} };
      throw new ManagementError('SITE_SETTINGS_CORRUPT', 503);
    }
  }
  async allowedUrls(): Promise<string[]> { return this.enabled ? this.targets(await this.read()).map(target => target.url) : []; }
  async update(expectedRevision: unknown, change: (settings: SiteSettings) => void | Promise<void>): Promise<SiteSettings> {
    if (!Number.isSafeInteger(expectedRevision) || (expectedRevision as number) < 0 || (expectedRevision as number) >= Number.MAX_SAFE_INTEGER) return fail();
    const result = await this.files.exclusive(async (): Promise<{ value: SiteSettings } | { error: unknown }> => {
      try {
      const settings = await this.read();
      if (settings.revision !== expectedRevision) return fail('SITE_SETTINGS_CONFLICT');
      await change(settings);
      settings.revision++;
      const checked = parse(settings);
      const contents = JSON.stringify(checked);
      if (Buffer.byteLength(contents) > 1_048_576) return fail();
      await atomicWrite(this.files.root, 'site-probes.json', contents);
      return { value: checked };
      } catch (error) { return { error }; }
    });
    if ('error' in result) throw result.error;
    return result.value;
  }
  add(settings: SiteSettings, name: unknown, input: unknown): SiteTarget {
    if (!safeName(name, 80) || name.trim() !== name || settings.custom.length >= 32) return fail();
    const target = { id: `custom-${randomUUID()}`, name, url: siteUrl(input), category: '自定义' };
    if (!this.enabled) return fail('SITE_TARGET_DENIED');
    if (this.targets(settings).some(item => item.url === target.url)) return fail('SITE_TARGET_DUPLICATE');
    settings.custom.push(target);
    return target;
  }
}

export { parse as parseSiteProbeState };
