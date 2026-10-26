import { isDeepStrictEqual } from 'node:util';

export class ReleaseMetadataError extends Error {
  constructor(code) { super(code); this.name = 'ReleaseMetadataError'; this.code = code; }
}
const fail = code => { throw new ReleaseMetadataError(code); };
const text = (value, pattern) => typeof value === 'string' && pattern.test(value);
const hash = value => text(value, /^[a-f0-9]{64}$/u);
const commit = value => text(value, /^[a-f0-9]{40}$/u);
const tag = value => text(value, /^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u);
const managementKeys = ['repository', 'tag', 'commit', 'packageManager', 'sourceArchiveSha256', 'lockfileSha256'];
const coreKeys = ['repository', 'tag', 'commit'];
const platformKeys = ['architecture', 'elfMachine', 'asset', 'downloadUrl', 'releaseReportedSha256', 'binarySha256'];
const sameFields = (actual, expected, keys) => keys.every(key => isDeepStrictEqual(actual?.[key], expected[key]));
const exactKeys = (object, keys) => object && typeof object === 'object' && !Array.isArray(object)
  && Object.keys(object).sort().join(',') === [...keys].sort().join(',');

export function validateReleaseVersion(pkg, lock, releaseTag) {
  const number = '(?:0|[1-9][0-9]*)';
  const identifier = '(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)';
  const pattern = new RegExp(`^v${number}\\.${number}\\.${number}(?:-${identifier}(?:\\.${identifier})*)?$`, 'u');
  if (!text(releaseTag, pattern) || releaseTag !== `v${pkg?.version}`) fail('RELEASE_VERSION_MISMATCH');
  if (lock?.lockfileVersion !== 3 || lock.name !== pkg.name || lock.version !== pkg.version
    || lock.packages?.['']?.name !== pkg.name || lock.packages?.['']?.version !== pkg.version) fail('RELEASE_LOCK_MISMATCH');
}

export function validateReleaseTooling(catalog, tooling, lock) {
  const version = catalog.management.packageManager.slice('pnpm@'.length);
  if (tooling?.dependencies?.pnpm !== version || lock?.packages?.['']?.dependencies?.pnpm !== version
    || lock?.packages?.['node_modules/pnpm']?.version !== version) fail('COMPONENT_TOOLING_MISMATCH');
}

/** The catalog contains immutable inputs; review.json records observations only. */
export function validateReleaseMetadata(catalog, review, tree) {
  if (!exactKeys(catalog, ['schemaVersion', 'management', 'mihomo']) || catalog.schemaVersion !== 1
    || !exactKeys(catalog.management, managementKeys) || !exactKeys(catalog.mihomo, [...coreKeys, 'platforms'])) fail('COMPONENTS_INVALID');
  const { management, mihomo } = catalog;
  if (management.repository !== 'https://github.com/MetaCubeX/metacubexd'
    || mihomo.repository !== 'https://github.com/MetaCubeX/mihomo'
    || !tag(management.tag) || !commit(management.commit) || !hash(management.sourceArchiveSha256)
    || !hash(management.lockfileSha256) || !text(management.packageManager, /^pnpm@\d+\.\d+\.\d+$/u)
    || !tag(mihomo.tag) || !commit(mihomo.commit)
    || !exactKeys(mihomo.platforms, ['linux-arm64', 'linux-amd64-v1'])) fail('COMPONENTS_INVALID');
  for (const [platform, architecture, machine, asset] of [
    ['linux-arm64', 'arm64', 183, `mihomo-linux-arm64-${mihomo.tag}.gz`],
    ['linux-amd64-v1', 'x64', 62, `mihomo-linux-amd64-v1-${mihomo.tag}.gz`],
  ]) {
    const entry = mihomo.platforms[platform];
    if (!exactKeys(entry, platformKeys) || entry.architecture !== architecture || entry.elfMachine !== machine
      || entry.asset !== asset || entry.downloadUrl !== `${mihomo.repository}/releases/download/${mihomo.tag}/${asset}`
      || !hash(entry.releaseReportedSha256) || !hash(entry.binarySha256)) fail('COMPONENTS_INVALID');
    if (!sameFields(review?.coreCandidate?.platforms?.[platform], entry, platformKeys)
      || review.coreCandidate.platforms[platform].downloadedAssetVerified !== true) fail('COMPONENT_REVIEW_MISMATCH');
  }
  if (review?.schemaVersion !== 1 || !sameFields(review.management, management, managementKeys)
    || !sameFields(review.coreCandidate, mihomo, coreKeys)
    || !sameFields(review.coreCandidate, mihomo.platforms['linux-arm64'], platformKeys.filter(key => !['architecture', 'elfMachine'].includes(key)))
    || Object.keys(review.coreCandidate.platforms).sort().join(',') !== Object.keys(mihomo.platforms).sort().join(',')) fail('COMPONENT_REVIEW_MISMATCH');
  if (tree?.commit !== management.commit || tree?.truncated !== false || !Array.isArray(tree.files)
    || tree.files.length !== review.management.sourceFileCount || review.management.sourceTreeVerified !== true) fail('COMPONENT_TREE_MISMATCH');
  return catalog;
}
