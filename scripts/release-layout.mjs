import { posix } from 'node:path';

// Ship runtime and deployment inputs only; project documentation stays in Git.
export const releaseSourceFiles = new Set([
  'scripts/cocoproxy-setup.sh',
  'scripts/deploy-ssh.mjs', 'scripts/remote-deploy.py', 'scripts/router-ssh-hook.py',
]);
export const releaseIntegrationFiles = [
  'integrations/metacubexd/LICENSE', 'integrations/metacubexd/components.json', 'integrations/metacubexd/review.json',
  'integrations/metacubexd/source-tree.json', 'integrations/mihomo/LICENSE',
];
export const selectedReleaseSource = path => (/^(apps|packages)\//u.test(path)
    && !/\.md$/iu.test(path) && path !== 'packages/routing/generate-assets.mjs')
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
export function releaseAssetPlatform(platform) {
  const assetPlatform = {
    'linux-arm64': 'linux-arm64',
    'linux-amd64-v1': 'linux-amd64',
  }[platform];
  if (!assetPlatform) throw new ReleaseDocumentationError('RELEASE_PLATFORM_INVALID', platform);
  return assetPlatform;
}
/** Check local inline, image, reference and HTML links against the supplied file set. */
export function verifyDocumentationLinks(contents) {
  const names = new Set(contents.keys());
  // Markdown can link to a repository directory as well as to an individual file.
  for (const path of contents.keys()) {
    for (let directory = posix.dirname(path); directory !== '.'; directory = posix.dirname(directory)) {
      names.add(directory); names.add(`${directory}/`);
    }
  }
  if (contents.size) { names.add('.'); names.add('./'); }
  let checked = 0;
  for (const [path, bytes] of contents) {
    // Dependency README files describe their upstream repositories. Their links
    // can point at upstream tests or sibling packages outside this file set.
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
      // Root collaboration rules intentionally link to ignored, machine-local
      // material that must never become part of the tracked source or release.
      if (path === 'AGENTS.md' && resolved.startsWith('.local/')) continue;
      if (target.startsWith('/') || target.includes('\\') || resolved.startsWith('../') || !names.has(resolved)) {
        throw new ReleaseDocumentationError('DOCUMENT_LINK_MISSING', `${path} -> ${resolved}`);
      }
      checked++;
    }
  }
  return { checked };
}

export const releaseLauncher = Buffer.from(`#!/bin/sh\nset -eu\nRELEASE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec sh "$RELEASE_DIR/source/scripts/cocoproxy-setup.sh" "$@"\n`);
export function releaseReadme(version, commit) {
  const repository = `https://github.com/Always1010/CoCoProxy/blob/${commit}`;
  return Buffer.from(`# CoCoProxy ${version}

核对可信 Release 的 SHA256SUMS 和 manifest 摘要，解压与目标架构匹配的安装包。目标需准备 Node.js ≥22.18、Python 3、Linux/systemd、专用服务账号及所需网络和 HTTPS 环境。

在解压目录查看帮助和检查环境：

\`\`\`sh
./cocoproxy help
./cocoproxy deploy --local --check
\`\`\`

首次安装按[部署指南](${repository}/docs/getting-started.md)准备私有环境和管理员文件，替换下列绝对路径；先预览，再执行部署：

\`\`\`sh
sudo ./cocoproxy deploy --local --preview --environment /absolute/private/environment.json --admin-input /absolute/private/administrator.json
sudo ./cocoproxy deploy --local --environment /absolute/private/environment.json --admin-input /absolute/private/administrator.json
\`\`\`

已有安装更新使用 \`sudo ./cocoproxy deploy --local\`；通过 SSH 部署使用 \`./cocoproxy deploy <IP>\`，参数见 \`./cocoproxy deploy --help\`。部署不自动开启路由器交付，完成后按指南验收。

完整[配置参考](${repository}/docs/setup.md)和[部署维护说明](${repository}/docs/deployment.md)在对应源码提交中查看。安装包仅保留运行、安装维护文件、许可和校验清单，不附带项目文档或配置示例。
`);
}
