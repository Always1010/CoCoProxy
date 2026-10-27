#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deployLocal } from './deploy-ssh.mjs';
import { resolveLocalPaths, withLocalBuildLock, readLocalBuild, runLocalCommand } from './local-release-state.mjs';
import { detectLocalInstallation, firstInstallWizard, assertLocalTarget, needsUpdateRouterAdapter, withRouterAdapterWizard } from './local-install.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const forwarded = ['--environment', '--input', '--admin-input', '--router-config', '--router-hook', '--web-unit'];
export function deploymentFailureMessage(error) {
  const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(error.code) ? error.code : 'LOCAL_DEPLOY_FAILED';
  const guidance = {
    ENOENT: '构建工作区、成功回执或必需工具缺失。先以普通用户运行 bash scripts/build-release.sh --prepare，核对系统条件后再部署。',
    LOCAL_BUILD_NOT_READY: '当前源码没有可部署的成功构建。先重新构建；上次失败或未完成的结果不能回退到旧载荷。',
    LOCAL_BUILD_REQUIRED: '尚无成功构建回执。先以普通用户运行 bash scripts/build-release.sh --prepare，再部署。',
    LOCAL_BUILD_COMMIT_CHANGED: '源码提交已改变。先构建当前提交，再重新部署。',
    LOCAL_BUILD_CHANGED: '输入期间源码或构建发生变化。重新构建当前干净提交，再重新审阅部署。',
    LOCAL_SOURCE_DIRTY: '源码工作区必须干净。先审阅并提交相关修改，再构建和部署。',
    LOCAL_DEPLOY_ROOT_REQUIRED: '实际部署需要 root。请在目标 Ubuntu 使用 sudo bash scripts/deploy-local.sh。',
    LOCAL_NODE_22_18_REQUIRED: '先准备 root 控制的 Node.js ≥22.18 系统路径；此入口不会替换运行环境。',
    LOCAL_FIRST_INSTALL_TTY_OR_INPUTS_REQUIRED: '首次向导需要交互终端。自动化须事先准备系统，并显式提供 --environment 和 --admin-input 私有文件。',
    LOCAL_FIRST_INSTALL_INPUT_PAIR_REQUIRED: '首次显式输入必须同时给出 --environment 和 --admin-input。',
    LOCAL_INSTALL_STATE_REQUIRES_REVIEW: '已有或部分安装状态需审阅。使用原公开入口 inspect/recover；不要清收据或通过首次向导覆盖。',
    LOCAL_EXISTING_INSTALL_INPUT_REJECTED: '既有安装复用已保存的部署输入，不接受首次环境和管理员输入。',
    LOCAL_SERVICE_ACCOUNT_CONFLICT: '专用账户已有登录 shell、UID 冲突或身份不符。先核对账户，不要复用登录身份。',
    LOCAL_CERTIFICATE_ALREADY_EXISTS: '证书目标已有文件。先审阅其来源及权限，选择使用既有证书；不会覆盖或复制旧私钥。',
    LOCAL_ROUTER_ADAPTER_REQUIRED: '网关更新需要维护适配器。交互运行可填写既有 SSH 参数；自动化请提供 --router-config 私有文件或 --router-hook 可信程序。',
    LOCAL_ROUTER_ADAPTER_INPUT_INVALID: '适配器参数或密钥/指纹文件不符合要求。先核验目标、权限和已有 SSH 信任，不接受未知指纹。',
    SETUP_ENVIRONMENT_INVALID: '填写的网络、HTTPS 来源或系统路径不符合部署契约。按 docs/setup.md 核对实际值，再重新运行。',
    LOCAL_INSTALL_CANCELLED: '部署已取消；已完成的系统准备不自动回滚。若安装已开始，先 inspect 审阅当前状态。',
    LOCAL_BUILD_LOCK_LOST: '构建工作区被占用或锁已断开。等待当前操作结束，核对状态后重新运行。',
  };
  return code + '\n' + (guidance[code] ?? '部署未完成。按 docs/deployment.md 核对本次错误及公开预检；不自动覆盖、回退或重置现有安装。');
}
export function parseDeployLocalOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    if (['--help', '--check', '--preview'].includes(option) && !options[option]) { options[option] = true; continue; }
    if (![...forwarded, '--workspace'].includes(option) || options[option] || !args[index + 1] || args[index + 1].startsWith('--')) fail('LOCAL_ARGUMENTS_INVALID');
    options[option] = args[++index];
  }
  if (options['--check'] && options['--preview'] || options['--help'] && Object.keys(options).length > 1) fail('LOCAL_ARGUMENTS_INVALID');
  if (Boolean(options['--environment']) !== Boolean(options['--admin-input'])) fail('LOCAL_FIRST_INSTALL_INPUT_PAIR_REQUIRED');
  return options;
}

export async function deployFromLocalBuild(args, dependencies = {}) {
  const options = parseDeployLocalOptions(args);
  if (options['--help']) {
    console.log(`源码本机部署（Ubuntu ARM64 / x86-64）

  sudo bash scripts/deploy-local.sh
  sudo bash scripts/deploy-local.sh --preview
  bash scripts/deploy-local.sh --check

先以普通用户运行 bash scripts/build-release.sh --prepare。
入口锁定构建工作区并验证当前干净 Git HEAD 对应的成功构建，不回退旧载荷。
首次交互填写已核验的网络、HTTPS 和管理员信息，逐项显示系统准备及安装范围，确认后执行。
正常更新使用系统保存的部署输入；中断或旧安装状态须先审阅。
非交互首次安装必须提供 --environment PRIVATE_JSON --admin-input PRIVATE_JSON，并事先准备系统。
可选 --workspace BUILD_DIR、--input、--router-config、--router-hook、--web-unit。
--preview 不执行向导的系统准备；既有安装预览沿用公开部署协调器。`);
    return;
  }
  const source = dependencies.source ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const execute = dependencies.run ?? runLocalCommand;
  // The dependency check is deliberately independent of a build receipt.
  if (options['--check']) return (dependencies.deploy ?? deployLocal)(['--local', '--check'], execute);
  await (dependencies.assertTarget ?? assertLocalTarget)();
  const paths = await (dependencies.resolvePaths ?? resolveLocalPaths)(source, options['--workspace'], { create: false });
  return (dependencies.lock ?? withLocalBuildLock)(paths, async context => {
    const interrupted = new AbortController();
    const signal = AbortSignal.any([context.signal, interrupted.signal]);
    const cancel = () => interrupted.abort(Object.assign(new Error('LOCAL_INSTALL_CANCELLED'), { code: 'LOCAL_INSTALL_CANCELLED' }));
    process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
    const run = (command, argv, settings = {}) => execute(command, argv, { ...settings, signal });
    try {
      const release = await (dependencies.readBuild ?? readLocalBuild)({ source: paths.source, workspace: paths.workspace });
      const installation = await (dependencies.detect ?? detectLocalInstallation)();
      if (release.components === 'frontend' && installation !== 'existing') fail('LOCAL_FRONTEND_EXISTING_INSTALL_REQUIRED');
      if (['backend', 'core'].includes(release.components) && installation !== 'existing') fail('LOCAL_COMPONENT_EXISTING_INSTALL_REQUIRED');
      const deployArgs = ['--local', '--payload', release.output, '--manifest-sha256', release.manifestSha256];
      for (const option of forwarded) if (options[option]) deployArgs.push(option, options[option]);
      if (options['--preview']) deployArgs.push('--preview');
      const deploy = async () => {
        context.assertHeld();
        signal.throwIfAborted();
        // Recheck HEAD, receipt and bytes after a potentially long interactive wizard.
        const current = await (dependencies.readBuild ?? readLocalBuild)({ source: paths.source, workspace: paths.workspace });
        if (current.output !== release.output || current.manifestSha256 !== release.manifestSha256 || current.commit !== release.commit) fail('LOCAL_BUILD_CHANGED');
        await (dependencies.deploy ?? deployLocal)(deployArgs, run);
      };
      if (installation === 'first' && !options['--environment']) {
        return await (dependencies.wizard ?? firstInstallWizard)({ run, signal, payload: release.output, preview: Boolean(options['--preview']),
          deploy: async inputs => { deployArgs.push('--environment', inputs.environment, '--admin-input', inputs.administrator); await deploy(); } });
      }
      if (installation === 'existing' && (options['--environment'] || options['--admin-input'])) fail('LOCAL_EXISTING_INSTALL_INPUT_REJECTED');
      if (installation === 'existing' && release.components !== 'frontend' && !options['--router-config'] && !options['--router-hook'] &&
          await (dependencies.adapterMissing ?? needsUpdateRouterAdapter)(release.manifestSha256)) {
        return await (dependencies.routerWizard ?? withRouterAdapterWizard)({ signal, preview: Boolean(options['--preview']),
          deploy: async (flag, path) => { deployArgs.push(flag, path); await deploy(); } });
      }
      return await deploy();
    } finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  deployFromLocalBuild(process.argv.slice(2)).catch(error => {
    console.error(deploymentFailureMessage(error));
    process.exitCode = 1;
  });
}
