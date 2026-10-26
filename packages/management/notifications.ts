import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { atomicWrite, inspectPrivateDirectory, privateDirectory, privateRead } from '../storage/private-files.ts';
import { exactRecord, ManagementError, readJsonBody, type Principal } from './http.ts';
import type { TrustedDeviceStore } from './trusted-devices.ts';
import { generatePushKeys, parsePushSubscription, pushTopic, sendWebPush, type PushKeys, type PushSend, type PushSubscription } from './web-push.ts';

export type NotificationEvent = { id: string; at: number; scope: string; group: string; from: string; to: string; reason: string };
type Preferences = { groups: string[] | null; switches: boolean; recovery: boolean; outage: boolean; showNodes: boolean };
type Subscription = { deviceId: string; subscription: PushSubscription; preferences: Preferences; revision: string; status: string; lastAt: number; testAt: number };
type Job = { id: string; deviceId: string; revision: string; event: NotificationEvent; due: number; attempts: number; expires: number };
type State = { version: 1; keys: PushKeys | null; events: NotificationEvent[]; subscriptions: Subscription[]; jobs: Job[]; phases: Record<string, boolean> };
type Source = { scope: string; events: (Omit<NotificationEvent, 'scope' | 'id'> & { id?: string })[]; groups: { name: string; current: string; phase: string; reason?: string | null; health?: 'unknown' | 'healthy' | 'unavailable' }[] };
const defaults: Preferences = { groups: null, switches: true, recovery: true, outage: true, showNodes: false };
const empty = (): State => ({ version: 1, keys: null, events: [], subscriptions: [], jobs: [], phases: {} });
const text = (value: unknown, size = 1024): value is string => typeof value === 'string' && value.length <= size && !/[\u0000-\u001f\u007f]/.test(value);
function fail(code = 'NOTIFICATIONS_UNAVAILABLE', status = 503): never { throw new ManagementError(code, status); }
const validEvent = (e: NotificationEvent) => e && text(e.id, 128) && text(e.scope, 16384) && text(e.group) && text(e.from) && text(e.to) && text(e.reason, 80) && Number.isSafeInteger(e.at) && e.at >= 0;
function preferences(input: unknown): Preferences {
  const p = exactRecord(input, ['groups', 'switches', 'recovery', 'outage', 'showNodes']);
  if (p.groups !== null && (!Array.isArray(p.groups) || p.groups.length > 100 || p.groups.some(group => !text(group, 256) || !group) || new Set(p.groups).size !== p.groups.length)) fail('NOTIFICATION_PREFERENCES_INVALID', 400);
  if (['switches', 'recovery', 'outage', 'showNodes'].some(key => typeof p[key] !== 'boolean')) fail('NOTIFICATION_PREFERENCES_INVALID', 400);
  return p as Preferences;
}
function parseState(input: unknown): State {
  const s = exactRecord(input, ['version', 'keys', 'events', 'subscriptions', 'jobs', 'phases']) as unknown as State;
  if (s.version !== 1 || !Array.isArray(s.events) || s.events.length > 200 || s.events.some(e => !validEvent(e)) ||
      !Array.isArray(s.subscriptions) || s.subscriptions.length > 128 || !Array.isArray(s.jobs) || s.jobs.length > 256 ||
      !s.phases || typeof s.phases !== 'object' || Array.isArray(s.phases) || Object.keys(s.phases).length > 100 || Object.values(s.phases).some(v => typeof v !== 'boolean')) fail();
  if (s.keys !== null && (typeof s.keys !== 'object' || !s.keys || !/^[A-Za-z0-9_-]{87}$/.test(s.keys.publicKey) || !/^[A-Za-z0-9_-]{43}$/.test(s.keys.privateKey))) fail();
  const ids = new Set<string>();
  for (const item of s.subscriptions) {
    if (!item || !/^[a-f0-9]{32}$/.test(item.deviceId) || ids.has(item.deviceId) || !text(item.revision, 64) || !text(item.status, 80) || !Number.isSafeInteger(item.lastAt) || !Number.isSafeInteger(item.testAt)) fail();
    ids.add(item.deviceId); parsePushSubscription(item.subscription); preferences(item.preferences);
  }
  for (const job of s.jobs) if (!job || !validEvent(job.event) || !text(job.id, 128) || !/^[a-f0-9]{32}$/.test(job.deviceId) || !text(job.revision, 64) || !Number.isSafeInteger(job.due) || !Number.isSafeInteger(job.expires) || !Number.isSafeInteger(job.attempts) || job.attempts < 0 || job.attempts > 10) fail();
  return s;
}

export function notificationMessage(event: NotificationEvent, showNodes: boolean) {
  const group = event.group.slice(0, 96);
  const words: Record<string, string> = { 'preferred-restored': '首选节点稳定恢复，已自动回切', 'failure-recovery': '原线路不可用，已恢复可用出口', 'faster-candidate': '原线路持续缓慢，已自动切换', 'all-unavailable': '候选节点暂无可用出口，正在等待恢复', 'available-again': '已恢复可用出口', test: '这是一条测试通知，请确认此设备是否显示提醒' };
  const detail = words[event.reason] ?? '已确认自动切换出口';
  return { title: event.reason === 'test' ? 'CoCoProxy · 测试通知' : `CoCoProxy · ${group}`,
    body: `${detail}${showNodes && event.to ? `（${event.to.slice(0, 96)}）` : ''} · ${new Date(event.at).toISOString().slice(11, 19)} UTC`,
    id: event.id, at: event.at, tag: 'cocoproxy-' + pushTopic(event.scope, event.group), url: '/#/cocoproxy', expiresAt: event.at + 300_000 };
}

/** One bounded worker, private durable outbox; sending never holds the configuration lock. */
export async function createNotifications(options: { stateDirectory: string; origin: string; devices: TrustedDeviceStore; source: () => Promise<Source>; send?: PushSend; now?: () => number }) {
  const directory = join(options.stateDirectory, 'notifications');
  const now = options.now ?? Date.now;
  let state = empty(), broken = false, closed = false, running: Promise<void> | null = null;
  let mutations: Promise<unknown> = Promise.resolve(), timer: ReturnType<typeof setInterval> | undefined;
  let availableGroups: string[] = [], globalError: string | null = null;
  const epoch = options.devices.bindingFingerprint();
  try {
    await inspectPrivateDirectory(options.stateDirectory); await inspectPrivateDirectory(directory);
    const envelope = exactRecord(JSON.parse(await privateRead(join(directory, 'state.json'), 2 * 1024 * 1024)), ['epoch', 'state']);
    const loaded = parseState(envelope.state);
    state = envelope.epoch === epoch ? loaded : empty();
  } catch (error) { if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') broken = true; }
  async function mutate<T>(operation: (next: State) => T): Promise<T> {
    const pending = mutations.then(async () => {
      if (broken) fail();
      const next = structuredClone(state), result = operation(next);
      const bytes = JSON.stringify({ epoch, state: next });
      if (Buffer.byteLength(bytes) > 2 * 1024 * 1024) fail('NOTIFICATION_STORE_LIMIT');
      await privateDirectory(options.stateDirectory); await privateDirectory(directory);
      await atomicWrite(directory, 'state.json', bytes); state = next; return result;
    });
    mutations = pending.catch(() => {}); return pending;
  }
  function wanted(sub: Subscription, event: NotificationEvent) {
    const p = sub.preferences;
    return (p.groups === null || p.groups.includes(event.group)) &&
      (event.reason === 'all-unavailable' ? p.outage : ['available-again', 'preferred-restored'].includes(event.reason) ? p.recovery : p.switches);
  }
  function add(next: State, event: NotificationEvent, testDevice?: string) {
    if (next.events.some(e => e.id === event.id)) return;
    next.events = [...next.events, event].slice(-200);
    if (event.at + 300_000 <= now()) return;
    for (const sub of next.subscriptions) {
      if (sub.status === 'expired' || !options.devices.has(sub.deviceId) || (testDevice ? sub.deviceId !== testDevice : !wanted(sub, event))) continue;
      // Same group replaces its older queued state; the history retains every event.
      next.jobs = next.jobs.filter(job => !(job.deviceId === sub.deviceId && job.event.scope === event.scope && job.event.group === event.group));
      next.jobs.push({ id: randomUUID(), deviceId: sub.deviceId, revision: sub.revision, event,
        due: now() + (testDevice ? 0 : 10_000), expires: event.at + 300_000, attempts: 0 });
    }
    next.jobs = next.jobs.slice(-256);
  }
  async function synchronize() {
    const source = await options.source(); availableGroups = source.groups.map(g => g.name);
    const changes = source.events.map(e => ({ ...e, scope: source.scope, id: e.id ?? createHash('sha256').update(JSON.stringify([source.scope, e])).digest('hex') }));
    const phases: Record<string, boolean> = Object.create(null);
    for (const group of source.groups) {
      const key = pushTopic(source.scope, group.name), outage = group.phase === 'outage';
      phases[key] = outage;
      if (outage && state.phases[key] !== true) changes.push({ id: randomUUID(), at: now(), scope: source.scope, group: group.name, from: group.current, to: '', reason: 'all-unavailable' });
      else if (state.phases[key] === true && ['monitoring', 'backup'].includes(group.phase) && (group.health === 'healthy' || group.health === undefined && group.reason === 'failure-recovery')) {
        changes.push({ id: randomUUID(), at: now(), scope: source.scope, group: group.name, from: '', to: group.current, reason: 'available-again' });
      } else if (state.phases[key] === true && !outage) phases[key] = true;
    }
    const changed = changes.some(e => !state.events.some(old => old.id === e.id)) || JSON.stringify(phases) !== JSON.stringify(state.phases);
    const invalid = state.subscriptions.some(s => !options.devices.has(s.deviceId));
    if (!changed && !invalid) return;
    await mutate(next => {
      next.subscriptions = next.subscriptions.filter(s => options.devices.has(s.deviceId));
      next.jobs = next.jobs.filter(j => options.devices.has(j.deviceId));
      for (const event of changes) add(next, event);
      next.phases = phases;
    });
  }
  async function run() {
    if (closed || broken) return;
    try { await synchronize(); globalError = null; }
    catch { globalError = 'NOTIFICATION_RECORD_UNAVAILABLE'; }
    const jobs = state.jobs.filter(job => job.due <= now()).slice(0, 2);
    await Promise.all(jobs.map(async job => {
      const sub = state.subscriptions.find(s => s.deviceId === job.deviceId && s.revision === job.revision);
      if (!sub || !options.devices.has(job.deviceId) || job.expires <= now() || !state.keys) {
        await mutate(next => { next.jobs = next.jobs.filter(j => j.id !== job.id); }); return;
      }
      let reply;
      try { reply = await (options.send ?? sendWebPush)(sub.subscription, JSON.stringify(notificationMessage(job.event, sub.preferences.showNodes)), state.keys, options.origin, Math.max(1, Math.floor((job.expires - now()) / 1000)), pushTopic(job.event.scope, job.event.group)); }
      catch { reply = { status: 0, code: 'PUSH_NETWORK_ERROR' }; }
      await mutate(next => {
        const live = next.subscriptions.find(s => s.deviceId === job.deviceId && s.revision === job.revision);
        if (!live) return;
        live.lastAt = now();
        if (reply.status >= 200 && reply.status < 300) { live.status = 'accepted'; next.jobs = next.jobs.filter(j => j.id !== job.id); }
        else if ([404, 410].includes(reply.status)) { live.status = 'expired'; next.jobs = next.jobs.filter(j => j.deviceId !== job.deviceId); }
        else if ([400, 401, 403, 413].includes(reply.status) || ['PUSH_LIBRARY_UNAVAILABLE', 'PUSH_CONFIGURATION_ERROR'].includes(reply.code ?? '')) {
          live.status = reply.code ?? 'PUSH_CONFIGURATION_ERROR'; next.jobs = next.jobs.filter(j => j.id !== job.id);
        } else {
          live.status = 'retrying';
          const queued = next.jobs.find(j => j.id === job.id);
          if (queued) { queued.attempts++; queued.due = now() + Math.max(reply.retryAfterMs ?? 0, Math.min(120_000, 15_000 * 2 ** queued.attempts)); }
        }
      });
    }));
  }
  function tick() { if (running) return running; running = run().finally(() => { running = null; }); return running; }
  async function route(request: Request, principal: Principal) {
    const suffix = new URL(request.url).pathname.slice('/api/cocoproxy/notifications'.length);
    const sub = state.subscriptions.find(s => s.deviceId === principal.deviceId);
    if (suffix === '/status' && request.method === 'GET') return { supported: !broken, trusted: !!principal.deviceId && options.devices.has(principal.deviceId),
      publicKey: state.keys?.publicKey ?? null, subscribed: !!sub && sub.status !== 'expired', preferences: sub?.preferences ?? defaults,
      delivery: sub?.status ?? 'disabled', lastAt: sub?.lastAt ?? null, pending: state.jobs.filter(j => j.deviceId === principal.deviceId).length, groups: availableGroups, error: globalError };
    if (suffix === '/events' && request.method === 'GET') return { events: state.events.slice(-100).reverse() };
    if (!principal.deviceId || !options.devices.has(principal.deviceId)) fail('NOTIFICATION_TRUST_REQUIRED', 403);
    const deviceId = principal.deviceId;
    if (suffix === '/initialize' && request.method === 'POST') {
      exactRecord(await readJsonBody(request, 128), []);
      if (!state.keys) await mutate(next => { next.keys ??= generatePushKeys(); });
      return { publicKey: state.keys!.publicKey };
    }
    if (suffix === '/subscription' && request.method === 'POST') {
      const body = exactRecord(await readJsonBody(request, 8192), ['subscription']);
      let subscription: PushSubscription;
      try { subscription = parsePushSubscription(body.subscription); } catch { return fail('PUSH_SUBSCRIPTION_INVALID', 400); }
      if (!state.keys) fail('NOTIFICATION_SETUP_REQUIRED', 409);
      await mutate(next => {
        if (!options.devices.has(deviceId)) fail('NOTIFICATION_TRUST_REQUIRED', 403);
        const previous = next.subscriptions.find(s => s.deviceId === deviceId);
        if (next.subscriptions.some(s => s.deviceId !== deviceId && s.subscription.endpoint === subscription.endpoint)) fail('PUSH_SUBSCRIPTION_CONFLICT', 409);
        next.subscriptions = next.subscriptions.filter(s => s.deviceId !== deviceId);
        if (next.subscriptions.length >= 128) fail('NOTIFICATION_DEVICE_LIMIT', 409);
        next.subscriptions.push({ deviceId, subscription, preferences: previous?.preferences ?? structuredClone(defaults), revision: randomUUID(), status: 'subscribed', lastAt: 0, testAt: 0 });
        next.jobs = next.jobs.filter(j => j.deviceId !== deviceId);
      }); return { subscribed: true };
    }
    if (suffix === '/preferences' && request.method === 'PUT') {
      const p = preferences(await readJsonBody(request, 16_384));
      await mutate(next => { const live = next.subscriptions.find(s => s.deviceId === deviceId); if (!live) fail('NOTIFICATION_SETUP_REQUIRED', 409); live.preferences = p; next.jobs = next.jobs.filter(j => j.deviceId !== deviceId); });
      return { saved: true };
    }
    if (suffix === '/unsubscribe' && request.method === 'POST') {
      exactRecord(await readJsonBody(request, 128), []);
      await mutate(next => { next.subscriptions = next.subscriptions.filter(s => s.deviceId !== deviceId); next.jobs = next.jobs.filter(j => j.deviceId !== deviceId); });
      return { subscribed: false };
    }
    if (suffix === '/test' && request.method === 'POST') {
      exactRecord(await readJsonBody(request, 128), []);
      await mutate(next => {
        const live = next.subscriptions.find(s => s.deviceId === deviceId);
        if (!live || live.status === 'expired') fail('NOTIFICATION_SETUP_REQUIRED', 409);
        if (live.testAt && now() - live.testAt < 60_000) fail('NOTIFICATION_RATE_LIMIT', 429);
        live.testAt = now(); add(next, { id: randomUUID(), at: now(), scope: 'test', group: '测试通知', from: '', to: '', reason: 'test' }, deviceId);
      });
      // A timer tick may already be synchronizing an older state. Waiting for
      // it and then ticking once more guarantees this test job receives one
      // bounded send attempt before the API reports its result.
      await tick(); await tick();
      const current = state.subscriptions.find(s => s.deviceId === deviceId);
      const pending = state.jobs.filter(job => job.deviceId === deviceId).length;
      return { queued: pending > 0, delivery: current?.status ?? 'expired', pending };
    }
    return fail('NOT_FOUND', 404);
  }
  return { route, tick,
    start() { if (closed || timer) return; timer = setInterval(() => { void tick().catch(() => { globalError = 'NOTIFICATIONS_UNAVAILABLE'; }); }, 2000); timer.unref?.(); void tick().catch(() => {}); },
    async close() { closed = true; if (timer) clearInterval(timer); await running; await mutations; },
  };
}
