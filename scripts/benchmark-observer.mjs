import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';

const maximumEvents = 20_000;
const hostName = value => typeof value === 'string' ? domainToASCII(value.replace(/\.$/, '').toLowerCase()) : '';
const port = value => Number.isInteger(Number(value)) && Number(value) > 0 && Number(value) <= 65535 ? Number(value) : null;
const fingerprint = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const noEvidence = reason => ({ status: 'unverified', route: 'unknown', reason });

/** Match a live controller observation to one curl socket using local epoch time.
 * A domain, a configured rule, or a group name alone never proves a route.
 */
export function classifyRequest(events, request) {
  const host = hostName(request.host), localPort = port(request.localPort), remotePort = port(request.remotePort);
  if (!host || !isIP(request.localIp ?? '') || !localPort || !remotePort ||
      !Number.isFinite(request.startedAtMs) || !Number.isFinite(request.endedAtMs) || request.endedAtMs < request.startedAtMs) {
    return noEvidence('REQUEST_SOCKET_EVIDENCE_INCOMPLETE');
  }
  const matches = events.filter(row => row.kind === 'connection' && row.sourceIp === request.localIp &&
    row.sourcePort === localPort && row.destinationPort === remotePort &&
    (row.host === host || (isIP(request.remoteIp ?? '') && row.destinationIp === request.remoteIp)) &&
    row.receivedAtMs >= request.startedAtMs && row.receivedAtMs <= request.endedAtMs);
  if (!matches.length) return noEvidence('NO_MATCHING_LIVE_CONNECTION');
  const identities = new Set(matches.map(row => row.connectionFingerprint));
  const states = new Set(matches.map(row => row.fingerprint));
  for (const row of events) {
    if (row.kind === 'snapshot' && row.receivedAtMs >= request.startedAtMs && row.receivedAtMs <= request.endedAtMs) {
      states.add(row.fingerprint);
    }
  }
  const routes = new Set(matches.map(row => row.route));
  if (identities.size !== 1 || states.size !== 1 || routes.size !== 1) {
    return { status: 'ambiguous', route: 'unknown', reason: 'CONNECTION_OR_SELECTION_CHANGED', matches: matches.length };
  }
  const row = matches[0];
  if (!['direct', 'proxy', 'reject'].includes(row.route)) return noEvidence('INCOMPLETE_PROXY_CHAIN');
  return { status: 'verified', route: row.route, fingerprint: row.fingerprint,
    connectionFingerprint: row.connectionFingerprint, matches: matches.length,
    ruleFingerprint: row.ruleFingerprint, rulePayloadFingerprint: row.rulePayloadFingerprint,
    chainFingerprints: row.chainFingerprints, chainTypes: row.chainTypes };
}

/** Optional explicit private-config adapter. It makes no network changes.
 * Python code and filters travel through SSH stdin; no remote file is created.
 */
export async function startObserver(config, { sourceIps = [], hosts = [], seconds = 600, log = () => {} } = {}) {
  const events = [];
  let available = false, child, stopped = false, stopping, finished = false;
  const result = { events, get available() { return available; },
    classify: request => classifyRequest(events, request),
    stop: () => {
      if (stopping) return stopping;
      stopped = true;
      stopping = new Promise(resolve => {
        if (!child || finished) return resolve();
        const timer = setTimeout(() => { child.kill(); resolve(); }, 3000);
        child.once('close', () => { clearTimeout(timer); resolve(); });
        child.stdin.end();
      });
      return stopping;
    } };
  if (!config) return result;
  const ips = [...new Set(sourceIps.filter(value => typeof value === 'string' && isIP(value)))];
  const selectedHosts = [...new Set(hosts.map(hostName).filter(Boolean))];
  if (typeof config.sshHost !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,200}$/.test(config.sshHost) ||
      typeof config.runtimeSettingsPath !== 'string' || !config.runtimeSettingsPath.startsWith('/') ||
      /[\x00-\x1f\x7f]/.test(config.runtimeSettingsPath) || config.runtimeSettingsPath.length > 4096 ||
      !ips.length || ips.length > 32 || !selectedHosts.length || selectedHosts.length > 100 ||
      !Number.isFinite(seconds) || seconds < 1 || seconds > 7200) {
    events.push({ kind: 'unavailable', reason: 'INVALID_OBSERVER_CONFIGURATION', receivedAtMs: Date.now() });
    return result;
  }
  try {
    const script = await readFile(new URL('./benchmark-observer.py', import.meta.url));
    // Fixed remote command: all private paths and filter values use the stdin JSON.
    const bootstrap = 'import sys; n=int(sys.stdin.buffer.readline()); exec(compile(sys.stdin.buffer.read(n), "<benchmark-observer>", "exec"))';
    child = spawn('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=5',
      '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=1', config.sshHost,
      `sudo -n python3 -u -c '${bootstrap}'`], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let pending = '';
    const close = () => { finished = true; clearTimeout(watchdog); };
    const watchdog = setTimeout(() => { if (!finished) void result.stop(); }, (seconds + 12) * 1000);
    child.on('close', close);
    child.on('error', () => {
      available = false;
      events.push({ kind: 'unavailable', reason: 'SSH_OBSERVER_UNAVAILABLE', receivedAtMs: Date.now() });
    });
    child.stdin.on('error', () => { /* A failed SSH connection can close stdin early. */ });
    child.stdout.on('data', data => {
      if (stopped) return;
      pending += data.toString('utf8');
      if (pending.length > 1_048_576) { available = false; void result.stop(); return; }
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        const receivedAtMs = Date.now();
        if (message.kind === 'unavailable') {
          available = false;
          if (events.length < maximumEvents) events.push({ kind: 'unavailable', reason: 'READ_ONLY_OBSERVATION_FAILED', receivedAtMs });
          continue;
        }
        if (message.kind !== 'snapshot' || !fingerprint(message.fingerprint) || !Array.isArray(message.connections)) continue;
        available = true;
        if (events.length >= maximumEvents) { available = false; void result.stop(); break; }
        events.push({ kind: 'snapshot', fingerprint: message.fingerprint,
          generationFingerprint: fingerprint(message.generationFingerprint) ? message.generationFingerprint : null,
          selectionFingerprint: fingerprint(message.selectionFingerprint) ? message.selectionFingerprint : null,
          changed: message.changed === true, receivedAtMs });
        for (const row of message.connections) {
          // Independently reapply the privacy filter to all remote output.
          if (!row || !ips.includes(row.sourceIp) || !selectedHosts.includes(row.host) || !isIP(row.destinationIp ?? '') ||
              !port(row.sourcePort) || !port(row.destinationPort) || !fingerprint(row.connectionFingerprint) ||
              row.fingerprint !== message.fingerprint || events.length >= maximumEvents) continue;
          events.push({ kind: 'connection', receivedAtMs, sourceIp: row.sourceIp, sourcePort: Number(row.sourcePort),
            destinationIp: row.destinationIp, destinationPort: Number(row.destinationPort), host: row.host,
            connectionFingerprint: row.connectionFingerprint, fingerprint: message.fingerprint,
            route: ['direct', 'proxy', 'reject'].includes(row.route) ? row.route : 'unknown',
            ruleFingerprint: fingerprint(row.ruleFingerprint) ? row.ruleFingerprint : null,
            rulePayloadFingerprint: fingerprint(row.rulePayloadFingerprint) ? row.rulePayloadFingerprint : null,
            chainFingerprints: Array.isArray(row.chainFingerprints) ? row.chainFingerprints.filter(fingerprint).slice(0, 64) : [],
            chainTypes: Array.isArray(row.chainTypes) ? row.chainTypes.filter(value => typeof value === 'string' && /^[a-z0-9]{1,32}$/.test(value)).slice(0, 64) : [] });
        }
      }
    });
    child.stdin.write(String(script.length) + '\n');
    child.stdin.write(script);
    child.stdin.write(JSON.stringify({ runtimeSettingsPath: config.runtimeSettingsPath, sourceIps: ips, hosts: selectedHosts, seconds }) + '\n');
    log('Read-only connection observation started; route evidence requires a matching live socket.');
  } catch {
    available = false;
    events.push({ kind: 'unavailable', reason: 'SSH_OBSERVER_UNAVAILABLE', receivedAtMs: Date.now() });
  }
  return result;
}
