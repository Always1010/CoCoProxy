import { posix } from 'node:path';

// Keep additions explicit: documentation links never expand the payload implicitly.
export const releaseSourceFiles = new Set([
  'AGENTS.md', '.github/workflows/release.yml',
  'docs/setup.md', 'docs/support-matrix.md', 'docs/router-contract.md', 'docs/getting-started.md', 'docs/deployment.md', 'docs/management-https.md', 'docs/release-staging.md',
  'docs/usage.md', 'docs/architecture.md', 'docs/development.md', 'docs/network-benchmark.md',
  'docs/images/architecture-overview.svg', 'docs/images/runtime-relations.svg', 'docs/images/proxy-traffic-flow.svg',
  'docs/release-notes.md',
  'examples/setup-environment.json', 'examples/deployment-plan.json', 'examples/automatic-gateway-deployment.json',
  'examples/deployment-options.md', 'examples/runtime-deployment.json', 'examples/subscription-source.json',
  'examples/subscription-policy.json', 'examples/nginx-management.conf', 'examples/cocoproxy-web.service',
  'scripts/measure-latency.mjs', 'scripts/cocoproxy-setup.sh', 'integrations/protocol-fixture/README.md',
  'scripts/deploy-ssh.mjs', 'scripts/remote-deploy.py', 'scripts/router-ssh-hook.py',
]);
export const releaseIntegrationFiles = [
  'integrations/metacubexd/LICENSE', 'integrations/metacubexd/components.json', 'integrations/metacubexd/review.json',
  'integrations/metacubexd/source-tree.json', 'integrations/metacubexd/README.md', 'integrations/mihomo/LICENSE',
];
export const selectedReleaseSource = path => /^(apps|packages)\//u.test(path)
  || /^(package(?:-lock)?\.json|LICENSE(?:\.[A-Za-z0-9-]+)?|NOTICE(?:\.[A-Za-z0-9-]+)?)$/u.test(path)
  || releaseSourceFiles.has(path);

export class ReleaseDocumentationError extends Error {
  constructor(code, path) { super(code); this.name = 'ReleaseDocumentationError'; this.code = code; this.path = path; }
}
export function assertReleaseSourcePaths(paths) {
  if (paths.some(path => path.split('/').some(part => part.toLowerCase() === '.local'))) {
    throw new ReleaseDocumentationError('SOURCE_LOCAL_DATA', '.local');
  }
}
/** Check local inline, image, reference and HTML links against the selected file set. */
export function verifyOfflineDocumentation(contents) {
  const names = new Set(contents.keys());
  let checked = 0;
  for (const [path, bytes] of contents) {
    // Dependency README files describe their upstream repositories, not this
    // offline product guide. Their links can point at tests or sibling packages.
    if (!path.endsWith('.md') || path.split('/').includes('node_modules')) continue;
    const text = bytes.toString('utf8').replace(/^\s*(```|~~~)[\s\S]*?^\s*\1[^\n]*$/gmu, '')
      .replace(/`[^`\n]*`/gu, '');
    const targets = [
      ...Array.from(text.matchAll(/\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+[^)]*)?\)/gu), match => match[1]),
      ...Array.from(text.matchAll(/^\s{0,3}\[[^\]]+\]:\s*(<[^>]+>|\S+)/gmu), match => match[1]),
      ...Array.from(text.matchAll(/\b(?:src|href)=["']([^"']+)["']/gu), match => match[1]),
    ];
    for (let target of targets) {
      target = target.replace(/^<|>$/gu, '');
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/iu.test(target)) continue;
      try { target = decodeURIComponent(target.split(/[?#]/u)[0]); }
      catch { throw new ReleaseDocumentationError('DOCUMENT_LINK_INVALID', path); }
      if (!target) continue;
      const resolved = posix.normalize(posix.join(posix.dirname(path), target));
      if (target.startsWith('/') || target.includes('\\') || resolved.startsWith('../') || !names.has(resolved)) {
        throw new ReleaseDocumentationError('DOCUMENT_LINK_MISSING', `${path} -> ${resolved}`);
      }
      checked++;
    }
  }
  return { checked };
}

export const releaseLauncher = Buffer.from(`#!/bin/sh\nset -eu\nRELEASE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec sh "$RELEASE_DIR/source/scripts/cocoproxy-setup.sh" "$@"\n`);
export function releaseReadme(version) {
  return Buffer.from(`# CoCoProxy ${version}\n\n首次安装从[部署指南](source/docs/getting-started.md)开始，字段和命令见[配置参考](source/docs/setup.md)。\n\n在解压目录运行：\n\n\`\`\`sh\n./cocoproxy help\n./cocoproxy doctor\n\`\`\`\n\n目标需具备 Node.js 22.18.0 或更高版本、Linux/systemd 及部署指南所列工具。安装前从可信发行来源核对 SHA256SUMS 和独立 manifest 摘要；准备私有环境参数后执行 configure，再审阅安装预检结果。\n\n[版本与验证范围](source/docs/release-notes.md) · [本机／SSH 部署与维护](source/docs/deployment.md) · [后台使用](source/docs/usage.md) · [固定组件清单](source/integrations/metacubexd/components.json)\n\nmanifest.json 记录源提交、组件与每个文件的摘要；source/ 包含离线文档、运行源码与依赖，server/ 为管理服务，bin/mihomo 为固定平台核心。\n`);
}
