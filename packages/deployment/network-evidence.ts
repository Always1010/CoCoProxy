/** Read-only resource predicates shared by doctor and final installation. */
export class NetworkObservationError extends Error {
  readonly code = 'INSTALL_NETWORK_OBSERVATION_INVALID';
  constructor() { super('INSTALL_NETWORK_OBSERVATION_INVALID'); }
}
type Resources = { egressPriority: number; egressTable: number; egressMark: number; clientCIDR?: string; clientIPv4?: string };
function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new NetworkObservationError();
  return value as Record<string, any>;
}
function rows(value: unknown): Record<string, any>[] {
  if (!Array.isArray(value)) throw new NetworkObservationError();
  return value.map(object);
}
function uint32(value: unknown): bigint {
  if (!(typeof value === 'number' && Number.isSafeInteger(value) || typeof value === 'string' && /^(?:0x[0-9a-f]+|\d+)$/i.test(value))) {
    throw new NetworkObservationError();
  }
  const result = BigInt(value);
  if (result < 0n || result > 0xffffffffn) throw new NetworkObservationError();
  return result;
}
/** Conservative mark overlap only; selectors, goto and suppress semantics are not evaluated. */
export function policyRuleConflicts(value: unknown, n: Resources): string[] {
  const conflicts = new Set<string>();
  for (const rule of rows(value)) {
    if (!Number.isSafeInteger(rule.priority) || rule.priority < 0) throw new NetworkObservationError();
    if ([n.egressPriority, n.egressPriority + 1, n.egressPriority + 2].includes(rule.priority) || rule.priority >= 9000 && rule.priority <= 9010) {
      conflicts.add('INSTALL_RULE_CONFLICT');
    }
    if (rule.fwmark === undefined) {
      if (rule.fwmask !== undefined) throw new NetworkObservationError();
      continue;
    }
    // iproute2 emits FIB_RULE_INVERT as JSON "not": null (ip/iprule.c print_null).
    const inverted = Object.hasOwn(rule, 'not');
    if (inverted && (rule.not !== null || Object.keys(rule).some(key =>
      !['priority', 'fwmark', 'fwmask', 'not', 'table', 'protocol', 'action', 'src', 'dst'].includes(key)) ||
      [rule.src, rule.dst].some(selector => selector !== undefined && !['all', '0.0.0.0/0'].includes(selector)))) {
      throw new NetworkObservationError();
    }
    const parts = typeof rule.fwmark === 'string' ? rule.fwmark.split('/') : [rule.fwmark];
    if (parts.length > 2 || parts.length === 2 && rule.fwmask !== undefined) throw new NetworkObservationError();
    const mark = uint32(parts[0]), mask = uint32(parts[1] ?? rule.fwmask ?? 0xffffffff);
    if ([n.egressMark, 2023, 2024].some(resource => {
      const matches = (BigInt(resource) & mask) === (mark & mask);
      return inverted ? !matches : matches;
    })) conflicts.add('INSTALL_RULE_MARK_CONFLICT');
  }
  return [...conflicts];
}
export function routeConflicts(value: unknown, n: Resources): string[] {
  const conflict = rows(value).some(route => {
    if (route.table !== undefined && !(Number.isSafeInteger(route.table) || typeof route.table === 'string' &&
      /^(?:\d+|main|local|default|unspec)$/.test(route.table))) throw new NetworkObservationError();
    if (route.dst !== undefined && typeof route.dst !== 'string') throw new NetworkObservationError();
    return [String(n.egressTable), ...(n.clientCIDR ? [String(n.egressTable + 20000)] : []), '2022'].includes(String(route.table)) ||
      n.clientIPv4 !== undefined && (route.table === 'main' || route.table === 254 || route.table === undefined) &&
      [n.clientIPv4, n.clientIPv4 + '/32'].includes(route.dst);
  });
  return conflict ? ['INSTALL_ROUTE_CONFLICT'] : [];
}
export function firewallConflicts(value: unknown): string[] {
  const entries = rows(object(value).nftables);
  for (const entry of entries) {
    if (entry.table === undefined && entry.metainfo === undefined) throw new NetworkObservationError();
    if (entry.table !== undefined && typeof object(entry.table).name !== 'string') throw new NetworkObservationError();
  }
  return entries.some(entry => ['cocoproxy_auto_guard', 'mihomo'].includes(entry.table?.name)) ? ['INSTALL_NFT_CONFLICT'] : [];
}
export function tunConflicts(value: unknown): string[] {
  const links = rows(value);
  if (links.some(link => typeof link.ifname !== 'string')) throw new NetworkObservationError();
  return links.some(link => link.ifname === 'cocoproxy-tun') ? ['INSTALL_TUN_CONFLICT'] : [];
}
export function networkReceiptRemoved(value: unknown): boolean {
  const receipt = object(value);
  if (receipt.schemaVersion !== 1 || !['removed', 'complete', 'incomplete'].includes(receipt.status)) throw new NetworkObservationError();
  return receipt.status === 'removed';
}
