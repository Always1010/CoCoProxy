type Translate = (key: string, named?: Record<string, unknown>) => string
const untranslated: Translate = key => key

export const domainRuleTypes = [
  { value: 'DOMAIN-SUFFIX', label: 'coco.domainSuffix' },
  { value: 'DOMAIN', label: 'coco.domainExact' },
  { value: 'DOMAIN-KEYWORD', label: 'coco.domainKeyword' },
  { value: 'DOMAIN-REGEX', label: 'coco.domainRegex' },
] as const

export function ruleTarget(rule: string): string {
  const parts = rule.split(',')
  return parts[0] === 'MATCH' ? parts[1] ?? '' : parts[2] ?? ''
}

export function isDomainRule(rule: string): boolean {
  return rule.split(',').length === 3 && domainRuleTypes.some(type => type.value === rule.split(',')[0])
}

export function domainRuleError(type: string, payload: string, t: Translate = untranslated): string {
  if (!payload.trim()) return t('coco.rulePayloadRequired')
  if (!domainRuleTypes.some(entry => entry.value === type)) return t('coco.ruleTypeRequired')
  if (/[,\r\n\u0000-\u001f\u007f]/.test(payload)) return t('coco.rulePayloadInvalid')
  if (type === 'DOMAIN' || type === 'DOMAIN-SUFFIX') {
    if (/:|\//.test(payload)) return t('coco.domainOnly')
    if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(payload) || payload.includes('..')) return t('coco.domainInvalid')
  }
  if (type === 'DOMAIN-REGEX') {
    try { new RegExp(payload) } catch { return t('coco.regexInvalid') }
  }
  return ''
}

/** Keep unrelated rules and their global positions intact; reject stale drafts. */
export class GroupRuleEditError extends Error {
  readonly messageKey: string
  constructor(messageKey: string, t: Translate = untranslated) {
    super(t(messageKey))
    this.messageKey = messageKey
  }
}

export function saveGroupRules(current: string[], original: string[], draft: string[], group: string, t: Translate = untranslated): string[] {
  if (JSON.stringify(current) !== JSON.stringify(original)) throw new GroupRuleEditError('coco.rulesChanged', t)
  const unrelated = (rules: string[]) => rules.filter(rule => ruleTarget(rule) !== group)
  if (JSON.stringify(unrelated(original)) !== JSON.stringify(unrelated(draft))) throw new GroupRuleEditError('coco.otherGroupRules', t)
  return [...draft]
}

export function templateRuleLabel(rule: string, t: Translate = untranslated): string {
  const [type, payload = ''] = rule.split(',')
  if (type === 'MATCH') return t('coco.finalRule')
  if (type === 'RULE-SET') {
    if (payload.startsWith('cocoproxy-domestic-domain-')) return t('coco.domesticDomains')
    if (payload.startsWith('cocoproxy-domestic-ip-')) return t('coco.domesticIps')
    if (payload.startsWith('cocoproxy-overseas-domain-')) return t('coco.overseasDomains')
    return t('coco.ruleSet', { payload })
  }
  return t('coco.ruleLabel', { label: domainRuleTypes.find(entry => entry.value === type)?.label ? t(domainRuleTypes.find(entry => entry.value === type)!.label) : type, payload })
}

export function localGroupNameError(name: string, view: { groups: { name: string }[]; nodes: string[]; catalog?: { id: string }[] }, shared = false, t: Translate = untranslated): string {
  const value = name.trim()
  if (!value) return t('coco.groupNameRequired')
  if (value.length > 80 || /[,\r\n\u0000-\u001f\u007f]/.test(value)) return t('coco.groupNameInvalid')
  if (['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE', 'GLOBAL', 'direct', 'block', 'reject', '__proto__', 'constructor', 'prototype'].includes(value)) return t('coco.groupNameReserved')
  if (view.groups.some(group => group.name === value)) return t('coco.groupNameExists')
  if (view.nodes.includes(value)) return t('coco.groupNameNode')
  if (view.catalog?.some(service => service.id === value)) return shared ? t('coco.sharedNamePreset') : t('coco.groupNamePreset')
  return ''
}

/** Local user-shared exits are reached through service groups; Proxy remains a legal built-in target. */
export function customRuleTargets(mode: string | undefined, groups: { name: string; role: 'service' | 'shared' }[] = []): string[] {
  return [...new Set(['DIRECT', 'REJECT', ...groups.filter(group => mode !== 'local' || group.role !== 'shared' || group.name === 'Proxy').map(group => group.name)])]
}
