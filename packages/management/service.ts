import { isAbsolute, resolve } from 'node:path';
import { isIP } from 'node:net';
import { privateRead } from '../storage/private-files.ts';
import { loadRuntimeSettings, loadRuntimeCandidate, readSelection, verifyBinary } from '../runtime/settings.ts';
import { SystemdMihomoRuntime } from '../runtime/systemd.ts';
import { HttpsSnapshotClient } from '../subscriptions/http.ts';
import type { HttpsClientOptions } from '../subscriptions/http.ts';
import { loadAdminCredential } from './auth.ts';
import { TrustedDeviceStore } from './trusted-devices.ts';
import { FileTransactionStore, TransactionError } from '../transaction/index.ts';
import { decodeSubscriptionProfile } from '../subscriptions/yaml.ts';
import { createControllerProxy, DEFAULT_LATENCY_PROBE_ORIGIN } from './controller.ts';
import { createManagementLifecycle, recoverManagementStartup } from './startup.ts';
import { createManagementApplication } from './application.ts';
import { createManagementGateway, exactRecord, managementOrigin, ManagementError } from './http.ts';
import { createRuleTestHandler, type RoutingSnapshot } from './rule-test.ts';
import { createAutomaticSelector } from './automatic-selector.ts';
import { readRuntimeLifecycle } from '../runtime/lifecycle.ts';
import { SiteProbeStore } from './site-probes.ts';
import type { TimingObserver } from '../diagnostics/operation-timing.ts';
import { createUsageService, parseUsageSnapshot } from './usage.ts';
import { createBandwidthService } from './bandwidth.ts';

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
    // The catalog grants exact URLs independently of the raw probe origin policy.
    // Preserve the explicit empty-list opt-out for all probing.
    const sites = new SiteProbeStore(runtimeSettings.stateDirectory, (controllerPolicy.allowedProbeOrigins as string[] | undefined)?.length !== 0);
    const controller = createControllerProxy({
      allowedProbeUrls: () => sites.allowedUrls(),
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
    const ruleTest = createRuleTestHandler({ isCurrent,
      snapshot: async signal => {
        const responses = await Promise.all(['rules', 'proxies'].map(path => controller.fetch(new Request(settings.origin + '/' + path, { signal }))));
        if (responses.some(response => !response.ok)) throw new ManagementError('RULE_TEST_UNAVAILABLE', 503);
        const generation = responses[0].headers.get('x-cocoproxy-generation');
        if (!generation || responses[1].headers.get('x-cocoproxy-generation') !== generation) throw new ManagementError('ACTIVE_CONFLICT', 409);
        const [{ rules }, { proxies }] = await Promise.all(responses.map(response => response.json())) as [
          { rules: { index: number; extra?: { disabled?: boolean } }[] }, { proxies: RoutingSnapshot['proxies'] }];
        const { candidate } = await loadRuntimeCandidate(runtimeSettings, generation);
        if (!Array.isArray(rules) || !Array.isArray(candidate.config.rules) || rules.length !== candidate.config.rules.length ||
          rules.some((rule, index) => rule.index !== index) || !proxies || typeof proxies !== 'object') throw new ManagementError('RULE_TEST_UNAVAILABLE', 503);
        return { generation, config: candidate.config, proxies, disabled: rules.filter(rule => rule.extra?.disabled).map(rule => rule.index) };
      },
      resolve: async (name, generation, ipv6, signal) => {
        const responses = await Promise.all((ipv6 ? ['A', 'AAAA'] as const : ['A'] as const).map(type => controller.queryDns(name, type, generation, signal)));
        const addresses: string[] = [];
        for (const response of responses) {
          const data = response as { Status?: number; Answer?: { type: number; data: string }[] };
          if (data.Status !== 0) throw new ManagementError('RULE_TEST_DNS_FAILED', 502);
          for (const answer of data.Answer ?? []) if ([1, 28].includes(answer.type) && typeof answer.data === 'string' && isIP(answer.data.trim())) addresses.push(answer.data.trim());
        }
        return addresses;
      } });
    let automatic: ReturnType<typeof createAutomaticSelector> | undefined;
    const onTiming: TimingObserver = timing => {
      // Keep healthy background samples quiet; all user switches and slow or
      // failed reconciliation retain sanitized phase durations in the journal.
      if (timing.operation === 'select' || timing.outcome === 'failed' || timing.totalMs >= 1000)
        console.info(JSON.stringify({ event: 'COCOPROXY_OPERATION_TIMING', ...timing }));
    };
    const action = createManagementApplication({ stateDirectory: runtimeSettings.stateDirectory, deployment: settings.deployment, ruleTest,
      onTiming,
      allowedProbeOrigins: controllerPolicy.allowedProbeOrigins as string[] | undefined,
      automaticStatus: () => automatic?.status() ?? { groups: [], events: [] },
      automaticProbe: (snapshot, node, target) => controller.probeNode(snapshot.generation, node, target, snapshot.probes.timeoutMs),
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
    automatic = createAutomaticSelector({
      snapshot: async () => (await readRuntimeLifecycle(runtimeSettings.stateDirectory)).paused ? null : action.automaticSnapshot(),
      probe: (snapshot, node, target) => controller.probeNode(snapshot.generation, node, target, snapshot.probes.timeoutMs),
      switch: (snapshot, group, node, reason) => action.automaticSwitch(snapshot, group, node, reason),
    });
    const trustedDevices = await TrustedDeviceStore.load(runtimeSettings.stateDirectory, credential, settings.origin);
    const usage = createUsageService({ directory: runtimeSettings.stateDirectory, sample: async () => {
      const status = await store.status();
      if (!status.active || !await isCurrent(status.active)) throw new ManagementError('CONTROLLER_UNAVAILABLE', 503);
      const before = await runtime.accountingIdentity(status.active);
      const response = await controller.fetch(new Request(settings.origin + '/connections'));
      if (!response.ok || response.headers.get('x-cocoproxy-generation') !== status.active) throw new ManagementError('CONTROLLER_UNAVAILABLE', 503);
      const body: unknown = await response.json();
      const after = await runtime.accountingIdentity(status.active);
      if (before.bootId !== after.bootId || before.pid !== after.pid || before.startTime !== after.startTime || !await isCurrent(status.active)) throw new ManagementError('ACTIVE_CONFLICT', 409);
      return parseUsageSnapshot(body, `${before.bootId}:${before.pid}:${before.startTime}`);
    } });
    const bandwidth = createBandwidthService({
      enabled: (controllerPolicy.allowedProbeOrigins as string[] | undefined)?.length !== 0,
      isCurrent: async generation => await isCurrent(generation) && !(await readRuntimeLifecycle(runtimeSettings.stateDirectory)).paused &&
        (await runtime.observe(generation)).ready,
      snapshot: async (node, generation, signal) => {
        if (!await isCurrent(generation)) throw new ManagementError('ACTIVE_CONFLICT', 409);
        if ((await readRuntimeLifecycle(runtimeSettings.stateDirectory)).paused ||
            !(await runtime.observe(generation)).ready) throw new ManagementError('CONTROLLER_UNAVAILABLE', 503);
        const { candidate } = await loadRuntimeCandidate(runtimeSettings, generation);
        const nodes = candidate.config.proxies;
        if (!Array.isArray(nodes) || !nodes.some(value => value !== null && typeof value === 'object' && !Array.isArray(value) && value.name === node))
          throw new ManagementError('BANDWIDTH_NODE_INVALID');
        const binaryPath = await verifyBinary(runtimeSettings);
        signal.throwIfAborted();
        if (!await isCurrent(generation)) throw new ManagementError('ACTIVE_CONFLICT', 409);
        return { config: candidate.config, binaryPath, stateDirectory: runtimeSettings.stateDirectory };
      },
    });
    const gateway = createManagementGateway({ origin: settings.origin, credential, trustedDevices }, (request, principal) =>
      new URL(request.url).pathname.startsWith('/api/clash/') ? controller.fetch(stripControllerMount(request)) :
        new URL(request.url).pathname.startsWith('/api/cocoproxy/usage/') ? usage.fetch(request) :
          ['/api/cocoproxy/bandwidth', '/api/cocoproxy/bandwidth/cancel'].includes(new URL(request.url).pathname) ? bandwidth.fetch(request, principal) : action(request, principal));
    const lifecycle = createManagementLifecycle(runtimeSettings.stateDirectory, runtime,
      () => console.error('COCOPROXY_PERSISTENT_RECOVERY_UNAVAILABLE'), undefined, onTiming);
    return { ...gateway, controller, recoverStartup: () => recoverManagementStartup(runtimeSettings.stateDirectory, runtime),
      startLifecycle: async () => { const recovered = await lifecycle.start(); automatic!.start(); usage.start(); return recovered; },
      closeLifecycle: async () => { try { await bandwidth.close(); } finally { try { await usage.close(); } finally { await automatic!.close(); await lifecycle.close(); } } } };
  } catch { throw new ManagementError('MANAGEMENT_SETTINGS_INVALID', 503); }
}
