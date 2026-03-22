import { CapacitorHttp } from '@capacitor/core'
import type { DepartureInsight } from '../types'

const WEB_FALLBACK_BASE_URL = 'https://salamancadetransportes.com/tiempos-de-llegada/'
const CACHE_TTL_MS = 10_000

interface CacheEntry {
  timestamp: number
  arrivals: DepartureInsight[]
}

const arrivalsCache = new Map<string, CacheEntry>()

export async function fetchWebArrivals(stopId: string, limit = 8): Promise<DepartureInsight[]> {
  const now = Date.now()
  const cached = arrivalsCache.get(stopId)
  if (cached && now - cached.timestamp < CACHE_TTL_MS) {
    return cached.arrivals.slice(0, limit)
  }

  try {
    const url = `${WEB_FALLBACK_BASE_URL}?ref=${encodeURIComponent(stopId)}`
    const response = await CapacitorHttp.get({ url })

    if (response.status !== 200) {
      return []
    }

    const html = typeof response.data === 'string' ? response.data : ''
    const arrivals = parseWebFallbackArrivals(html, stopId)
    arrivalsCache.set(stopId, { timestamp: now, arrivals })
    return arrivals.slice(0, limit)
  } catch {
    return []
  }
}

export async function fetchWebArrivalsForMultipleStops(
  stopIds: string[],
  limit = 5,
): Promise<Record<string, DepartureInsight[]>> {
  if (stopIds.length === 0) {
    return {}
  }

  const entries = await Promise.all(
    stopIds.map(async (stopId) => {
      const arrivals = await fetchWebArrivals(stopId, limit)
      return [stopId, arrivals] as [string, DepartureInsight[]]
    }),
  )

  return Object.fromEntries(entries)
}

function parseWebFallbackArrivals(html: string, stopId: string): DepartureInsight[] {
  const normalized = String(html ?? '').replace(/\r?\n/g, ' ')
  const rows: (DepartureInsight & { comparableEpochMs: number })[] = []
  const regex = /<b>\s*L[ií]nea\s*([^:<]+):\s*<\/b>[\s\S]*?<span[^>]*class="right"[^>]*>\s*(\d+)\s*minutos\s*<\/span>/gi
  const referenceDate = new Date()
  let match: RegExpExecArray | null = null

  while ((match = regex.exec(normalized)) !== null) {
    const routeShortName = String(match[1] ?? '').trim()
    const minutesUntil = Number.parseInt(String(match[2] ?? '0'), 10)
    if (!routeShortName || !Number.isFinite(minutesUntil)) {
      continue
    }

    const estimatedEpochMs = referenceDate.getTime() + minutesUntil * 60_000
    const estimatedTime = formatTime(estimatedEpochMs)

    rows.push({
      stopId,
      tripId: '',
      routeId: routeShortName,
      routeShortName,
      routeColor: '#173764',
      routeTextColor: '#FFFFFF',
      headsign: `Línea ${routeShortName}`,
      arrivalTime: estimatedTime,
      departureTime: estimatedTime,
      estimatedTime,
      scheduledTime: undefined,
      minutesUntil,
      delaySeconds: null,
      isRealtime: true,
      comparableEpochMs: estimatedEpochMs,
    })
  }

  return rows
    .sort((left, right) => left.comparableEpochMs - right.comparableEpochMs)
    .map(({ comparableEpochMs: _, ...arrival }) => arrival)
}

function formatTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString('es-ES', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}
