import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const executable = join(root, 'apps/cli/main.ts');
const syntheticSecret = 'synthetic-cli-sensitive-value';
const input = {
  schemaVersion: 1,
  deployment: {
    mixedPort: 17890, controllerPort: 19090, dnsPort: 15353,
    controllerSecret: syntheticSecret, bootstrapResolvers: ['192.0.2.53'],
  },
  policy: { rules: ['MATCH,DIRECT'], proxies: [], 'proxy-groups': [] },
};

function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['--experimental-strip-types', executable, ...args], {
      cwd: root, timeout: 15_000, maxBuffer: 65_536, windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') return reject(error);
      resolve({ code: error?.code ?? 0, stdout, stderr });
    });
  });
}

async function fixture(run: (dir: string, file: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'coproxy-cli-test-'));
  try {
    const file = join(dir, 'input.json');
    await writeFile(file, JSON.stringify(input), { mode: 0o600 });
    await run(dir, file);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('compile writes private output and never prints credentials or overwrites', async () => {
  await fixture(async (dir, file) => {
    const output = join(dir, 'config.json');
    const result = await cli(['compile', '--input', file, '--output', output]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).runtime, 'not_started');
    assert.ok(!result.stdout.includes(syntheticSecret));
    assert.equal(JSON.parse(await readFile(output, 'utf8')).secret, syntheticSecret);
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    const second = await cli(['compile', '--input', file, '--output', output]);
    assert.equal(second.code, 1);
    assert.equal(JSON.parse(second.stderr).error.code, 'OUTPUT_EXISTS');
  });
});

test('stage and status do not imply a running service', async () => {
  await fixture(async (dir, file) => {
    const state = join(dir, 'state');
    const staged = await cli(['stage', '--input', file, '--state-dir', state]);
    assert.equal(staged.code, 0, staged.stderr);
    assert.equal(JSON.parse(staged.stdout).runtime, 'not_started');
    const result = await cli(['status', '--state-dir', state]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).active, null);
    assert.equal(JSON.parse(result.stdout).readiness, 'unknown');
    assert.ok(!result.stdout.includes(syntheticSecret));
  });
});

test('invalid JSON and argument errors are bounded and redact input', async () => {
  await fixture(async (dir) => {
    const file = join(dir, 'broken.json');
    await writeFile(file, '{"secret":"' + syntheticSecret);
    const result = await cli(['compile', '--input', file, '--output', join(dir, 'config.json')]);
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stderr).error.code, 'INVALID_JSON');
    assert.ok(!result.stderr.includes(syntheticSecret));
    const relative = await cli(['status', '--state-dir', 'runtime']);
    assert.equal(JSON.parse(relative.stderr).error.code, 'ABSOLUTE_PATH_REQUIRED');
    const duplicate = await cli(['status', '--state-dir', dir, '--state-dir', dir]);
    assert.equal(JSON.parse(duplicate.stderr).error.code, 'INVALID_ARGUMENTS');
  });
});

test('oversized input is rejected before compiling', async () => {
  await fixture(async (dir, file) => {
    await writeFile(file, ' '.repeat(1_048_577));
    const result = await cli(['compile', '--input', file, '--output', join(dir, 'config.json')]);
    assert.equal(JSON.parse(result.stderr).error.code, 'INVALID_INPUT_SIZE');
  });
});

test('invalid UTF-8 cannot silently alter a credential', async () => {
  await fixture(async (dir, file) => {
    const parts = JSON.stringify(input).split(syntheticSecret);
    await writeFile(file, Buffer.concat([Buffer.from(parts[0]), Buffer.from([0xff]), Buffer.from(parts[1])]));
    const result = await cli(['compile', '--input', file, '--output', join(dir, 'config.json')]);
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stderr).error.code, 'INVALID_JSON');
  });
});

test('validation cannot silently substitute a mock or download a missing core', async () => {
  await fixture(async (dir, file) => {
    const result = await cli(['validate', '--input', file, '--mihomo-bin', join(dir, 'missing')]);
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stderr).error.code, 'BINARY_UNAVAILABLE');
    assert.equal(result.stdout, '');
  });
});
