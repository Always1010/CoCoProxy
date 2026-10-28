import { createHash, randomBytes } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { atomicWrite, inspectPrivateDirectory, privateDirectory, privateRead } from '../storage/private-files.ts';
import { AuthError, parseAdminCredential, type AdminCredential } from './auth.ts';
import { normalizeIP } from './request-address.ts';

export type DeviceTrust = '90days' | 'until-revoked';
export type TrustedDevice = {
  id: string; label: string; trust: DeviceTrust; createdAt: number; renewedAt: number; expiresAt: number | null;
  lastIP: string | null; lastSeenAt: number | null;
};
type DeviceRecord = TrustedDevice & { tokenDigest: string };
const DAY = 24 * 60 * 60 * 1000;
export const TRUST_COOKIE_MAX_AGE = 400 * 24 * 60 * 60;
const LIMIT = 128;
function failure(): never { throw new AuthError('AUTH_TRUST_UNAVAILABLE'); }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const timestamp = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const digest = (token: unknown): string | null => {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token) || Buffer.from(token, 'base64url').toString('base64url') !== token) return null;
  return createHash('sha256').update(token).digest('hex');
};
const publicDevice = ({ tokenDigest: _tokenDigest, ...device }: DeviceRecord): TrustedDevice => ({ ...device });

export function deviceLabel(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 160 || /[\u0000-\u001f\u007f]/.test(value)) throw new AuthError('AUTH_DEVICE_LABEL_INVALID');
  return value.trim().normalize('NFC');
}
const labelKey = (label: string) => label.normalize('NFC').trim().toLowerCase();
export type TrustedDeviceDocument = { schemaVersion: 1 | 2; credentialFingerprint: string; devices: DeviceRecord[] };
export function parseTrustedDeviceDocument(value: unknown): TrustedDeviceDocument {
  if (!record(value) || Object.keys(value).sort().join(',') !== 'credentialFingerprint,devices,schemaVersion' ||
      ![1, 2].includes(value.schemaVersion as number) || typeof value.credentialFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.credentialFingerprint) ||
      !Array.isArray(value.devices) || value.devices.length > LIMIT) failure();
  const ids = new Set<string>(), tokens = new Set<string>(), labels = new Set<string>();
  for (const item of value.devices) {
    if (!record(item) || Object.keys(item).sort().join(',') !== (value.schemaVersion === 1 ? 'createdAt,expiresAt,id,label,renewedAt,tokenDigest,trust' : 'createdAt,expiresAt,id,label,lastIP,lastSeenAt,renewedAt,tokenDigest,trust') ||
        typeof item.id !== 'string' || !/^[a-f0-9]{32}$/.test(item.id) || ids.has(item.id) ||
        typeof item.tokenDigest !== 'string' || !/^[a-f0-9]{64}$/.test(item.tokenDigest) || tokens.has(item.tokenDigest) ||
        typeof item.label !== 'string' || !item.label.trim() || item.label.length > 160 || /[\u0000-\u001f\u007f]/.test(item.label) ||
        !timestamp(item.createdAt) || !timestamp(item.renewedAt) || item.renewedAt < item.createdAt ||
        typeof item.trust !== 'string' || !['90days', 'until-revoked'].includes(item.trust) ||
        (item.trust === 'until-revoked' ? item.expiresAt !== null : !timestamp(item.expiresAt) || item.expiresAt !== item.renewedAt + 90 * DAY)) failure();
    if (value.schemaVersion === 2 && ((item.lastIP !== null && normalizeIP(item.lastIP) !== item.lastIP) ||
        (item.lastSeenAt !== null && !timestamp(item.lastSeenAt)) || labels.has(labelKey(item.label)))) failure();
    ids.add(item.id); tokens.add(item.tokenDigest); labels.add(labelKey(item.label));
  }
  return value as unknown as TrustedDeviceDocument;
}

/** Deterministic preference migration, shared with stopped upgrade preservation checks. */
export function migrateTrustedDeviceDocument(value: TrustedDeviceDocument, now: number): TrustedDeviceDocument {
  if (value.schemaVersion === 2) return value;
  const used = new Set<string>();
  const devices = value.devices.filter(item => item.expiresAt === null || item.expiresAt > now).map(item => {
    const base = item.label.trim().normalize('NFC');
    let label = base, suffix = 2;
    while (used.has(labelKey(label))) label = `${base.slice(0, 145)}（${suffix++}）`;
    used.add(labelKey(label));
    return { ...item, label, lastIP: null, lastSeenAt: null };
  });
  return { ...value, schemaVersion: 2, devices };
}

/** Single management process, serialized durable mutations; never stores bearer tokens. */
export class TrustedDeviceStore {
  private readonly stateDirectory: string;
  private readonly directory: string;
  private readonly fingerprint: string;
  private readonly now: () => number;
  private devices: DeviceRecord[] = [];
  private pending: Promise<unknown> = Promise.resolve();

  private constructor(stateDirectory: string, credential: AdminCredential, origin: string, now: () => number) {
    if (!isAbsolute(stateDirectory)) failure();
    this.stateDirectory = stateDirectory;
    this.directory = join(stateDirectory, 'auth');
    this.fingerprint = createHash('sha256').update(JSON.stringify({ origin, credential: parseAdminCredential(credential) })).digest('hex');
    this.now = now;
  }

  /** Missing files do not create state; corrupt or unsafe files never grant trust. */
  static async load(stateDirectory: string, credential: AdminCredential, origin: string, now = Date.now): Promise<TrustedDeviceStore> {
    const store = new TrustedDeviceStore(stateDirectory, credential, origin, now);
    try {
      await inspectPrivateDirectory(stateDirectory);
      await inspectPrivateDirectory(store.directory);
      const value = parseTrustedDeviceDocument(JSON.parse(await privateRead(join(store.directory, 'trusted-devices.json'), 128 * 1024)));
      // Changing credentials or the public origin invalidates every previous device.
      if (value.credentialFingerprint === store.fingerprint) {
        store.devices = value.devices;
        if (value.schemaVersion === 1) {
          await store.save(migrateTrustedDeviceDocument(value, store.time()).devices);
        }
      }
      return store;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return store;
      failure();
    }
  }

  private time(): number {
    const value = this.now();
    if (!timestamp(value) || !Number.isSafeInteger(value + 90 * DAY)) failure();
    return value;
  }

  private live(device: DeviceRecord): boolean { return device.expiresAt === null || device.expiresAt > this.time(); }

  check(token: unknown): TrustedDevice | null {
    const hashed = digest(token);
    const device = hashed === null ? undefined : this.devices.find(item => item.tokenDigest === hashed && this.live(item));
    return device ? publicDevice(device) : null;
  }

  has(id: string): boolean { return this.devices.some(item => item.id === id && this.live(item)); }

  bindingFingerprint(): string { return this.fingerprint; }

  list(): TrustedDevice[] { return this.devices.filter(item => this.live(item)).map(publicDevice); }

  private async mutate<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.pending.then(action);
    this.pending = operation.catch(() => {});
    try { return await operation; }
    catch (error) { if (error instanceof AuthError) throw error; failure(); }
  }

  private async save(devices: DeviceRecord[]): Promise<void> {
    await privateDirectory(this.stateDirectory);
    await privateDirectory(this.directory);
    await atomicWrite(this.directory, 'trusted-devices.json', JSON.stringify({ schemaVersion: 2, credentialFingerprint: this.fingerprint, devices }));
    this.devices = devices;
  }

  async issue(trust: DeviceTrust, label: string, previous?: unknown, ip: string | null = null): Promise<{ device: TrustedDevice; token: string }> {
    return this.mutate(async () => {
      if (!['90days', 'until-revoked'].includes(trust)) failure();
      label = deviceLabel(label);
      const previousDigest = digest(previous);
      const devices = this.devices.filter(item => this.live(item) && item.tokenDigest !== previousDigest);
      if (devices.some(item => labelKey(item.label) === labelKey(label))) throw new AuthError('AUTH_DEVICE_LABEL_DUPLICATE');
      if (devices.length >= LIMIT) throw new AuthError('AUTH_DEVICE_LIMIT');
      const stamp = this.time();
      const token = randomBytes(32).toString('base64url');
      const device: DeviceRecord = { id: randomBytes(16).toString('hex'), tokenDigest: digest(token)!, label: label.trim(), trust,
        createdAt: stamp, renewedAt: stamp, expiresAt: trust === '90days' ? stamp + 90 * DAY : null,
        lastIP: normalizeIP(ip), lastSeenAt: stamp };
      await this.save([...devices, device]);
      return { device: publicDevice(device), token };
    });
  }

  /** Renew at most daily, so normal requests do not cause disk writes. */
  async renew(token: unknown, ip: string | null = null): Promise<{ device: TrustedDevice; renewed: boolean } | null> {
    return this.mutate(async () => {
      const device = this.check(token);
      if (!device) return null;
      const stamp = this.time();
      const renewed = stamp - device.renewedAt >= DAY;
      if (!renewed && (!ip || device.lastIP === ip) && stamp - (device.lastSeenAt ?? 0) < 60_000) return { device, renewed: false };
      const updated = { ...device, lastIP: normalizeIP(ip) ?? device.lastIP, lastSeenAt: stamp,
        renewedAt: renewed ? stamp : device.renewedAt,
        expiresAt: renewed && device.trust === '90days' ? stamp + 90 * DAY : device.expiresAt };
      await this.save(this.devices.filter(item => this.live(item)).map(item => item.id === device.id ? { ...item, ...updated } : item));
      return { device: updated, renewed };
    });
  }

  async rename(id: string, label: unknown): Promise<void> {
    await this.mutate(async () => {
      const normalized = deviceLabel(label);
      if (!this.has(id)) throw new AuthError('AUTH_DEVICE_NOT_FOUND');
      if (this.devices.some(item => this.live(item) && item.id !== id && labelKey(item.label) === labelKey(normalized))) throw new AuthError('AUTH_DEVICE_LABEL_DUPLICATE');
      await this.save(this.devices.filter(item => this.live(item)).map(item => item.id === id ? { ...item, label: normalized } : item));
    });
  }

  async revoke(id: string): Promise<void> {
    await this.mutate(async () => {
      const remaining = this.devices.filter(item => item.id !== id && this.live(item));
      if (remaining.length !== this.devices.length) await this.save(remaining);
    });
  }
}
