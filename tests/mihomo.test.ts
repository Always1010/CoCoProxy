import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { compileConfig } from '../packages/config/index.ts';
import { MihomoValidationError, validateWithMihomo } from '../packages/mihomo/validator.ts';

const input = {
  schemaVersion: 1,
  deployment: {
    mixedPort: 17890, controllerPort: 19090, dnsPort: 15353,
    controllerSecret: 'synthetic-sensitive-value', bootstrapResolvers: ['192.0.2.53'],
  },
  policy: { proxies: [], 'proxy-groups': [], rules: ['MATCH,DIRECT'] },
};

async function fixture(body: string, run: (binary: string, dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'coproxy-checker-test-'));
  try {
    const binary = join(dir, 'checker');
    await writeFile(binary, '#!/usr/bin/env node\n' + body + '\n', { mode: 0o700 });
    await run(binary, dir);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('checker wrapper passes test-only flags and an isolated private config', async () => {
  await fixture([
    "const fs = require('node:fs');",
    'const args = process.argv.slice(2);',
    "if (args.length !== 5 || args[0] !== '-t' || args[1] !== '-d' || args[3] !== '-f') process.exit(2);",
    "const config = JSON.parse(fs.readFileSync(args[4], 'utf8'));",
    "if (config.tun.enable || config['allow-lan']) process.exit(3);",
    "if ((fs.statSync(args[4]).mode & 0o777) !== 0o600) process.exit(4);",
    "fs.writeFileSync(process.argv[1] + '.paths', JSON.stringify(args));",
  ].join('\n'), async (binary) => {
    await validateWithMihomo(compileConfig(input), { binaryPath: binary });
    const args = JSON.parse(await readFile(binary + '.paths', 'utf8'));
    await assert.rejects(readFile(args[4]), { code: 'ENOENT' });
  });
});

test('core rejection does not expose raw diagnostics containing credentials', async () => {
  await fixture("console.error('synthetic-sensitive-value'); process.exit(1);", async (binary) => {
    await assert.rejects(validateWithMihomo(compileConfig(input), { binaryPath: binary }), (error) => {
      assert.ok(error instanceof MihomoValidationError);
      assert.equal(error.code, 'CORE_CONFIG_REJECTED');
      assert.ok(!String(error).includes(input.deployment.controllerSecret));
      return true;
    });
  });
});

test('checker output has a combined bounded budget', async () => {
  await fixture("process.stdout.write('x'.repeat(8192));", async (binary) => {
    await assert.rejects(validateWithMihomo(compileConfig(input), {
      binaryPath: binary, maxOutputBytes: 128,
    }), { code: 'VALIDATION_OUTPUT_LIMIT' });
  });
});

test('checker timeout kills a process that ignores termination', async () => {
  await fixture("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);", async (binary) => {
    await assert.rejects(validateWithMihomo(compileConfig(input), {
      binaryPath: binary, timeoutMs: 400,
    }), { code: 'VALIDATION_TIMEOUT' });
  });
});

test('checker requires an explicit existing absolute binary', async () => {
  await assert.rejects(validateWithMihomo(compileConfig(input), { binaryPath: 'mihomo' }), {
    code: 'BINARY_PATH_MUST_BE_ABSOLUTE',
  });
  await fixture('', async (_binary, dir) => {
    await assert.rejects(validateWithMihomo(compileConfig(input), { binaryPath: join(dir, 'absent') }), {
      code: 'BINARY_UNAVAILABLE',
    });
  });
});

test('timeout finishes even when an escaped descendant holds inherited pipes', { timeout: 8_000 }, async () => {
  await fixture([
    "const fs = require('node:fs');",
    "const { spawn } = require('node:child_process');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: ['ignore', 1, 2] });",
    "fs.writeFileSync(process.argv[1] + '.pid', String(child.pid));",
    'setInterval(() => {}, 1000);',
  ].join('\n'), async (binary) => {
    let pid: number | undefined;
    try {
      await assert.rejects(validateWithMihomo(compileConfig(input), {
        binaryPath: binary, timeoutMs: 1_000,
      }), { code: 'VALIDATION_TIMEOUT' });
      pid = Number(await readFile(binary + '.pid', 'utf8'));
      // It is still holding stdout/stderr, so this proves the validator did not
      // wait for pipe EOF. A trusted core is required; this is not a sandbox.
      assert.ok(Number.isInteger(pid) && pid > 1);
      process.kill(pid, 0);
    } finally {
      if (!pid) {
        try { pid = Number(await readFile(binary + '.pid', 'utf8')); } catch { /* never spawned */ }
      }
      if (pid && Number.isInteger(pid) && pid > 1) {
        try { process.kill(-pid, 'SIGKILL'); } catch { /* already exited */ }
      }
    }
  });
});
