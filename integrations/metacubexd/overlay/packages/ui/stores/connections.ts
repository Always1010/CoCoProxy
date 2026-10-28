import type {
  Connection,
  ConnectionRawMessage,
  WsMsg,
} from '~/types'
import { defineStore } from 'pinia'

import { CONNECTIONS_TABLE_MAX_CLOSED_ROWS } from '~/constants'

export const useConnectionsStore = defineStore('connections', () => {
  const globalStore = useGlobalStore()

  // State
  // shallowRef: these hold large arrays of connection objects replaced wholesale
  // on every (per-second) WebSocket message. A deep `ref` would proxy every
  // connection and every nested metadata field reactively on each update — a
  // major per-second cost with hundreds/thousands of connections. We only ever
  // reassign `.value`, so shallow reactivity is sufficient and far cheaper.
  const allConnections = shallowRef<Connection[]>([])
  const activeConnections = shallowRef<Connection[]>([])
  const closedConnections = shallowRef<Connection[]>([])
  const latestConnectionMsg = shallowRef<WsMsg>(null)
  const paused = ref(false)

  // Persistent accounting is owned by the backend. Keep only live chart baselines here.
  let lastUploadTotal = 0
  let lastDownloadTotal = 0

  // Helper functions
  const restructRawMsgToConnection = (
    connections: ConnectionRawMessage[],
    prevActiveConnections: Connection[],
  ): Connection[] => {
    const prevMap = new Map<string, Connection>()
    prevActiveConnections.forEach((prev) => prevMap.set(prev.id, prev))

    return connections.map((connection) => {
      const prevConn = prevMap.get(connection.id)

      if (
        !prevConn ||
        typeof prevConn.download !== 'number' ||
        typeof prevConn.upload !== 'number'
      ) {
        return {
          ...connection,
          downloadSpeed: 0,
          uploadSpeed: 0,
        }
      }

      return {
        ...connection,
        downloadSpeed: connection.download - prevConn.download,
        uploadSpeed: connection.upload - prevConn.upload,
      }
    })
  }

  const mergeAllConnections = (activeConns: Connection[]) => {
    const seen = new Set<string>()
    const merged: Connection[] = []

    // Add new active connections first (fresh data)
    for (const c of activeConns) {
      if (!seen.has(c.id)) {
        seen.add(c.id)
        merged.push(c)
      }
    }

    // Append previous connections not in the new active list
    for (const c of allConnections.value) {
      if (!seen.has(c.id)) {
        seen.add(c.id)
        merged.push(c)
      }
    }

    // Trim to latest window
    const limit = activeConns.length + CONNECTIONS_TABLE_MAX_CLOSED_ROWS
    allConnections.value =
      limit > 0 && merged.length > limit ? merged.slice(-limit) : merged
  }

  const diffClosedConnections = (
    activeIds: Set<string>,
    allConns: Connection[],
  ) => allConns.filter((c) => !activeIds.has(c.id))

  // Update connections from WebSocket message
  const updateFromWsMsg = (msg: WsMsg) => {
    latestConnectionMsg.value = msg
    const rawConns = msg?.connections

    // Detect service restart
    const currentUploadTotal = msg?.uploadTotal || 0
    const currentDownloadTotal = msg?.downloadTotal || 0

    if (
      currentUploadTotal < lastUploadTotal ||
      currentDownloadTotal < lastDownloadTotal
    ) {
      globalStore.clearChartHistory()
    }

    lastUploadTotal = currentUploadTotal
    lastDownloadTotal = currentDownloadTotal

    if (!rawConns || rawConns.length === 0) return

    const activeConns = restructRawMsgToConnection(
      rawConns,
      activeConnections.value,
    )

    // Build the active-id set once and reuse it for both cleanup and the
    // closed-connection diff instead of rebuilding it in each helper.
    const activeIds = new Set(activeConns.map((c) => c.id))

    // Merge all connections
    mergeAllConnections(activeConns)

    if (!paused.value) {
      const closedConns = diffClosedConnections(activeIds, allConnections.value)
      activeConnections.value = activeConns
      closedConnections.value = closedConns.slice(
        -CONNECTIONS_TABLE_MAX_CLOSED_ROWS,
      )
    }
  }

  // Computed: speed grouped by proxy name
  const speedGroupByName = computed(() => {
    const returnMap: Record<string, number> = {}

    activeConnections.value.forEach((c) => {
      c.chains.forEach((chain) => {
        if (!returnMap[chain]) {
          returnMap[chain] = 0
        }
        returnMap[chain] += c.downloadSpeed
      })
    })

    return returnMap
  })

  // Endpoint changes reset live chart baselines, never backend history.
  const endpointStore = useEndpointStore()
  watch(
    () => endpointStore.selectedEndpoint,
    () => {
      lastUploadTotal = 0
      lastDownloadTotal = 0
    },
  )

  return {
    allConnections,
    activeConnections,
    closedConnections,
    latestConnectionMsg,
    paused,
    speedGroupByName,
    updateFromWsMsg,
    restructRawMsgToConnection,
  }
})
