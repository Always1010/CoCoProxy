import { request as httpRequest } from 'node:http';
import { DEFAULT_UPDATE_SETTINGS, parseUpdateSettings } from '../updater/policy.ts';
import type { UpdateSettings } from '../updater/policy.ts';
import type { UpdateCommand, UpdateView } from '../updater/types.ts';
export type { UpdateCommand } from '../updater/types.ts';
import { exactRecord, ManagementError, readJsonBody } from './http.ts';

export const UPDATER_SOCKET = '/run/cocoproxy-updater/control.sock';
export type UpdateTransport = (command: UpdateCommand) => Promise<UpdateView>;
const MAXIMUM = 64 * 1024;

/** Fixed local control channel: no URL, path or headers are supplied by a browser. */
export function createUpdaterClient(): UpdateTransport {
  return command => new Promise((resolve, reject) => {
    const body = JSON.stringify(command);
    const request = httpRequest({ socketPath: UPDATER_SOCKET, path: '/', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }, agent: false }, response => {
      const chunks: Buffer[] = []; let length = 0;
      response.on('data', (chunk: Buffer) => {
        length += chunk.length;
        if (length > MAXIMUM) request.destroy(new Error('UPDATER_RESPONSE_LIMIT'));
        else chunks.push(chunk);
      });
      response.once('error', () => reject(new ManagementError('UPDATER_UNAVAILABLE', 503)));
      response.once('end', () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (response.statusCode !== 200) {
            const code = typeof value.error === 'string' && /^UPDATER_[A-Z_]+$/.test(value.error) ? value.error : 'UPDATER_UNAVAILABLE';
            throw new ManagementError(code, [400, 409, 503].includes(response.statusCode ?? 0) ? response.statusCode : 503);
          }
          // Fail closed for an unexpected or truncated control-service response.
          if (!value || typeof value.available !== 'boolean' || typeof value.configured !== 'boolean' || !Number.isSafeInteger(value.revision)) throw new Error();
          value.settings = parseUpdateSettings(value.settings);
          resolve(value as UpdateView);
        } catch (error) { reject(error instanceof ManagementError ? error : new ManagementError('UPDATER_UNAVAILABLE', 503)); }
      });
    });
    const timeout = setTimeout(() => request.destroy(new Error('UPDATER_TIMEOUT')), 10_000);
    request.once('close', () => clearTimeout(timeout));
    request.once('error', () => reject(new ManagementError('UPDATER_UNAVAILABLE', 503)));
    request.end(body);
  });
}

export function unavailableUpdates(): UpdateView {
  return { available: false, configured: false, unavailableReason: 'UPDATER_UNAVAILABLE', settings: { ...DEFAULT_UPDATE_SETTINGS }, revision: 0,
    currentVersion: null, latestVersion: null, nextCheckAt: null, lastCheckedAt: null, lastResult: null, job: null };
}

/** Called only after the management gateway authenticates and validates Origin. */
export function createUpdaterHandler(transport: UpdateTransport = createUpdaterClient()) {
  return async (request: Request): Promise<UpdateView> => {
    const path = new URL(request.url).pathname;
    let command: UpdateCommand;
    if (path === '/api/cocoproxy/updates' && request.method === 'GET') command = { action: 'status' };
    else if (path === '/api/cocoproxy/updates/settings' && request.method === 'PUT') {
      const body = exactRecord(await readJsonBody(request, 4096), ['expectedRevision', 'settings']);
      if (!Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 0) throw new ManagementError('UPDATER_SETTINGS_INVALID');
      let settings: UpdateSettings;
      try { settings = parseUpdateSettings(body.settings); } catch { throw new ManagementError('UPDATER_SETTINGS_INVALID'); }
      command = { action: 'configure', expectedRevision: body.expectedRevision as number, settings };
    } else if (path === '/api/cocoproxy/updates/check' && request.method === 'POST') {
      exactRecord(await readJsonBody(request, 128), []); command = { action: 'check' };
    } else if (path === '/api/cocoproxy/updates/install' && request.method === 'POST') {
      const body = exactRecord(await readJsonBody(request, 512), ['expectedVersion']);
      if (typeof body.expectedVersion !== 'string' || !/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(body.expectedVersion) || body.expectedVersion.length > 128) throw new ManagementError('UPDATER_VERSION_INVALID');
      command = { action: 'install', expectedVersion: body.expectedVersion };
    } else throw new ManagementError('NOT_FOUND', 404);
    try { return await transport(command); }
    catch (error) {
      if (command.action === 'status' && error instanceof ManagementError && error.code === 'UPDATER_UNAVAILABLE') return unavailableUpdates();
      throw error;
    }
  };
}
