import { isIP } from 'node:net';
import { SetupError, type SetupEnvironment } from './input.ts';

export interface ListeningSocket { protocol: 'tcp' | 'udp'; family: 4 | 6; address: string; port: number; state: string; pids: number[] }
export interface ListeningTarget { id: 'management-port' | 'mixed-port' | 'controller-port' | 'dns-port' | 'https-port';
  address: string; port: number; protocols: ('tcp' | 'udp')[]; unit: string; executable: 'node' | 'core' | 'nginx' }
/** Parse numeric, headerless ss output; unknown shapes never mean an empty listener list. */
export function parseListeningSockets(output: string, family: 4 | 6): ListeningSocket[] {
  const sockets: ListeningSocket[] = [];
  for (const line of output.trim().split('\n').filter(Boolean)) {
    const fields = line.trim().split(/\s+/);
    if (!['tcp', 'udp'].includes(fields[0]) || !['LISTEN', 'UNCONN', 'ESTAB', 'SYN-SENT', 'SYN-RECV', 'FIN-WAIT-1', 'FIN-WAIT-2',
      'TIME-WAIT', 'CLOSE-WAIT', 'LAST-ACK', 'CLOSING', 'CLOSE', 'NEW-SYN-RECV', 'UNDEF'].includes(fields[1]) || fields.length < 6 ||
      !/^\d+$/.test(fields[2]) || !/^\d+$/.test(fields[3])) throw new SetupError('SETUP_OBSERVATION_INVALID');
    const match = /^(?:\[([^\]]+)\](?:%[^:\s]+)?|(.+)):(\d+)$/.exec(fields[4]);
    if (!match) throw new SetupError('SETUP_OBSERVATION_INVALID');
    const address = (match[1] ?? match[2]).split('%')[0];
    const port = Number(match[3]);
    if (address !== '*' && isIP(address) !== family || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new SetupError('SETUP_OBSERVATION_INVALID');
    }
    const pids = [...line.matchAll(/\bpid=(\d+)\b/g)].map(match => Number(match[1]));
    if (pids.some(pid => !Number.isSafeInteger(pid) || pid < 1)) throw new SetupError('SETUP_OBSERVATION_INVALID');
    sockets.push({ protocol: fields[0] as 'tcp' | 'udp', family, address, port, state: fields[1], pids: [...new Set(pids)] });
  }
  return sockets;
}
/** IPv6 wildcard binding can also reserve IPv4; ss alone cannot prove IPV6_V6ONLY. */
export function listenerOverlap(socket: ListeningSocket, target: ListeningTarget): 'yes' | 'possible' | 'no' {
  if (socket.port !== target.port || !target.protocols.includes(socket.protocol)) return 'no';
  if (socket.family === 4) return ['*', '0.0.0.0', target.address].includes(socket.address) ? 'yes' : 'no';
  if (['*', '::'].includes(socket.address)) return 'possible';
  const mapped = /^\[::ffff:([a-f0-9]+):([a-f0-9]+)\]$/i.exec(new URL('http://[' + socket.address + ']').hostname);
  if (mapped) {
    const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16);
    const ipv4 = [high >> 8, high & 255, low >> 8, low & 255].join('.');
    return ipv4 === '0.0.0.0' || ipv4 === target.address ? 'yes' : 'no';
  }
  return 'no';
}
export function setupListeningTargets(environment: SetupEnvironment): ListeningTarget[] {
  return [
    { id: 'management-port', address: '127.0.0.1', port: environment.ports.management, protocols: ['tcp'], unit: 'cocoproxy-management.service', executable: 'node' },
    { id: 'mixed-port', address: '127.0.0.1', port: environment.ports.mixed, protocols: ['tcp', 'udp'], unit: 'cocoproxy-mihomo.service', executable: 'core' },
    { id: 'controller-port', address: '127.0.0.1', port: environment.ports.controller, protocols: ['tcp'], unit: 'cocoproxy-mihomo.service', executable: 'core' },
    { id: 'dns-port', address: environment.network.gatewayIPv4, port: environment.ports.dns, protocols: ['tcp', 'udp'], unit: 'cocoproxy-mihomo.service', executable: 'core' },
    ...(environment.https?.mode === 'managed' ? [{ id: 'https-port' as const, address: environment.network.gatewayIPv4,
      port: Number(new URL(environment.management.origin).port || 443), protocols: ['tcp' as const], unit: 'cocoproxy-web.service', executable: 'nginx' as const }] : []),
  ];
}
