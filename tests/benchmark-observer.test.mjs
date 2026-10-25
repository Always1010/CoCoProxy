import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { classifyRequest, startObserver } from '../scripts/benchmark-observer.mjs';

const fp = 'a'.repeat(64), connection = 'b'.repeat(64);
const request = { host: 'test.example', localIp: '192.0.2.10', localPort: 32123,
  remoteIp: '198.51.100.10', remotePort: 443, startedAtMs: 1000, endedAtMs: 2000 };
const event = (extra = {}) => ({ kind: 'connection', host: 'test.example', sourceIp: request.localIp,
  sourcePort: request.localPort, destinationIp: request.remoteIp, destinationPort: 443,
  receivedAtMs: 1500, route: 'direct', fingerprint: fp, connectionFingerprint: connection,
  ruleFingerprint: fp, rulePayloadFingerprint: fp, chainFingerprints: [fp], chainTypes: ['direct'], ...extra });

test('route requires a live matching socket; target labels and failed requests cannot prove it', () => {
  assert.equal(classifyRequest([event()], request).route, 'direct');
  for (const change of [{ sourceIp: '192.0.2.11' }, { sourcePort: 32124 }, { destinationPort: 80 },
    { receivedAtMs: 999 }, { receivedAtMs: 2001 }, { host: 'other.example', destinationIp: '198.51.100.11' }]) {
    assert.equal(classifyRequest([event(change)], request).status, 'unverified');
  }
  assert.equal(classifyRequest([event()], { ...request, localPort: null }).status, 'unverified');
  assert.equal(classifyRequest([event()], { ...request, intendedPath: 'proxy' }).route, 'direct');
  assert.equal(classifyRequest([event({ route: 'unknown' })], request).status, 'unverified');
});

test('source port reuse and selection changes remain ambiguous even when routes agree', () => {
  for (const extra of [{ connectionFingerprint: 'c'.repeat(64) }, { fingerprint: 'd'.repeat(64) }, { route: 'proxy' }]) {
    assert.equal(classifyRequest([event(), event(extra)], request).status, 'ambiguous');
  }
  assert.equal(classifyRequest([event(), event({ receivedAtMs: 1600 })], request).status, 'verified');
  assert.equal(classifyRequest([event(), { kind: 'snapshot', receivedAtMs: 1700, fingerprint: 'e'.repeat(64) }], request).status, 'ambiguous');
});

test('an unavailable optional observer is explicit and stops without spawning a process', async () => {
  const absent = await startObserver(null);
  assert.equal(absent.available, false);
  assert.equal(absent.classify(request).status, 'unverified');
  await absent.stop();
  await absent.stop();
  const invalid = await startObserver({ sshHost: '-oProxyCommand=bad', runtimeSettingsPath: '/synthetic/settings.json' },
    { sourceIps: ['192.0.2.10'], hosts: ['test.example'], seconds: 5 });
  assert.equal(invalid.events[0].reason, 'INVALID_OBSERVER_CONFIGURATION');
  await invalid.stop();
});

test('remote filter excludes other traffic and resolves types instead of misleading node names',
  { skip: !process.env.COCOPROXY_TEST_PYTHON }, () => {
    const program = `
import ast, json, pathlib, runpy, sys
path = pathlib.Path(sys.argv[1])
ast.parse(path.read_text(encoding="utf-8"))
m = runpy.run_path(str(path), run_name="synthetic_observer_test")
proxies = {"DIRECT": {"type":"Shadowsocks"}, "chosen": {"type":"Selector", "now":"DIRECT"},
           "direct-leaf": {"type":"Direct"}, "bad": {"type":"FutureUnknownType"}}
assert m["chain_evidence"](["DIRECT", "chosen"], proxies)[0] == "proxy"
assert m["chain_evidence"](["direct-leaf"], proxies)[0] == "direct"
assert m["chain_evidence"](["chosen"], proxies)[0] == "unknown"
assert m["chain_evidence"](["missing"], proxies)[0] == "unknown"
assert m["chain_evidence"](["bad"], proxies)[0] == "unknown"
def row(source="192.0.2.10", host="test.example"):
    return {"id":"synthetic-connection", "metadata":{"sourceIP":source, "sourcePort":"32123", "destinationIP":"198.51.100.10", "destinationPort":"443", "host":host}, "chains":["DIRECT", "chosen"], "rule":"DomainSuffix", "rulePayload":"test.example"}
output = m["filtered_connections"]([row(), row(source="192.0.2.99"), row(host="unrelated.example")], proxies, {"192.0.2.10"}, {"test.example"}, "a"*64)
assert len(output) == 1 and output[0]["route"] == "proxy"
encoded = json.dumps(output)
assert "unrelated.example" not in encoded and "chosen" not in encoded and '"DIRECT"' not in encoded
assert "DomainSuffix" not in encoded and "synthetic-connection" not in encoded
print("remote privacy and chain evidence passed")
`;
    const completed = spawnSync(process.env.COCOPROXY_TEST_PYTHON, ['-I', '-B', '-c', program,
      fileURLToPath(new URL('../scripts/benchmark-observer.py', import.meta.url))], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    assert.equal(completed.status, 0, completed.stderr || completed.error?.message);
  });

test('remote observer exits on stdin EOF and has a hard lifetime even when a read stalls',
  { skip: !process.env.COCOPROXY_TEST_PYTHON, timeout: 6000 }, async () => {
    const program = `
import runpy, sys, time
m = runpy.run_path(sys.argv[1], run_name="synthetic_observer_test")
m["main"].__globals__["controller"] = lambda _: time.sleep(30)
m["main"]()
`;
    for (const endInput of [true, false]) {
      const child = spawn(process.env.COCOPROXY_TEST_PYTHON, ['-I', '-B', '-c', program,
        fileURLToPath(new URL('../scripts/benchmark-observer.py', import.meta.url))],
      { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
      const completed = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error('REMOTE_OBSERVER_DID_NOT_EXIT')); }, 2500);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('close', code => { clearTimeout(timer); resolve(code); });
      });
      child.stdin.on('error', () => {});
      child.stdin.write(JSON.stringify({ runtimeSettingsPath: '/synthetic/settings.json',
        sourceIps: ['192.0.2.10'], hosts: ['test.example'], seconds: 1 }) + '\n');
      if (endInput) child.stdin.end();
      assert.equal(await completed, 0);
    }
  });
