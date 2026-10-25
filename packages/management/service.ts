import { isAbsolute, resolve } from 'node:path';
import { privateRead } from '../storage/private-files.ts';
import { loadRuntimeSettings, loadRuntimeCandidate, readSelection } from '../runtime/settings.ts';
import { SystemdMihomoRuntime } from '../runtime/systemd.ts';
import { HttpsSnapshotClient } from '../subscriptions/http.ts';
import type { HttpsClientOptions } from '../subscriptions/http.ts';
import { loadAdminCredential } from './auth.ts';
import { FileTransactionStore, TransactionError } from '../transaction/index.ts';
import { decodeSubscriptionProfile } from '../subscriptions/yaml.ts';
import { createControllerProxy, DEFAULT_LATENCY_PROBE_ORIGIN } from './controller.ts';
import { recoverManagementStartup } from './startup.ts';
import { createManagementApplication } from './application.ts';
import { createManagementGateway, exactRecord, managementOrigin, ManagementError } from './http.ts';

export function stripControllerMount(request: Request): Request {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/clash/')) throw new ManagementError('NOT_FOUND', 404);
  url.pathname = url.pathname.slice('/api/clash'.length);
  return new Request(url, request);
}

function absolute(input: unknown): string {
  if (typeof input !== 'string' || !isAbsolute(input) || resolve(input) !== input || /[\u0000-\u001f\u007f]/.test(input)) throw new ManagementError('MANAGEMENT_SETTINGS_INVALID');
  return input;
}

/** Private deployment configuration only; loading never starts a listener/core. */
export async function loadManagementService(path: string): Promise<(request: Request) => Promise<Response>> {
  return (await loadManagementGateway(path)).fetch;
}

export async function loadManagementGateway(path: string) {
  try {
    const settings = exactRecord(JSON.parse(await privateRead(absolute(path), 64 * 1024)),
      ['schemaVersion', 'origin', 'credentialPath', 'runtimeSettingsPath', 'deployment'], ['subscriptionPolicy', 'controllerPolicy']);
    if (settings.schemaVersion !== 1 || typeof settings.origin !== 'string') throw new Error();
    managementOrigin(settings.origin);
    const credential = await loadAdminCredential(absolute(settings.credentialPath));
    const runtimeSettings = await loadRuntimeSettings(absolute(settings.runtimeSettingsPath));
    let sourceClient: HttpsSnapshotClient | undefined;
    if (settings.subscriptionPolicy !== undefined) {
      const policy = exactRecord(settings.subscriptionPolicy, ['allowedOrigins'], ['allowedHttpOrigins', 'allowPrivateAddresses', 'timeoutMs', 'maxBytes', 'maxRedirects', 'ca']);
      if ((policy.allowPrivateAddresses !== undefined && typeof policy.allowPrivateAddresses !== 'boolean') ||
          (policy.ca !== undefined && (typeof policy.ca !== 'string' || policy.ca.length > 32_768))) throw new Error();
      sourceClient = new HttpsSnapshotClient(policy as unknown as HttpsClientOptions);
    }
    const runtime = new SystemdMihomoRuntime(runtimeSettings);
    const store = new FileTransactionStore(runtimeSettings.stateDirectory);
    // Older settings omitted controllerPolicy entirely. Give those deployments
    // the same safe HTTPS probe used by the dashboard. An explicitly configured
    // empty list remains the operator's opt-out and disables latency probing.
    const controllerPolicy = settings.controllerPolicy === undefined
      ? { allowedProbeOrigins: [DEFAULT_LATENCY_PROBE_ORIGIN] }
      : exactRecord(settings.controllerPolicy, ['allowedProbeOrigins']);
    if (controllerPolicy.allowedProbeOrigins !== undefined && (!Array.isArray(controllerPolicy.allowedProbeOrigins) ||
        controllerPolicy.allowedProbeOrigins.length > 16 || controllerPolicy.allowedProbeOrigins.some(item => typeof item !== 'string'))) throw new Error();
    async function isCurrent(generation: string): Promise<boolean> {
      try {
        const status = await store.status();
        return status.active === generation && status.transaction === null && status.fault === null && await readSelection(runtimeSettings) === generation;
      } catch { return false; }
    }
    const controller = createControllerProxy({
      allowedProbeOrigins: controllerPolicy.allowedProbeOrigins as string[] | undefined,
      isCurrent,
      target: async () => {
        const status = await store.status();
        if (status.active === null || !await isCurrent(status.active) || !(await runtime.observe(status.active)).ready) throw new ManagementError('CONTROLLER_UNAVAILABLE', 503);
        const candidate = await loadRuntimeCandidate(runtimeSettings, status.active);
        if (!await isCurrent(status.active)) throw new ManagementError('ACTIVE_CONFLICT', 409);
        return { generation: status.active, ...candidate.controller };
      },
      mutate: async <T>(operation: () => Promise<T>): Promise<T> => {
        // Keep adapter errors outside the storage layer's fixed I/O boundary.
        let result: { value: T } | { error: unknown };
        try {
          result = await store.exclusive(async () => {
            try { return { value: await operation() }; } catch (error) { return { error }; }
          });
        } catch (error) {
          throw new ManagementError(error instanceof TransactionError && error.code === 'STORE_LOCKED' ? 'STORE_LOCKED' : 'CONTROLLER_UNAVAILABLE', error instanceof TransactionError && error.code === 'STORE_LOCKED' ? 409 : 503);
        }
        if ('error' in result) throw result.error;
        return result.value;
      },
    });
    const action = createManagementApplication({ stateDirectory: runtimeSettings.stateDirectory, deployment: settings.deployment,
      runtime, sourceClient, sourceDecoder: decodeSubscriptionProfile, automaticGateway: runtimeSettings.automaticGateway,
      observeSelections: async () => {
        const response = await controller.fetch(new Request(settings.origin + '/proxies'));
        const generation = response.headers.get('x-cocoproxy-generation');
        if (!response.ok || !generation) throw new ManagementError('CONTROLLER_UNAVAILABLE', 503);
        const body = await response.json() as { proxies: Record<string, { now?: unknown }> };
        const selections: Record<string, string> = Object.create(null);
        for (const [name, value] of Object.entries(body.proxies)) if (typeof value.now === 'string') selections[name] = value.now;
        return { generation, selections };
      } });
    const gateway = createManagementGateway({ origin: settings.origin, credential }, (request, principal) =>
      new URL(request.url).pathname.startsWith('/api/clash/') ? controller.fetch(stripControllerMount(request)) : action(request, principal));
    return { ...gateway, controller, recoverStartup: () => recoverManagementStartup(runtimeSettings.stateDirectory, runtime) };
  } catch { throw new ManagementError('MANAGEMENT_SETTINGS_INVALID', 503); }
}
