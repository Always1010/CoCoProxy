import { isAbsolute, resolve } from 'node:path';
import { privateRead } from '../storage/private-files.ts';
import { loadRuntimeSettings } from '../runtime/settings.ts';
import { SystemdMihomoRuntime } from '../runtime/systemd.ts';
import { HttpsSnapshotClient } from '../subscriptions/http.ts';
import type { HttpsClientOptions } from '../subscriptions/http.ts';
import { loadAdminCredential } from './auth.ts';
import { createManagementApplication } from './application.ts';
import { createManagementHandler, exactRecord, managementOrigin, ManagementError } from './http.ts';

function absolute(input: unknown): string {
  if (typeof input !== 'string' || !isAbsolute(input) || resolve(input) !== input || /[\u0000-\u001f\u007f]/.test(input)) throw new ManagementError('MANAGEMENT_SETTINGS_INVALID');
  return input;
}

/** Private deployment configuration only; loading never starts a listener/core. */
export async function loadManagementService(path: string): Promise<(request: Request) => Promise<Response>> {
  try {
    const settings = exactRecord(JSON.parse(await privateRead(absolute(path), 64 * 1024)),
      ['schemaVersion', 'origin', 'credentialPath', 'runtimeSettingsPath', 'deployment'], ['subscriptionPolicy']);
    if (settings.schemaVersion !== 1 || typeof settings.origin !== 'string') throw new Error();
    managementOrigin(settings.origin);
    const credential = await loadAdminCredential(absolute(settings.credentialPath));
    const runtimeSettings = await loadRuntimeSettings(absolute(settings.runtimeSettingsPath));
    let sourceClient: HttpsSnapshotClient | undefined;
    if (settings.subscriptionPolicy !== undefined) {
      const policy = exactRecord(settings.subscriptionPolicy, ['allowedOrigins'], ['allowPrivateAddresses', 'timeoutMs', 'maxBytes', 'maxRedirects', 'ca']);
      if ((policy.allowPrivateAddresses !== undefined && typeof policy.allowPrivateAddresses !== 'boolean') ||
          (policy.ca !== undefined && (typeof policy.ca !== 'string' || policy.ca.length > 32_768))) throw new Error();
      sourceClient = new HttpsSnapshotClient(policy as unknown as HttpsClientOptions);
    }
    const action = createManagementApplication({ stateDirectory: runtimeSettings.stateDirectory, deployment: settings.deployment,
      runtime: new SystemdMihomoRuntime(runtimeSettings), sourceClient });
    return createManagementHandler({ origin: settings.origin, credential }, action);
  } catch { throw new ManagementError('MANAGEMENT_SETTINGS_INVALID', 503); }
}
