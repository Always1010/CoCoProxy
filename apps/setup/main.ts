import { open, lstat } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { constants } from 'node:fs';
import { deployRelease, prepareUpgrade, verifyRelease } from '../../packages/deployment/install.ts';
import { inspectDeployment, recoverDeployment } from '../../packages/deployment/maintenance.ts';
import { createSetupDeployment, parseSetupEnvironment, routerParameters, SetupError } from '../../packages/setup/input.ts';
import { inspectSetup, resolveServiceUid } from '../../packages/setup/doctor.ts';
import { runSetupLifecycle, type SetupLifecycleAction } from '../../packages/setup/lifecycle.ts';
import { privateRead, inspectPrivateDirectory, syncDirectory } from '../../packages/storage/private-files.ts';

const help = `CoCoProxy 部署与维护入口

  check                                  无 Node 前置条件盘点（使用 shell 入口）
  doctor [--environment PRIVATE_JSON]     汇总目标环境只读检查
  configure --environment PRIVATE_JSON --payload DIR --manifest-sha256 SHA
            --output PRIVATE_JSON [--router-output PRIVATE_JSON] [--existing-input PRIVATE_JSON]
                                         核验载荷并生成私有部署输入；不覆盖已有文件
  install|upgrade|uninstall --payload DIR --manifest-sha256 SHA --input PRIVATE_JSON [--apply]
            [--reviewed-configuration-sha256 SHA]
                                         默认只读安装预检，--apply 执行文件安装
  prepare --payload DIR --manifest-sha256 SHA --input PRIVATE_JSON
                                         运行期间只读准备升级，不停止服务
  inspect                                只读检查收据、文件、载荷及中断状态
  recover [--apply --reviewed-recovery-sha256 SHA]
                                         审阅已完成全部写入的中断事务，按摘要显式收尾
  lifecycle --action ACTION --input PRIVATE_JSON [--apply --reviewed-plan-sha256 SHA]
            [--admin-input PRIVATE_JSON] [--router-disabled] [--terminal-path-verified]
                                         默认预览初始化、启动、持久运行与维护步骤

configure 会从载荷生成 release 路径、核心摘要和一致的端口，首次生成内部随机秘密。
升级生成必须提供 --existing-input 保留内部秘密；自定义旧布局使用原安装入口。
所有输入输出使用绝对私有路径。实际网络启用、HTTPS 和终端验收见随包 docs/setup.md。
`;

async function writePrivate(path: string, value: unknown): Promise<void> {
  if (!isAbsolute(path)) throw new SetupError('SETUP_ABSOLUTE_OUTPUT_REQUIRED');
  await inspectPrivateDirectory(dirname(path));
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY |
    (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW), 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
  await syncDirectory(dirname(path));
}
async function jsonInput(path: string): Promise<unknown> {
  if (!isAbsolute(path)) throw new SetupError('SETUP_ABSOLUTE_INPUT_REQUIRED');
  return JSON.parse(await privateRead(path, 128 * 1024));
}

try {
  const args = process.argv.slice(2);
  let command = args.shift() ?? 'help';
  if (['initialize', 'start-management', 'enable-persistence', 'pause-maintenance', 'stop-maintenance', 'resume-persistence'].includes(command)) {
    args.unshift('--action', command); command = 'lifecycle';
  }
  if (command === 'help' || command === '--help' || command === '-h') {
    if (args.length) throw new SetupError('SETUP_ARGUMENTS_INVALID');
    process.stdout.write(help);
  } else {
    const options: Record<string, string> = {};
    let apply = false, routerDisabled = false, terminalPathVerified = false;
    for (let i = 0; i < args.length; i++) {
      const key = args[i];
      if (key === '--apply' && !apply) { apply = true; continue; }
      if (key === '--router-disabled' && !routerDisabled) { routerDisabled = true; continue; }
      if (key === '--terminal-path-verified' && !terminalPathVerified) { terminalPathVerified = true; continue; }
      if (!key.startsWith('--') || options[key] || !args[i + 1] || args[i + 1].startsWith('--')) throw new SetupError('SETUP_ARGUMENTS_INVALID');
      options[key] = args[++i];
    }
    const allowed: Record<string, string[]> = {
      doctor: ['--environment'], configure: ['--environment', '--payload', '--manifest-sha256', '--output', '--router-output', '--existing-input'],
      install: ['--payload', '--manifest-sha256', '--input', '--reviewed-configuration-sha256'],
      upgrade: ['--payload', '--manifest-sha256', '--input', '--reviewed-configuration-sha256'],
      uninstall: ['--payload', '--manifest-sha256', '--input'],
      prepare: ['--payload', '--manifest-sha256', '--input'], inspect: [], recover: ['--reviewed-recovery-sha256'],
      lifecycle: ['--input', '--action', '--admin-input', '--reviewed-plan-sha256'],
    };
    if (!allowed[command] || Object.keys(options).some(key => !allowed[command].includes(key)) ||
        apply && !['install', 'upgrade', 'uninstall', 'recover', 'lifecycle'].includes(command) ||
        (routerDisabled || terminalPathVerified) && command !== 'lifecycle') throw new SetupError('SETUP_ARGUMENTS_INVALID');
    const required = ['doctor', 'inspect', 'recover'].includes(command) ? [] : command === 'lifecycle' ? ['--input', '--action']
      : command === 'configure' ? ['--environment', '--payload', '--manifest-sha256', '--output'] : ['--payload', '--manifest-sha256', '--input'];
    if (required.some(key => !options[key])) throw new SetupError('SETUP_ARGUMENTS_INVALID');
    if (command === 'lifecycle') {
      const result = await runSetupLifecycle({ input: options['--input'], action: options['--action'] as SetupLifecycleAction,
        apply, reviewedPlanSha256: options['--reviewed-plan-sha256'], adminInput: options['--admin-input'], routerDisabled, terminalPathVerified });
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } else if (command === 'inspect' || command === 'recover' || command === 'prepare') {
      const result = command === 'inspect' ? await inspectDeployment() : command === 'recover'
        ? await recoverDeployment({ apply, reviewedRecoverySha256: options['--reviewed-recovery-sha256'] })
        : await prepareUpgrade({ payload: options['--payload'], input: options['--input'], manifestSha256: options['--manifest-sha256'] });
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } else if (command === 'doctor') {
      const result = await inspectSetup(options['--environment'] ? await jsonInput(options['--environment']) : undefined);
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      if (!result.readyForInstallPreflight) process.exitCode = 1;
    } else if (command === 'configure') {
      if (!isAbsolute(options['--payload'])) throw new SetupError('SETUP_ABSOLUTE_INPUT_REQUIRED');
      // Verify complete bytes/file set before accepting any metadata from the payload.
      const release = await verifyRelease(options['--payload'], options['--manifest-sha256']);
      const previous = options['--existing-input'] ? await jsonInput(options['--existing-input']) : undefined;
      const environment = parseSetupEnvironment(await jsonInput(options['--environment']), previous);
      const serviceUid = await resolveServiceUid(environment);
      if (options['--router-output'] === options['--output']) throw new SetupError('SETUP_OUTPUT_CONFLICT');
      // Validate both destinations before writing the secret-bearing deployment input.
      for (const key of ['--output', '--router-output']) if (options[key]) {
        if (!isAbsolute(options[key])) throw new SetupError('SETUP_ABSOLUTE_OUTPUT_REQUIRED');
        await inspectPrivateDirectory(dirname(options[key]));
        try { await lstat(options[key]); throw new SetupError('SETUP_OUTPUT_EXISTS'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      const deployment = createSetupDeployment(environment, { manifestSha256: options['--manifest-sha256'], binarySha256: release.coreSHA, serviceUid }, previous);
      await writePrivate(options['--output'], deployment);
      if (options['--router-output']) await writePrivate(options['--router-output'], routerParameters(environment));
      process.stdout.write(JSON.stringify({ schemaVersion: 1, configured: true, routerParametersWritten: Boolean(options['--router-output']),
        existingIdentityPreserved: previous !== undefined, next: 'install-preflight', servicesStarted: false }) + '\n');
    } else {
      const result = await deployRelease({ payload: options['--payload'], input: options['--input'], manifestSha256: options['--manifest-sha256'],
        operation: command as 'install' | 'upgrade' | 'uninstall', apply,
        reviewedConfigurationSha256: options['--reviewed-configuration-sha256'] });
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    }
  }
} catch (error) {
  process.stderr.write((typeof (error as any)?.code === 'string' && /^[A-Z][A-Z0-9_]+$/.test((error as any).code)
    ? (error as any).code : 'SETUP_OPERATION_FAILED') + '\n');
  process.exitCode = 1;
}
