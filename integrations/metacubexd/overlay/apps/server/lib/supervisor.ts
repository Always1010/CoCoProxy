// The upstream Agent must never become a second lifecycle/configuration owner.
export function getAgent(): never { throw new Error('LEGACY_AGENT_DISABLED') }
