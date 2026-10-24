import { types } from 'node:util';
import { renderNetworkPlan } from './plan.ts';

export class NetworkRulesError extends Error {
  readonly code = 'NETWORK_RULES_INVALID';
  constructor() { super('NETWORK_RULES_INVALID'); this.name = 'NetworkRulesError'; }
}

export interface NetworkRulesOptions {
  mode: 'blocked' | 'core-only' | 'active';
  /** In-process isolated kernel fixtures only; production executors must reject this scope. */
  fixtureCgroups?: { core: string; management: string | null };
}
export interface IpStep { args: string[] }
function fail(): never { throw new NetworkRulesError(); }
const productionCgroups = {
  core: '/system.slice/coproxy-mihomo.service', management: '/system.slice/coproxy-management.service',
};
function fields(value: unknown, allowed: string[], required: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some(key => typeof key !== 'string' || !allowed.includes(key)) ||
    required.some(key => !Object.hasOwn(descriptors, key))) fail();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys as string[]) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !('value' in descriptor)) fail();
    result[key] = descriptor.value;
  }
  return result;
}
function cgroup(value: unknown): { path: string; level: number } {
  if (typeof value !== 'string' || value.length > 512 ||
    !/^\/(?:[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,95})(?:\/[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,95}){0,15}$/.test(value)) fail();
  return { path: value, level: value.split('/').length - 1 };
}
function options(value: unknown) {
  const root = fields(value, ['mode', 'fixtureCgroups'], ['mode']);
  if (root.mode !== 'blocked' && root.mode !== 'core-only' && root.mode !== 'active') fail();
  let paths: { core: string; management: string | null } = productionCgroups;
  const fixture = Object.hasOwn(root, 'fixtureCgroups');
  if (fixture) {
    const supplied = fields(root.fixtureCgroups, ['core', 'management'], ['core', 'management']);
    const core = cgroup(supplied.core).path;
    const management = supplied.management === null ? null : cgroup(supplied.management).path;
    if (management !== null && (core === management || core.startsWith(management + '/') || management.startsWith(core + '/'))) fail();
    paths = { core, management };
  }
  return { mode: root.mode as NetworkRulesOptions['mode'], scope: fixture ? 'fixture' as const : 'production' as const,
    cgroups: { core: cgroup(paths.core), management: paths.management === null ? null : cgroup(paths.management) } };
}

interface Chain { name: string; definition: string; rules: string[] }
/** Expand only the fixed renderer's literal forms. nft 1.0.x JSON echo can
 * confuse anonymous-set IDs while replacing chains; scalar rules avoid that
 * cache path and keep the committed echo suitable for independent readback. */
function scalarRules(source: string): string[] {
  // A negative membership test is conjunction, never alternative rules.
  const rule = source.replace(/ip daddr != \{ ([\d.]+), ([\d.]+) \}/g, 'ip daddr != $1 ip daddr != $2');
  const protocols = 'meta l4proto { tcp, udp }';
  if (rule.includes(protocols)) return ['tcp', 'udp'].flatMap(protocol =>
    scalarRules(rule.replace(protocols, `meta l4proto ${protocol}`)));
  const addresses = /ip (saddr|daddr) \{ ([\d./]+), ([\d./]+) \}/.exec(rule);
  if (addresses) return [addresses[2], addresses[3]].flatMap(address =>
    scalarRules(rule.replace(addresses[0], `ip ${addresses[1]} ${address}`)));
  if (/[{}]/.test(rule)) fail();
  return [rule];
}
function table(name: string, chains: Chain[]) {
  // Replacements flush only the expected, previously verified owned chains.
  // Do not delete/recreate a table or silently accept additional foreign objects.
  const rules = chains.flatMap(chain => chain.rules.flatMap(scalarRules).map(rule => `add rule inet ${name} ${chain.name} ${rule}`));
  return {
    create: [`add table inet ${name}`, ...chains.map(chain =>
      `add chain inet ${name} ${chain.name} { ${chain.definition}; policy accept; }`), ...rules, ''].join('\n'),
    replace: [...chains.map(chain => `flush chain inet ${name} ${chain.name}`), ...rules, ''].join('\n'),
  };
}

function build(input: unknown, rawOptions: unknown) {
  // A rendered plan object is deliberately not accepted as authority. Revalidate
  // and normalize the complete deployment every time before interpolation.
  const plan = renderNetworkPlan(input);
  const opt = options(rawOptions);
  const d = plan.deployment;
  const active = opt.mode === 'active';
  const coreAllowed = opt.mode !== 'blocked';
  const quote = (text: string) => JSON.stringify(text);
  const ingress = quote(d.ingressInterface), tun = quote(d.tun.interface);
  const client = `${d.clientIPv4}/32`, router = `${d.routerIPv4}/32`;
  const hex = (number: number) => '0x' + number.toString(16).padStart(8, '0');
  const mask = hex(d.marks.mask), preserve = hex((~d.marks.mask) >>> 0);
  const mark = (role: 'capture' | 'egress' | 'return') => `meta mark & ${mask} == ${hex(d.marks[role])}`;
  const setMark = (role: 'capture' | 'return') => `meta mark set (meta mark & ${preserve}) | ${hex(d.marks[role])}`;
  const socket = (role: 'core' | 'management') => {
    const cg = opt.cgroups[role];
    if (!cg) return fail();
    return `meta skuid ${d.core.serviceUid} socket cgroupv2 level ${cg.level} ${quote(cg.path.slice(1))}`;
  };
  const allowedIngress = `iifname ${ingress} ether saddr ${d.routerMAC} ip saddr ${client}`;
  const exclusions = `ip daddr != { ${d.gatewayIPv4}, ${d.routerIPv4} }`;
  const dnsIngress = `iifname ${ingress} ether saddr ${d.routerMAC} ip saddr { ${client}, ${router} } ip daddr ${d.gatewayIPv4}`;
  const dnsSyn = `${dnsIngress} tcp dport ${d.dnsPort} tcp flags & (fin | syn | rst | ack) == syn`;
  const coreCgroup = `socket cgroupv2 level ${opt.cgroups.core.level} ${quote(opt.cgroups.core.path.slice(1))}`;
  const guard = table('coproxy_guard', [
    { name: 'input_guard', definition: 'type filter hook input priority -10', rules: [
      `iifname "lo" ip saddr 127.0.0.1 ip daddr ${d.gatewayIPv4} meta l4proto { tcp, udp } th dport ${d.dnsPort} accept`,
      ...(active ? [
        // Only an original SYN bound to the verified core listener can create
        // this DNS-only proof. Never restore the packet mark from conntrack.
        `${dnsSyn} ct direction original ${coreCgroup} ct mark set (ct mark & ${preserve}) | ${hex(d.marks.egress)} accept`,
        // A fresh SYN must prove listener origin again, including on tuple reuse.
        `${dnsSyn} drop`,
        `${dnsIngress} tcp dport ${d.dnsPort} ct direction original ct mark & ${mask} == ${hex(d.marks.egress)} accept`,
        `${dnsIngress} udp dport ${d.dnsPort} ${coreCgroup} accept`,
      ] : []),
      `meta l4proto { tcp, udp } th dport ${d.dnsPort} drop`,
    ] },
    { name: 'forward_guard', definition: 'type filter hook forward priority -10', rules: [
      ...(active ? [
        `${allowedIngress} ${exclusions} meta l4proto { tcp, udp } ${mark('capture')} oifname ${tun} accept`,
        `iifname ${tun} ip daddr ${client} meta l4proto { tcp, udp } ${mark('return')} oifname ${ingress} accept`,
      ] : []),
      `ip saddr ${client} drop`, `iifname ${tun} drop`, `oifname ${tun} drop`,
      `meta nfproto ipv6 iifname ${ingress} ether saddr ${d.routerMAC} drop`,
    ] },
    { name: 'output_guard', definition: 'type filter hook output priority -10', rules: [
      'oifname "lo" return',
      ...(coreAllowed ? [
        `${socket('core')} ${mark('egress')} oifname ${ingress} ip saddr ${d.gatewayIPv4} meta l4proto { tcp, udp } accept`,
        ...(active ? [
          // Linux 6.1 nft_socket cannot resolve request_sock to the listening
          // full socket for SYNACK. Restrict this alternative to the exact DNS
          // reply direction and SYNACK; ordinary upstream sockets still need cg.
          `meta skuid ${d.core.serviceUid} ${mark('egress')} ct direction reply ct mark & ${mask} == ${hex(d.marks.egress)} ip saddr ${d.gatewayIPv4} ip daddr { ${client}, ${router} } tcp sport ${d.dnsPort} tcp flags & (fin | syn | rst | ack) == (syn | ack) oifname ${ingress} accept`,
        ] : []),
        ...(opt.cgroups.management ? [`${socket('management')} meta mark & ${mask} == 0 meta l4proto { tcp, udp } th sport != ${d.dnsPort} accept`] : []),
      ] : []),
      `meta skuid ${d.core.serviceUid} drop`,
    ] },
  ]);
  const data = table('coproxy_data', [
    { name: 'classify_ingress', definition: 'type filter hook prerouting priority -150', rules: [
      `iifname ${ingress} ip saddr ${client} meta mark set meta mark & ${preserve}`,
      ...(active ? [`${allowedIngress} ${exclusions} meta l4proto { tcp, udp } ${setMark('capture')}`] : []),
    ] },
    // SO_MARK belongs to the originating socket. Do not manufacture a core
    // egress mark or modify unrelated local-output marks.
    { name: 'classify_output', definition: 'type route hook output priority -150', rules: [] },
    { name: 'classify_return', definition: 'type filter hook prerouting priority -149', rules: [
      `iifname ${tun} ip daddr ${client} meta mark set meta mark & ${preserve}`,
      ...(active ? [`iifname ${tun} ip daddr ${client} meta l4proto { tcp, udp } ${setMark('return')}`] : []),
    ] },
  ]);
  const route = (...args: (string | number)[]): IpStep => ({ args: ['-4', 'route', ...args.map(String)] });
  const blackholes = plan.blackholes.map(r => route('replace', 'blackhole', 'default', 'table', r.table,
    'proto', r.protocol, 'metric', r.metric));
  const rules = plan.rules.map(r => ({ args: ['-4', 'rule', 'add', 'priority', String(r.priority),
    'fwmark', `${hex(r.mark)}/${hex(r.mask)}`, ...(r.role === 'return' ? ['iif', d.tun.interface, 'to', client] : []),
    'lookup', String(r.table)] }));
  const prepareRoutes = plan.egressRoutes.map(r => route('replace', r.destination,
    ...('via' in r ? ['via', r.via!] : []), 'dev', r.interface,
    ...('scope' in r ? ['scope', r.scope!] : []), ...('preferredSource' in r ? ['src', r.preferredSource!] : []),
    'table', r.table, 'proto', r.protocol, 'metric', r.metric));
  const capture = plan.captureRoute;
  return { schemaVersion: 1, kind: 'coproxy-network-rules', mode: opt.mode, scope: opt.scope,
    generation: d.generation, planSha256: plan.sha256, cgroups: opt.cgroups,
    nft: { guard, data }, ip: { blackholes, rules, prepareRoutes,
      activateCapture: [route('replace', capture.destination, 'dev', capture.interface,
        'table', capture.table, 'proto', capture.protocol, 'metric', capture.metric)],
      withdrawCapture: [route('del', capture.destination, 'dev', capture.interface,
        'table', capture.table, 'proto', capture.protocol, 'metric', capture.metric)] } } as const;
}

export type NetworkRules = ReturnType<typeof build>;
/** Pure source rendering; no shell, host reads, device writes, or authorization. */
export function renderNetworkRules(input: unknown, options: NetworkRulesOptions): NetworkRules {
  try { return build(input, options); }
  catch { return fail(); }
}
