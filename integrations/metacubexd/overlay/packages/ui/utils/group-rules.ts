export const domainRuleTypes = [
  { value: 'DOMAIN-SUFFIX', label: '域名及子域名' },
  { value: 'DOMAIN', label: '精确域名' },
  { value: 'DOMAIN-KEYWORD', label: '域名关键词' },
  { value: 'DOMAIN-REGEX', label: '域名正则' },
] as const

export function ruleTarget(rule: string): string {
  const parts = rule.split(',')
  return parts[0] === 'MATCH' ? parts[1] ?? '' : parts[2] ?? ''
}

export function isDomainRule(rule: string): boolean {
  return rule.split(',').length === 3 && domainRuleTypes.some(type => type.value === rule.split(',')[0])
}

export function domainRuleError(type: string, payload: string): string {
  if (!payload.trim()) return '请填写匹配内容。'
  if (!domainRuleTypes.some(entry => entry.value === type)) return '请选择支持的域名匹配方式。'
  if (/[,\r\n\u0000-\u001f\u007f]/.test(payload)) return '匹配内容不能包含逗号或控制字符。'
  if (type === 'DOMAIN' || type === 'DOMAIN-SUFFIX') {
    if (/:|\//.test(payload)) return '请只填写域名，不要包含协议、路径或端口。'
    if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(payload) || payload.includes('..')) return '请填写有效域名，例如 example.com。'
  }
  if (type === 'DOMAIN-REGEX') {
    try { new RegExp(payload) } catch { return '正则表达式无效，请检查后重试。' }
  }
  return ''
}

/** Keep unrelated rules and their global positions intact; reject stale drafts. */
export function saveGroupRules(current: string[], original: string[], draft: string[], group: string): string[] {
  if (JSON.stringify(current) !== JSON.stringify(original)) throw new Error('规则已发生变化，请重新打开匹配规则后编辑。')
  const unrelated = (rules: string[]) => rules.filter(rule => ruleTarget(rule) !== group)
  if (JSON.stringify(unrelated(original)) !== JSON.stringify(unrelated(draft))) throw new Error('不能修改其他策略组的规则。')
  return [...draft]
}

export function templateRuleLabel(rule: string): string {
  const [type, payload] = rule.split(',')
  if (type === 'MATCH') return '最终兜底：其他规则均未命中时使用本组'
  if (type === 'RULE-SET') {
    if (payload.startsWith('cocoproxy-domestic-domain-')) return '内置国内域名集合（随程序提供）'
    if (payload.startsWith('cocoproxy-domestic-ip-')) return '内置国内 IP 集合（随程序提供）'
    if (payload.startsWith('cocoproxy-overseas-domain-')) return '内置境外域名集合（随程序提供）'
    return `规则集合：${payload}`
  }
  return `${domainRuleTypes.find(entry => entry.value === type)?.label ?? type}：${payload}`
}

export function localGroupNameError(name: string, view: { groups: { name: string }[]; nodes: string[]; catalog?: { id: string }[] }, shared = false): string {
  const value = name.trim()
  if (!value) return '请填写组名。'
  if (value.length > 80 || /[,\r\n\u0000-\u001f\u007f]/.test(value)) return '组名最多 80 个字符，不能包含逗号或控制字符。'
  if (['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE', 'GLOBAL', 'direct', 'block', 'reject', '__proto__', 'constructor', 'prototype'].includes(value)) return '此名称为系统保留名称，请更换。'
  if (view.groups.some(group => group.name === value)) return '此策略组已存在，请更换名称。'
  if (view.nodes.includes(value)) return '组名不能与节点名称相同。'
  if (view.catalog?.some(service => service.id === value)) return shared ? '共享出口不能使用预置服务名称。' : '这是预置服务名称，请在上方启用对应服务组。'
  return ''
}
