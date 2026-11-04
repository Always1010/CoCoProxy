export type UsageDeleteDimension = 'sourceIP' | 'host' | 'outbound' | 'process' | 'inboundUser' | 'route'
export type UsageDeleteScope = { mode: 'all' } | {
  mode: 'range'; startTime: number; endTime: number
  filters?: Partial<Record<UsageDeleteDimension, string>>
  selection?: { dimension: UsageDeleteDimension; values: string[] }
}
export interface UsageDeletePreview {
  token: string; expiresAt: number; sampledAt: number | null; scope: UsageDeleteScope
  resolution: 'minute' | 'day' | 'mixed'; detailRows: number; dailyRows: number; sources: number
  upload: number; download: number
}
