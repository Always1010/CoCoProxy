import { open, mkdir, link, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalJson, compileConfig, ConfigError } from '../../packages/config/index.ts';
import { validateWithMihomo, MihomoValidationError } from '../../packages/mihomo/validator.ts';
import { FileTransactionStore, TransactionError } from '../../packages/transaction/index.ts';
import { DraftStore, DraftError } from '../../packages/drafts/index.ts';

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
  '',
  '输入/配置可能包含凭据；正常输出仅包含摘要和状态。',
  '不自动下载核心、安装依赖、启动服务或修改系统网络。',
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
  for (const key of ['--output', '--state-dir', '--mihomo-bin']) {
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

export async function runCli(args: string[]): Promise<Record<string, unknown> | string> {
  const { command, flags } = parse(args);
  if (command === 'help') return HELP;
  if (command === 'status') {
    const store = new FileTransactionStore(flags.get('--state-dir')!);
    return { ...await store.status() };
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
        || error instanceof MihomoValidationError || error instanceof TransactionError || error instanceof DraftError) {
      code = error.code;
    } else if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') code = 'OUTPUT_EXISTS';
    process.stderr.write(JSON.stringify({ error: { code } }) + '\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
