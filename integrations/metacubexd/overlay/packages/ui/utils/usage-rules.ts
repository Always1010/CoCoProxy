export type UsageTarget = { value: string; kind: 'domain' | 'ipv4' | 'ipv6' }
export type UsageRuleType = 'DOMAIN' | 'DOMAIN-SUFFIX' | 'IP-CIDR' | 'IP-CIDR6'

/** Browser-safe normalization. Never interpret URLs, ports, abbreviated IPv4 or usage placeholders as targets. */
export function usageTarget(input: string): UsageTarget | null {
  const value = input.trim()
  if (!value || value.length > 253 || /[\s,/%\\?#@\u0000-\u001f\u007f]/.test(value) || /^(Unknown|Unattributed|Inner)$/i.test(value)) return null
  if (value.includes(':')) {
    const address = value.replace(/^\[([^\]]+)\]$/, '$1')
    try {
      const parsed = new URL(`http://[${address}]/`)
      return { value: parsed.hostname.slice(1, -1).toLowerCase(), kind: 'ipv6' }
    } catch { return null }
  }
  if (/^[\d.]+$/.test(value)) {
    const parts = value.split('.')
    return parts.length === 4 && parts.every(part => /^(0|[1-9]\d{0,2})$/.test(part) && +part <= 255)
      ? { value, kind: 'ipv4' } : null
  }
  if (/[\[\]]/.test(value)) return null
  try {
    const domain = new URL(`http://${value.replace(/\.$/, '')}/`).hostname.toLowerCase()
    // A URL parser may convert nonstandard numeric hosts into IP addresses.
    if (/^[\d.]+$/.test(domain) || !domain.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null
    return domain.length <= 253 ? { value: domain, kind: 'domain' } : null
  } catch { return null }
}

export function usageRuleDefault(target: UsageTarget): { type: UsageRuleType; payload: string } {
  return target.kind === 'domain' ? { type: 'DOMAIN', payload: target.value }
    : { type: target.kind === 'ipv4' ? 'IP-CIDR' : 'IP-CIDR6', payload: `${target.value}/${target.kind === 'ipv4' ? 32 : 128}` }
}

export function usageRulePayload(type: UsageRuleType, payload: string): string | null {
  if (type === 'DOMAIN' || type === 'DOMAIN-SUFFIX') {
    const target = usageTarget(payload)
    return target?.kind === 'domain' ? target.value : null
  }
  const [address = '', prefix = '', extra] = payload.trim().split('/')
  const target = usageTarget(address)
  if (!target || extra !== undefined || !/^\d{1,3}$/.test(prefix) || target.kind !== (type === 'IP-CIDR' ? 'ipv4' : 'ipv6') || +prefix > (type === 'IP-CIDR' ? 32 : 128)) return null
  if (target.kind === 'ipv4') {
    const value = target.value.split('.').reduce((sum, part) => (sum << 8n) | BigInt(part), 0n)
    const shift = 32n - BigInt(prefix), network = value >> shift << shift
    return `${[24n, 16n, 8n, 0n].map(bits => Number(network >> bits & 255n)).join('.')}/${+prefix}`
  }
  const [left = '', right = ''] = target.value.split('::')
  const words = [...left.split(':').filter(Boolean), ...Array(8 - left.split(':').filter(Boolean).length - right.split(':').filter(Boolean).length).fill('0'), ...right.split(':').filter(Boolean)]
  const value = words.reduce((sum, word) => (sum << 16n) | BigInt(`0x${word}`), 0n)
  const shift = 128n - BigInt(prefix), network = value >> shift << shift
  const networkAddress = Array.from({ length: 8 }, (_, index) => (network >> BigInt((7 - index) * 16) & 65535n).toString(16)).join(':')
  return `${usageTarget(networkAddress)!.value}/${+prefix}`
}

/** Same-condition conflicts include every target and optional no-resolve; unrelated order is preserved. */
export function usageRulePlan(current: string[], type: UsageRuleType, payload: string, target: string) {
  const normalized = usageRulePayload(type, payload)
  if (!normalized || !target || /[,\r\n\u0000-\u001f\u007f]/.test(target)) return null
  const rule = `${type},${normalized},${target}`
  const matches = current.map((value, index) => ({ value, index, parts: value.split(',').map(part => part.trim()) }))
    .filter(entry => entry.parts[0] === type && usageRulePayload(type, entry.parts[1] ?? '') === normalized)
  const conflicts = matches.filter(entry => entry.parts[2] !== target)
  const duplicate = matches.some(entry => entry.parts[2] === target) && conflicts.length === 0
  const removed = new Set(matches.map(entry => entry.index))
  return { rule, duplicate, conflicts: conflicts.map(({ value, index }) => ({ value, index })),
    rules: [rule, ...current.filter((_, index) => !removed.has(index))] }
}
