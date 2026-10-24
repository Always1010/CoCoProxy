import { open, mkdir, link, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalJson, compileConfig, ConfigError } from '../../packages/config/index.ts';
import { validateWithMihomo, MihomoValidationError } from '../../packages/mihomo/validator.ts';
import { FileTransactionStore, TransactionError, TransactionManager } from '../../packages/transaction/index.ts';
import { DraftStore, DraftError } from '../../packages/drafts/index.ts';
import { SubscriptionStore, SubscriptionError } from '../../packages/subscriptions/index.ts';
import { HttpsSnapshotClient, SnapshotHttpError } from '../../packages/subscriptions/http.ts';
import type { HttpsClientOptions } from '../../packages/subscriptions/http.ts';
import { renderRuntimePlan } from '../../packages/runtime/plan.ts';
import { loadRuntimeSettings } from '../../packages/runtime/settings.ts';
import { SystemdMihomoRuntime } from '../../packages/runtime/systemd.ts';
import { RuntimeError } from '../../packages/runtime/types.ts';
import { createAdminCredential, AuthError } from '../../packages/management/auth.ts';
import { privateRead } from '../../packages/storage/private-files.ts';
import { renderDeploymentPlan, DeploymentPlanError } from '../../packages/deployment/plan.ts';

const MAX_INPUT_BYTES = 1_048_576;
const HELP = [
  'Coproxy 开发 CLI（显式代理配置；尚不部署或接管 LAN）',
  '',
  'compile  --input <JSON> --output <绝对路径>  编译私有核心配置',
  'validate --input <JSON> --mihomo-bin <绝对路径>  调用现有核心作语法校验',
  'stage    --input <JSON> --state-dir <绝对路径>  暂存不可变候选，不激活',
  'status   --state-dir <绝对路径>  读取持久状态，不代表实时健康',
  'draft-save --input <JSON> --state-dir <绝对路径> --expected-revision <整数>  保存草稿',
  'draft-status --state-dir <绝对路径>  读取草稿版本，不输出配置',
  'draft-stage --state-dir <绝对路径> --expected-revision <整数>  暂存所选草稿版本',
  'source-configure --input <来源JSON> --state-dir <绝对路径> --expected-revision <整数>',
  'source-status --source-id <ID> --state-dir <绝对路径>  读取来源状态',
  'source-refresh --source-id <ID> --state-dir <绝对路径> --expected-revision <整数> --policy <HTTPS策略JSON>',
  'source-stage --source-id <ID> --input <基础配置JSON> --state-dir <绝对路径> --expected-revision <整数>',
  'runtime-plan --input <部署JSON> --output <绝对路径>  仅生成待审阅服务计划',
  'deployment-plan --input <私有部署JSON> --output <绝对路径>  生成管理/核心/授权文件清单，不安装',
  'runtime-apply --state-dir <绝对路径> --runtime-settings <私有JSON> --generation <SHA256> --expected-active <SHA256|none>',
  'runtime-recover --state-dir <绝对路径> --runtime-settings <私有JSON>  恢复中断事务',
  'runtime-status --state-dir <绝对路径> --runtime-settings <私有JSON>  核验当前核心进程',
  'admin-init --input <私有登录JSON> --output <绝对路径>  创建私有管理员凭据，不覆盖',
  '',
  '输入/配置可能包含凭据；正常输出仅包含摘要和状态。',
  '不自动下载核心、安装依赖或修改系统网络；runtime-apply/recover 明确控制已审阅的服务。',
].join('\n');

class CliError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

function parse(args: string[]): { command: string; flags: Map<string, string> } {
  if (args.length === 0 || (args.length === 1 && ['help', '--help', '-h'].includes(args[0]))) {
    return { command: 'help', flags: new Map() };
  }
  const allowed: Record<string, string[]> = {
    compile: ['--input', '--output'],
    validate: ['--input', '--mihomo-bin'],
    stage: ['--input', '--state-dir'],
    status: ['--state-dir'],
    'draft-save': ['--input', '--state-dir', '--expected-revision'],
    'draft-status': ['--state-dir'],
    'draft-stage': ['--state-dir', '--expected-revision'],
    'source-configure': ['--input', '--state-dir', '--expected-revision'],
    'source-status': ['--source-id', '--state-dir'],
    'source-refresh': ['--source-id', '--state-dir', '--expected-revision', '--policy'],
    'source-stage': ['--source-id', '--input', '--state-dir', '--expected-revision'],
    'runtime-plan': ['--input', '--output'],
    'deployment-plan': ['--input', '--output'],
    'runtime-apply': ['--state-dir', '--runtime-settings', '--generation', '--expected-active'],
    'runtime-recover': ['--state-dir', '--runtime-settings'],
    'runtime-status': ['--state-dir', '--runtime-settings'],
    'admin-init': ['--input', '--output'],
  };
  const command = args[0];
  if (!Object.hasOwn(allowed, command)) throw new CliError('UNKNOWN_COMMAND');
  const flags = new Map<string, string>();
  for (let i = 1; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (!allowed[command].includes(key) || !value || value.startsWith('--') || flags.has(key)) {
      throw new CliError('INVALID_ARGUMENTS');
    }
    flags.set(key, value);
  }
  if (allowed[command].some((key) => !flags.has(key))) throw new CliError('MISSING_ARGUMENT');
  for (const key of ['--output', '--state-dir', '--mihomo-bin', '--runtime-settings']) {
    if (flags.has(key) && !isAbsolute(flags.get(key)!)) throw new CliError('ABSOLUTE_PATH_REQUIRED');
  }
  return { command, flags };
}

function revision(value: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) throw new CliError('INVALID_REVISION');
  return Number(value);
}

async function readInput(path: string): Promise<unknown> {
  const file = await open(resolve(path), constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_INPUT_BYTES) throw new CliError('INVALID_INPUT_SIZE');
    // Bound the actual read too, in case the file grows after stat.
    const buffer = Buffer.alloc(MAX_INPUT_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await file.read(buffer, total, buffer.length - total, null);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total > MAX_INPUT_BYTES) throw new CliError('INVALID_INPUT_SIZE');
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, total))); }
    catch { throw new CliError('INVALID_JSON'); }
  } finally {
    await file.close();
  }
}

async function writePrivateOutput(path: string, content: string): Promise<void> {
  // No implicit output directory and no clobbering of an existing configuration.
  // A fully-written temp file is linked into place with an exclusive destination.
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = resolve(directory, '.coproxy-' + randomUUID() + '.tmp');
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(content, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    // link() is exclusive even if the destination is a symlink. rename() would
    // replace an existing file, so do not use it for user-selected outputs.
    await link(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function httpsPolicy(input: unknown): HttpsClientOptions {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new CliError('INVALID_HTTPS_POLICY');
  const policy = input as Record<string, unknown>;
  const keys = ['allowedOrigins', 'allowPrivateAddresses', 'timeoutMs', 'maxBytes', 'maxRedirects', 'ca'];
  if (Object.keys(policy).some(key => !keys.includes(key))
      || (policy.allowPrivateAddresses !== undefined && typeof policy.allowPrivateAddresses !== 'boolean')
      || (policy.ca !== undefined && (typeof policy.ca !== 'string' || policy.ca.length > 32_768))) throw new CliError('INVALID_HTTPS_POLICY');
  return policy as unknown as HttpsClientOptions;
}

export async function runCli(args: string[]): Promise<Record<string, unknown> | string> {
  const { command, flags } = parse(args);
  if (command === 'help') return HELP;
  if (command === 'admin-init') {
    let input: unknown;
    try { input = JSON.parse(await privateRead(resolve(flags.get('--input')!), 8192)); }
    catch { throw new CliError('INVALID_ADMIN_INPUT'); }
    const credential = await createAdminCredential(input);
    await writePrivateOutput(flags.get('--output')!, JSON.stringify(credential) + '\n');
    return { created: true, scope: 'admin_credential', runtime: 'not_started' };
  }
  if (command === 'status') {
    const store = new FileTransactionStore(flags.get('--state-dir')!);
    return { ...await store.status() };
  }
  if (command === 'deployment-plan') {
    let input: unknown;
    try { input = JSON.parse(await privateRead(resolve(flags.get('--input')!), 128 * 1024)); }
    catch { throw new CliError('INVALID_DEPLOYMENT_INPUT'); }
    const plan = renderDeploymentPlan(input);
    await writePrivateOutput(flags.get('--output')!, JSON.stringify(plan, null, 2) + '\n');
    return { planned: true, fileCount: plan.files.length, scope: 'explicit_proxy_deployment', runtime: 'not_started' };
  }
  if (command === 'runtime-plan') {
    const plan = renderRuntimePlan(await readInput(flags.get('--input')!));
    await writePrivateOutput(flags.get('--output')!, JSON.stringify(plan, null, 2) + '\n');
    return { planned: true, unitSha256: plan.settings.unitSha256, runtime: 'not_started' };
  }
  if (command.startsWith('runtime-')) {
    const settings = await loadRuntimeSettings(flags.get('--runtime-settings')!);
    if (flags.get('--state-dir') !== settings.stateDirectory) throw new CliError('RUNTIME_STATE_MISMATCH');
    const runtime = new SystemdMihomoRuntime(settings);
    const store = new FileTransactionStore(settings.stateDirectory);
    const manager = new TransactionManager(store, runtime);
    if (command === 'runtime-status') {
      const status = await store.status();
      const core = status.active === null ? null : await runtime.observe(status.active);
      return { ...status, core, scope: 'core_only' };
    }
    if (command === 'runtime-recover') return { ...await manager.recover() };
    const generation = flags.get('--generation')!;
    const expected = flags.get('--expected-active')!;
    if (!/^[a-f0-9]{64}$/.test(generation) || !(expected === 'none' || /^[a-f0-9]{64}$/.test(expected))) throw new CliError('INVALID_GENERATION');
    return { ...await manager.apply(generation, expected === 'none' ? null : expected) };
  }
  if (command.startsWith('draft-')) {
    const drafts = new DraftStore(flags.get('--state-dir')!);
    if (command === 'draft-status') return { draft: await drafts.metadata() };
    const expected = revision(flags.get('--expected-revision')!);
    if (command === 'draft-save') {
      return { ...await drafts.save(await readInput(flags.get('--input')!), expected), saved: true, runtime: 'not_started' };
    }
    const captured = await drafts.load(expected);
    const candidate = compileConfig(captured.input);
    await new FileTransactionStore(flags.get('--state-dir')!).stage(candidate);
    return { generation: candidate.id, stagedRevision: captured.revision, staged: true, runtime: 'not_started' };
  }
  if (command.startsWith('source-')) {
    const state = flags.get('--state-dir')!;
    const sourceId = flags.get('--source-id')!;
    if (command === 'source-status') return { source: await new SubscriptionStore(state).status(sourceId) };
    const expected = revision(flags.get('--expected-revision')!);
    if (command === 'source-configure') {
      return { ...await new SubscriptionStore(state).configure(await readInput(flags.get('--input')!) as { id: string; url: string }, expected) };
    }
    if (command === 'source-refresh') {
      const client = new HttpsSnapshotClient(httpsPolicy(await readInput(flags.get('--policy')!)));
      return { ...await new SubscriptionStore(state, client).refresh(sourceId, expected) };
    }
    const base = await readInput(flags.get('--input')!);
    if (!base || typeof base !== 'object' || Array.isArray(base)) throw new CliError('INVALID_INPUT');
    const envelope = base as Record<string, unknown>;
    if (envelope.sources !== undefined && !Array.isArray(envelope.sources)) throw new CliError('INVALID_INPUT');
    const captured = await new SubscriptionStore(state).snapshot(sourceId, expected);
    const candidate = compileConfig({ ...envelope, sources: [...(envelope.sources as unknown[] ?? []), { id: captured.id, proxies: captured.proxies }] });
    await new FileTransactionStore(state).stage(candidate);
    return { generation: candidate.id, sourceId, capturedSourceRevision: expected, snapshotRevision: captured.sourceRevision, staged: true, runtime: 'not_started' };
  }
  const candidate = compileConfig(await readInput(flags.get('--input')!));
  if (command === 'compile') {
    await writePrivateOutput(flags.get('--output')!, canonicalJson(candidate.config) + '\n');
    return { generation: candidate.id, compiled: true, runtime: 'not_started' };
  }
  if (command === 'validate') {
    await validateWithMihomo(candidate, { binaryPath: flags.get('--mihomo-bin')! });
    return { generation: candidate.id, validated: true, scope: 'core_syntax', runtime: 'not_started' };
  }
  const store = new FileTransactionStore(flags.get('--state-dir')!);
  await store.stage(candidate);
  return { generation: candidate.id, staged: true, runtime: 'not_started' };
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  try {
    const output = await runCli(args);
    process.stdout.write((typeof output === 'string' ? output : JSON.stringify(output)) + '\n');
  } catch (error) {
    // No raw exception, paths, core output or JSON fragments in public errors.
    let code = 'IO_ERROR';
    if (error instanceof CliError || error instanceof ConfigError
        || error instanceof MihomoValidationError || error instanceof TransactionError || error instanceof DraftError
        || error instanceof SubscriptionError || error instanceof SnapshotHttpError || error instanceof RuntimeError || error instanceof AuthError || error instanceof DeploymentPlanError) {
      code = error.code;
    } else if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') code = 'OUTPUT_EXISTS';
    process.stderr.write(JSON.stringify({ error: { code } }) + '\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
