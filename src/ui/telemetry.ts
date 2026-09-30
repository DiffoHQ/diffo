import { useQuery, useQueryClient } from '@tanstack/react-query'

/** Mirrors the server's TelemetryStatus (src/server/telemetry.ts). */
export interface TelemetryStatus {
  enabled: boolean
  source: 'default' | 'setting' | 'env'
  variable?: string
  notice: 'pending' | 'shown' | 'acknowledged'
  machineId: string | null
  dev: boolean
  docs: string
}

type TelemetryPut = { enabled: boolean } | { notice: 'shown' | 'acknowledged' }

/**
 * The usage-data state, shared across every repo's server like the theme.
 * `null` while loading, and when the server has none to show (an old server,
 * a dev client without its proxy): the page then shows nothing about it.
 */
export function useTelemetry() {
  const client = useQueryClient()
  const query = useQuery<TelemetryStatus | null>({
    queryKey: ['telemetry'],
    queryFn: async () => {
      try {
        const res = await fetch('/api/telemetry')
        if (!res.ok) return null
        return (await res.json()) as TelemetryStatus
      } catch {
        return null
      }
    },
    staleTime: Number.POSITIVE_INFINITY,
  })
  const put = async (body: TelemetryPut): Promise<void> => {
    try {
      const res = await fetch('/api/telemetry', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (res.ok) client.setQueryData(['telemetry'], (await res.json()) as TelemetryStatus)
    } catch {
      // the next load asks again
    }
  }
  return {
    status: query.data ?? null,
    markShown: () => void put({ notice: 'shown' }),
    acknowledge: () => void put({ notice: 'acknowledged' }),
    setEnabled: (on: boolean) => void put({ enabled: on }),
  }
}
