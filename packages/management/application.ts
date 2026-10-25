import { compileConfig, canonicalJson, ConfigError } from '../config/index.ts';
import type { JsonObject } from '../config/index.ts';
import { DraftStore, DraftError } from '../drafts/index.ts';
import { FileTransactionStore, TransactionManager, TransactionError } from '../transaction/index.ts';
import type { RuntimeAdapter } from '../transaction/index.ts';
import { SubscriptionStore, SubscriptionError } from '../subscriptions/index.ts';
import type { SnapshotClient, SnapshotDecoder } from '../subscriptions/index.ts';
import type { CoreObservation } from '../runtime/types.ts';
import { privateRead } from '../storage/private-files.ts';
import { exactRecord, ManagementError, readJsonBody } from './http.ts';
import type { ManagementAction } from './http.ts';
import { compileAutomaticGatewayConfig, parseAutomaticGatewaySettings, automaticGatewayPolicy, AutomaticGatewayConfigError } from '../gateway/profile.ts';
import type { AutomaticGatewaySettings } from '../gateway/profile.ts';
import { createWorkspaceApplication } from './workspace-application.ts';
import { WorkspaceError } from './workspace.ts';

export interface ManagementRuntime extends RuntimeAdapter { observe(generation: string): Promise<CoreObservation> }
const protectedKeys = ['mixed-port', 'allow-lan', 'bind-address', 'external-controller', 'secret', 'tun', 'ipv6', 'dns'];
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const revision = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** Routes only Coproxy operations; the stock upstream write router is not used. */
export function createManagementApplication(options: { stateDirectory: string; deployment: unknown; runtime: ManagementRuntime; sourceClient?: SnapshotClient; sourceDecoder?: SnapshotDecoder; automaticGateway?: AutomaticGatewaySettings }): ManagementAction {
  // Compile before cloning so getters and non-JSON values cannot run here.
  compileConfig({ schemaVersion: 1, deployment: options.deployment, policy: { rules: ['MATCH,REJECT'] } });
  const deployment = structuredClone(options.deployment);
  const automaticGateway = options.automaticGateway === undefined ? undefined : parseAutomaticGatewaySettings(options.automaticGateway);
  const compile = (input: unknown) => automaticGateway ? compileAutomaticGatewayConfig(input, automaticGateway) : compileConfig(input);
  compile({ schemaVersion: 1, deployment, policy: { rules: ['MATCH,REJECT'] } });
  const store = new FileTransactionStore(options.stateDirectory);
  const drafts = new DraftStore(options.stateDirectory);
  const subscriptions = new SubscriptionStore(options.stateDirectory, options.sourceClient, options.sourceDecoder);
  const manager = new TransactionManager(store, options.runtime);
  async function managedDraft(expected: unknown) {
    if (!revision(expected)) throw new ManagementError('INVALID_REVISION');
    const draft = await drafts.load(expected);
    if (canonicalJson(draft.input.deployment) !== canonicalJson(deployment as JsonObject)) throw new ManagementError('DEPLOYMENT_MISMATCH', 409);
    return draft;
  }
  const workspace = createWorkspaceApplication({ stateDirectory: options.stateDirectory, subscriptions, store, manager,
    compile: policy => compile({ schemaVersion: 1, deployment, policy }),
    legacyPolicy: async () => {
      const metadata = await drafts.metadata();
      if (metadata) return (await managedDraft(metadata.revision)).input.policy as JsonObject;
      const active = (await store.status()).active;
      if (!active) return null;
      const candidate = JSON.parse(await privateRead(await store.readCandidate(active))) as JsonObject;
      const policy = automaticGateway ? automaticGatewayPolicy(candidate) : { ...candidate };
      for (const key of protectedKeys) delete policy[key];
      return policy;
    } });
  return async request => {
    try {
      const path = new URL(request.url).pathname;
      if (path === '/api/coproxy/workspace' || path.startsWith('/api/coproxy/workspace/')) return await workspace(request);
      if (path === '/api/coproxy/status' && request.method === 'GET') {
        const status = await store.status();
        let core: CoreObservation | null = null;
        if (status.active !== null) {
          try { core = await options.runtime.observe(status.active); }
          catch { core = { ready: false, generation: status.active, checkedAt: new Date().toISOString(), reason: 'OBSERVATION_UNAVAILABLE' }; }
        }
        return { ...status, draft: await drafts.metadata(), core, scope: 'core_only',
          gateway: { ready: false, reason: automaticGateway ? 'GATEWAY_PATH_UNVERIFIED' : 'GATEWAY_NOT_IMPLEMENTED',
            ...(automaticGateway ? { profile: 'mihomo-automatic', terminalPath: 'unverified' } : {}) } };
      }
      if (path === '/api/coproxy/draft' && request.method === 'GET') {
        const metadata = await drafts.metadata();
        if (metadata === null) return { draft: null };
        const captured = await managedDraft(metadata.revision);
        // The browser may edit node credentials, but never receives deployment
        // secrets or the private input envelope/controller configuration.
        return { draft: { ...metadata, policy: captured.input.policy } };
      }
      if (path === '/api/coproxy/draft' && request.method === 'PUT') {
        const body = exactRecord(await readJsonBody(request), ['expectedRevision', 'policy']);
        if (!revision(body.expectedRevision)) throw new ManagementError('INVALID_REVISION');
        return { ...await drafts.save({ schemaVersion: 1, deployment, policy: body.policy }, body.expectedRevision), saved: true, runtime: 'not_started' };
      }
      if (path === '/api/coproxy/stage' && request.method === 'POST') {
        const body = exactRecord(await readJsonBody(request), ['expectedRevision'], ['sources']);
        const draft = await managedDraft(body.expectedRevision);
        const requested = body.sources ?? [];
        if (!Array.isArray(requested) || requested.length > 100) throw new ManagementError('INVALID_SOURCES');
        const captures: { id: string; expectedRevision: number; snapshotRevision: number; snapshotDigest: string }[] = [];
        const sources = [];
        for (const item of requested) {
          const source = exactRecord(item, ['id', 'expectedRevision']);
          if (typeof source.id !== 'string' || !revision(source.expectedRevision) || source.expectedRevision === 0) throw new ManagementError('INVALID_SOURCES');
          const snapshot = await subscriptions.snapshot(source.id, source.expectedRevision);
          sources.push({ id: snapshot.id, proxies: snapshot.proxies });
          captures.push({ id: snapshot.id, expectedRevision: source.expectedRevision, snapshotRevision: snapshot.sourceRevision, snapshotDigest: snapshot.sha256 });
        }
        const candidate = compile({ schemaVersion: 1, deployment, policy: draft.input.policy, sources });
        await store.stage(candidate);
        return { generation: candidate.id, stagedRevision: draft.revision, sources: captures, staged: true, runtime: 'not_started' };
      }
      if (path === '/api/coproxy/apply' && request.method === 'POST') {
        const body = exactRecord(await readJsonBody(request), ['generation', 'expectedActive']);
        if (!digest(body.generation) || !(body.expectedActive === null || digest(body.expectedActive))) throw new ManagementError('INVALID_GENERATION');
        const candidate = JSON.parse(await privateRead(await store.readCandidate(body.generation)));
        const policy = automaticGateway ? automaticGatewayPolicy(candidate) : { ...candidate };
        for (const key of protectedKeys) delete policy[key];
        const expected = compile({ schemaVersion: 1, deployment, policy });
        if (expected.id !== body.generation) throw new ManagementError('DEPLOYMENT_MISMATCH', 409);
        return { ...await manager.apply(body.generation, body.expectedActive) };
      }
      if (path === '/api/coproxy/recover' && request.method === 'POST') {
        exactRecord(await readJsonBody(request, 128), []);
        return { ...await manager.recover() };
      }
      if (path === '/api/coproxy/sources' && request.method === 'GET') return { sources: await subscriptions.list() };
      const source = /^\/api\/coproxy\/sources\/([A-Za-z][A-Za-z0-9_-]{0,63})(\/refresh)?$/.exec(path);
      if (source !== null) {
        if (request.method === 'GET' && !source[2]) return { source: await subscriptions.status(source[1]) };
        if (request.method === 'PUT' && !source[2]) {
          const body = exactRecord(await readJsonBody(request, 16_384), ['expectedRevision'], ['url', 'name']);
          if (!revision(body.expectedRevision)) throw new ManagementError('INVALID_REVISION');
          return { ...await subscriptions.configure({ id: source[1], ...(body.url === undefined ? {} : { url: body.url as string }),
            ...(body.name === undefined ? {} : { name: body.name as string }) }, body.expectedRevision) };
        }
        if (request.method === 'DELETE' && !source[2]) {
          const body = exactRecord(await readJsonBody(request, 128), ['expectedRevision']);
          if (!revision(body.expectedRevision)) throw new ManagementError('INVALID_REVISION');
          await subscriptions.remove(source[1], body.expectedRevision);
          return { removed: true };
        }
        if (request.method === 'POST' && source[2]) {
          const body = exactRecord(await readJsonBody(request, 128), ['expectedRevision']);
          if (!revision(body.expectedRevision)) throw new ManagementError('INVALID_REVISION');
          return { ...await subscriptions.refresh(source[1], body.expectedRevision) };
        }
      }
      throw new ManagementError('NOT_FOUND', 404);
    } catch (error) {
      if (error instanceof ManagementError) throw error;
      if (error instanceof ConfigError) throw new ManagementError(error.code);
      if (error instanceof AutomaticGatewayConfigError) throw new ManagementError(error.code);
      if (error instanceof DraftError || error instanceof TransactionError || error instanceof SubscriptionError || error instanceof WorkspaceError) {
        const code = error.code;
        const status = /CONFLICT|STORE_LOCKED|RECOVERY_REQUIRED|DEPLOYMENT_MISMATCH/.test(code) ? 409
          : /NOT_FOUND/.test(code) ? 404
          : /INVALID|PROTECTED|NAME_CONFLICT|LIMIT|SOURCE_PENDING|PROFILE_REQUIRED|PROFILE_RULES_REQUIRED|PROFILE_NO_PROXY|GROUP_REFERENCE|GROUP_SELECTION_UNSUPPORTED/.test(code) ? 400 : 503;
        throw new ManagementError(code, status);
      }
      throw new ManagementError('MANAGEMENT_UNAVAILABLE', 503);
    }
  };
}
