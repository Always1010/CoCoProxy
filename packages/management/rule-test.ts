import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import type { JsonObject } from '../config/index.ts';
import { ManagementError, exactRecord, readJsonBody } from './http.ts';

export type RuleTestInput = { target: string; network?: 'tcp' | 'udp'; destinationPort?: number; sourceIP?: string; sourcePort?: number };
export type RoutingSnapshot = {
  generation: string;
  config: JsonObject;
  disabled: number[];
  proxies: Record<string, { type?: string; now?: string; udp?: boolean }>;
};
export type RuleTestMatch = {
  status: 'matched' | 'indeterminate'; address?: string; policy?: string; chain?: string[];
  rule?: string; index?: number; detail: string; warning?: string;
};
export type RuleTestResult = { target: string; generation: string; checkedAt: string; results: RuleTestMatch[] };

export function normalizeRuleTarget(input: unknown): string {
  if (typeof input !== 'string' || !input.trim() || input.length > 1024) throw new ManagementError('RULE_TEST_TARGET_INVALID');
  const value = input.trim().replace(/^\[([\da-fA-F:.]+)\]$/, '$1');
  if (isIP(value) && !value.includes('%')) return value.toLowerCase();
  if (/[\s:/\\?#@%\[\]\u0000-\u001f\u007f]/.test(value) || /^[\d.]+$/.test(value)) throw new ManagementError('RULE_TEST_TARGET_INVALID');
  const domain = domainToASCII(value.replace(/\.$/, '')).toLowerCase();
  if (!domain || domain.length > 253 || !domain.split('.').every(label => /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/.test(label)))
    throw new ManagementError('RULE_TEST_TARGET_INVALID');
  return domain;
}

function inputOf(value: unknown): RuleTestInput {
  const body = exactRecord(value, ['target'], ['network', 'destinationPort', 'sourceIP', 'sourcePort']);
  const target = normalizeRuleTarget(body.target);
  if (body.network !== undefined && body.network !== 'tcp' && body.network !== 'udp') throw new ManagementError('RULE_TEST_INPUT_INVALID');
  for (const field of ['destinationPort', 'sourcePort']) if (body[field] !== undefined &&
    (!Number.isInteger(body[field]) || Number(body[field]) < 1 || Number(body[field]) > 65535)) throw new ManagementError('RULE_TEST_INPUT_INVALID');
  if (body.sourceIP !== undefined && (typeof body.sourceIP !== 'string' || !isIP(body.sourceIP) || body.sourceIP.includes('%'))) throw new ManagementError('RULE_TEST_INPUT_INVALID');
  return { ...body, target } as RuleTestInput;
}

function ipNumber(address: string): { bits: number; value: bigint } | null {
  const family = isIP(address);
  if (family === 4) return { bits: 32, value: address.split('.').reduce((value, part) => value * 256n + BigInt(part), 0n) };
  if (family !== 6) return null;
  let expanded = address.toLowerCase();
  if (expanded.includes('.')) {
    const offset = expanded.lastIndexOf(':');
    const mapped = ipNumber(expanded.slice(offset + 1));
    if (!mapped) return null;
    expanded = expanded.slice(0, offset + 1) + (mapped.value >> 16n).toString(16) + ':' + (mapped.value & 65535n).toString(16);
  }
  const halves = expanded.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const words = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  return { bits: 128, value: words.reduce((value, word) => value * 65536n + BigInt('0x' + word), 0n) };
}

function cidrMatch(address: string, payload: string): boolean | null {
  const [base, prefix, extra] = payload.split('/');
  const ip = ipNumber(address), network = ipNumber(base);
  if (!network || extra !== undefined || prefix === undefined || !/^\d+$/.test(prefix) || Number(prefix) > network.bits) return null;
  if (!ip || ip.bits !== network.bits) return false;
  const shift = BigInt(network.bits - Number(prefix));
  return ip.value >> shift === network.value >> shift;
}

function domainMatch(host: string, payload: string, suffix: boolean): boolean {
  const domain = payload.toLowerCase();
  return host === domain || (suffix && host.endsWith('.' + domain));
}

// Only bounded, compatible expressions are evaluated. Arbitrary subscription
// regexes may use regexp2 syntax and must never block Node's event loop.
function regexMatch(host: string, payload: string): boolean | null {
  const owned = ['.+\\.awsdns-cn-[0-9][0-9]\\.(biz|com|net|top)$', '.+\\.awsdns-cn-[0-9][a-e0-9]\\.cn$', '^.+-mihayo\\.akamaized\\.net$'];
  if (owned.includes(payload)) return new RegExp(payload, 'i').test(host);
  // Literal domain expressions with optional anchors and escaped dots are safe.
  if (!/^\^?[a-zA-Z0-9_\\.\-]+\$?$/.test(payload) || /\\(?!\.)/.test(payload)) return null;
  try { return new RegExp(payload, 'i').test(host); } catch { return null; }
}

function portMatch(port: number, payload: string): boolean | null {
  const ranges = payload.split('/');
  if (ranges.some(part => !/^\d+(?:-\d+)?$/.test(part))) return null;
  return ranges.some(part => { const [start, end = start] = part.split('-').map(Number); return port >= start && port <= end; });
}

type Evaluation = { matched: boolean; detail?: string } | { reason: string } | { resolve: true };
function evaluate(type: string, payload: string, input: RuleTestInput, address: string | undefined, resolved: boolean, noResolve: boolean, config: JsonObject): Evaluation {
  const host = isIP(input.target) ? '' : input.target;
  const answer = (matched: boolean | null, detail = payload): Evaluation => matched === null ? { reason: `暂不支持此规则的表达式：${type}` } : { matched, detail };
  if (type === 'MATCH' || type === 'FINAL') return answer(true, '未命中前面的规则，使用兜底策略');
  if (type === 'DOMAIN') return answer(!!host && domainMatch(host, payload, false));
  if (type === 'DOMAIN-SUFFIX') return answer(!!host && domainMatch(host, payload, true));
  if (type === 'DOMAIN-KEYWORD') return answer(!!host && host.includes(payload.toLowerCase()));
  if (type === 'DOMAIN-REGEX') return answer(regexMatch(host, payload));
  if (type === 'NETWORK') return input.network ? answer(input.network === payload.toLowerCase()) : { reason: '此规则需要 TCP／UDP 条件，请展开高级条件补充。' };
  if (type === 'DST-PORT' || type === 'SRC-PORT') {
    const port = type === 'DST-PORT' ? input.destinationPort : input.sourcePort;
    return port === undefined ? { reason: `此规则需要${type === 'DST-PORT' ? '目的' : '来源'}端口，请展开高级条件补充。` } : answer(portMatch(port, payload));
  }
  if (type === 'SRC-IP-CIDR' || type === 'SRC-IP-CIDR6') return input.sourceIP ? answer(cidrMatch(input.sourceIP, payload)) : { reason: '此规则需要来源 IP，请展开高级条件补充。' };
  if (type === 'IP-CIDR' || type === 'IP-CIDR6') {
    if (!address && host && !noResolve && !resolved) return { resolve: true };
    return answer(address ? cidrMatch(address, payload) : false);
  }
  if (type === 'RULE-SET') {
    const providers = config['rule-providers'] as Record<string, JsonObject> | undefined;
    const provider = providers?.[payload];
    if (!provider || provider.type !== 'inline' || !Array.isArray(provider.payload)) return { reason: '此规则集合暂不支持分析。' };
    if (provider.behavior === 'domain') {
      if (!host) return answer(false);
      for (const entry of provider.payload) {
        if (typeof entry !== 'string') return { reason: '规则集合内容无法分析。' };
        const suffix = entry.startsWith('+.');
        if (domainMatch(host, suffix ? entry.slice(2) : entry, suffix)) return answer(true, `域名集合 ${payload}：${entry}`);
      }
      return answer(false);
    }
    if (provider.behavior === 'ipcidr') {
      if (!address && host && !noResolve && !resolved) return { resolve: true };
      if (!address) return answer(false);
      for (const entry of provider.payload) {
        if (typeof entry !== 'string') return { reason: '规则集合内容无法分析。' };
        const matched = cidrMatch(address, entry);
        if (matched === null) return { reason: '规则集合包含无法分析的地址。' };
        if (matched) return answer(true, `IP 集合 ${payload}：${entry}`);
      }
      return answer(false);
    }
    return { reason: '此规则集合类型暂不支持分析。' };
  }
  return { reason: `规则 ${type} 需要额外连接信息或暂不支持分析，无法确定后续去向。` };
}

function outlet(policy: string, snapshot: RoutingSnapshot): { chain: string[]; warning?: string; pass?: boolean } {
  const chain: string[] = [];
  let name = policy;
  for (let step = 0; step < 32; step++) {
    if (chain.includes(name)) return { chain, warning: '策略组引用存在循环，无法确定出口。' };
    chain.push(name);
    const proxy = snapshot.proxies[name];
    if (name === 'PASS' || proxy?.type === 'Pass') return { chain, pass: true };
    if (proxy?.type === 'LoadBalance' || proxy?.type === 'Relay') return { chain, warning: '此策略组按连接选择或组合节点，无法仅由当前状态确定最终节点。' };
    if (proxy?.type === 'Rematch') return { chain, warning: '此策略会重新匹配连接，无法确定最终出口。' };
    if (proxy?.now) { name = proxy.now; continue; }
    if (['DIRECT', 'REJECT', 'REJECT-DROP'].includes(name)) return { chain };
    if (!proxy || ['Selector', 'URLTest', 'Fallback'].includes(proxy.type ?? '')) return { chain, warning: '内核未返回完整的当前选择，无法确定最终出口。' };
    return { chain };
  }
  return { chain, warning: '策略组引用过深，无法确定最终出口。' };
}

export async function analyzeRules(input: RuleTestInput, snapshot: RoutingSnapshot,
  resolve: () => Promise<string[]>): Promise<RuleTestMatch[]> {
  if (snapshot.config.mode === 'direct' || snapshot.config.mode === 'global') {
    const policy = snapshot.config.mode === 'direct' ? 'DIRECT' : 'GLOBAL';
    const route = outlet(policy, snapshot);
    return [{ status: 'matched', policy, chain: route.chain, warning: route.warning, detail: `当前核心使用${policy === 'DIRECT' ? '直连' : '全局'}模式。` }];
  }
  const rules = snapshot.config.rules;
  if (!Array.isArray(rules)) throw new ManagementError('RULE_TEST_UNAVAILABLE', 503);
  const orderedRules = rules;
  const disabled = new Set(snapshot.disabled);
  let addresses: string[] | undefined;
  async function match(address?: string, resolved = false, start = 0): Promise<RuleTestMatch[]> {
    for (let index = start; index < orderedRules.length; index++) {
      if (disabled.has(index)) continue;
      const rule = orderedRules[index];
      if (typeof rule !== 'string') throw new ManagementError('RULE_TEST_UNAVAILABLE', 503);
      const parts = rule.split(',').map(part => part.trim());
      const type = parts[0].toUpperCase();
      const final = type === 'MATCH' || type === 'FINAL';
      const policy = parts[final ? 1 : 2];
      if ((final && parts.length !== 2) || (!final && (parts.length < 3 || parts.length > 4)) || !policy ||
        (!final && parts.length === 4 && parts[3] !== 'no-resolve'))
        return [{ status: 'indeterminate', address, index, rule, detail: '此规则使用复杂表达式，暂无法分析。' }];
      const evaluation = evaluate(type, parts[1], input, address, resolved, parts[3] === 'no-resolve', snapshot.config);
      if ('resolve' in evaluation) {
        addresses ??= [...new Set(await resolve())].filter(value => isIP(value));
        if (!addresses.length) throw new ManagementError('RULE_TEST_DNS_FAILED', 502);
        if (addresses.length > 32) throw new ManagementError('RULE_TEST_DNS_FAILED', 502);
        return (await Promise.all(addresses.map(value => match(value, true, index)))).flat();
      }
      if ('reason' in evaluation) return [{ status: 'indeterminate', address, index, rule, detail: evaluation.reason }];
      if (!evaluation.matched) continue;
      const route = outlet(policy, snapshot);
      if (route.pass) continue;
      // UDP-ineligible adapters are skipped by Mihomo's matcher. Without a
      // protocol we cannot claim that a later rule will never be considered.
      const adapter = snapshot.proxies[policy];
      if (adapter?.udp === false && !['DIRECT', 'REJECT', 'REJECT-DROP'].includes(policy)) {
        if (input.network === 'udp') continue;
        if (!input.network) return [{ status: 'indeterminate', address, index, rule, detail: '此策略不支持 UDP，请在高级条件中指定 TCP／UDP。' }];
      }
      return [{ status: 'matched', address, policy, chain: route.chain, index, rule, detail: evaluation.detail ?? parts[1], warning: route.warning }];
    }
    return [{ status: 'matched', address, policy: 'DIRECT', chain: ['DIRECT'], detail: '未命中任何规则，内核默认直连。' }];
  }
  return match(isIP(input.target) ? input.target : undefined);
}

export function createRuleTestHandler(options: {
  snapshot: (signal: AbortSignal) => Promise<RoutingSnapshot>;
  resolve: (target: string, generation: string, ipv6: boolean, signal: AbortSignal) => Promise<string[]>;
  isCurrent: (generation: string) => Promise<boolean>;
}) {
  let running = 0;
  return async (request: Request): Promise<RuleTestResult> => {
    const input = inputOf(await readJsonBody(request, 4096));
    if (running >= 4) throw new ManagementError('RULE_TEST_BUSY', 429);
    running++;
    try {
      request.signal.throwIfAborted();
      const snapshot = await options.snapshot(request.signal);
      if (!await options.isCurrent(snapshot.generation)) throw new ManagementError('ACTIVE_CONFLICT', 409);
      const results = await analyzeRules(input, snapshot,
        () => options.resolve(input.target, snapshot.generation, snapshot.config.ipv6 === true, request.signal));
      request.signal.throwIfAborted();
      if (!await options.isCurrent(snapshot.generation)) throw new ManagementError('ACTIVE_CONFLICT', 409);
      return { target: input.target, generation: snapshot.generation, checkedAt: new Date().toISOString(), results };
    } finally { running--; }
  };
}
