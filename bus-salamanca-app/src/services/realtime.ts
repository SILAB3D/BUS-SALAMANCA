import type { DepartureInsight, RealtimeNetworkMetadata, RealtimeSnapshot, RouteDirectionOption, RouteInsight, RouteStop, StopOption } from '../types'

const DEFAULT_REALTIME_URL = 'http://localhost:8787'
const EMULATOR_REALTIME_URLS = ['http://10.0.2.2:8787', 'http://10.0.3.2:8787']

interface StopArrivalsResponse {
  stopId: string
  arrivals: DepartureInsight[]
}

interface HubArrivalsResponse {
  stops: Record<string, DepartureInsight[]>
}

interface MetadataResponse {
  routes: RouteInsight[]
  stopOptions: StopOption[]
  routeDirectionOptions: RouteDirectionOption[]
  routeStopsByDirectionKey: Record<string, RouteStop[]>
}

function normalizeBaseUrl(baseUrl?: string): string {
  const raw = String(baseUrl ?? import.meta.env.VITE_REALTIME_URL ?? DEFAULT_REALTIME_URL).trim()
  return raw.replace(/\/$/, '')
}

function resolveBaseUrlCandidates(baseUrl?: string): string[] {
  const primary = normalizeBaseUrl(baseUrl)
  const candidates = new Set<string>([primary])

  try {
    const parsed = new URL(primary)
    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
      for (const emulatorUrl of EMULATOR_REALTIME_URLS) {
        candidates.add(emulatorUrl)
      }
    }
  } catch {
    // Ignore URL parse errors and keep the original candidate only.
  }

  return Array.from(candidates)
}

async function fetchJsonWithFallback<T>(baseUrl: string | undefined, pathBuilder: (normalizedBaseUrl: string) => string): Promise<T> {
  const candidates = resolveBaseUrlCandidates(baseUrl)
  let lastError: unknown = null

  for (const candidate of candidates) {
    try {
      return await fetchJson<T>(pathBuilder(candidate))
    } catch (error) {
      lastError = error
    }
  }

  throw (lastError ?? new Error('No se pudo consultar el servicio realtime.'))
}

export function getRealtimeBaseUrl(baseUrl?: string): string {
  return resolveBaseUrlCandidates(baseUrl)[0] ?? normalizeBaseUrl(baseUrl)
}

export async function getRealtimeSnapshot(baseUrl?: string): Promise<RealtimeSnapshot> {
  try {
    const data = await fetchJsonWithFallback<RealtimeSnapshot>(baseUrl, (resolvedBaseUrl) => `${resolvedBaseUrl}/status`)
    return {
      providerName: data.providerName ?? 'gtfs-rt-proxy',
      connected: Boolean(data.connected),
      vehicleCount: Number.isFinite(data.vehicleCount) ? Number(data.vehicleCount) : 0,
      tripUpdateCount: Number.isFinite(data.tripUpdateCount) ? Number(data.tripUpdateCount) : 0,
      updatedAt: data.updatedAt ?? null,
      statusMessage: data.statusMessage ?? 'Estado realtime disponible.',
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'No se pudo consultar el estado realtime.'
    return {
      providerName: 'gtfs-rt-proxy',
      connected: false,
      vehicleCount: 0,
      tripUpdateCount: 0,
      updatedAt: null,
      statusMessage: message,
    }
  }
}

export async function getStopRealtimeArrivals(baseUrl: string | undefined, stopId: string, limit = 8): Promise<DepartureInsight[]> {
  try {
    const data = await fetchJsonWithFallback<StopArrivalsResponse>(
      baseUrl,
      (resolvedBaseUrl) => `${resolvedBaseUrl}/stops/${encodeURIComponent(stopId)}/arrivals?limit=${Math.max(1, limit)}`,
    )
    return normalizeArrivals(data.arrivals)
  } catch {
    return []
  }
}

export async function getHubRealtimeArrivals(baseUrl: string | undefined, stopIds: string[], limit = 5): Promise<Record<string, DepartureInsight[]>> {
  if (stopIds.length === 0) {
    return {}
  }

  try {
    const data = await fetchJsonWithFallback<HubArrivalsResponse>(
      baseUrl,
      (resolvedBaseUrl) => `${resolvedBaseUrl}/hub/arrivals?stopIds=${encodeURIComponent(stopIds.join(','))}&limit=${Math.max(1, limit)}`,
    )
    const response: Record<string, DepartureInsight[]> = {}

    for (const [stopId, arrivals] of Object.entries(data.stops ?? {})) {
      response[stopId] = normalizeArrivals(arrivals)
    }

    return response
  } catch {
    return {}
  }
}

export async function getRealtimeNetworkMetadata(baseUrl?: string): Promise<RealtimeNetworkMetadata> {
  const data = await fetchJsonWithFallback<MetadataResponse>(
    baseUrl,
    (resolvedBaseUrl) => `${resolvedBaseUrl}/metadata`,
  )

  return {
    routes: Array.isArray(data.routes) ? data.routes : [],
    stopOptions: Array.isArray(data.stopOptions) ? data.stopOptions : [],
    routeDirectionOptions: Array.isArray(data.routeDirectionOptions) ? data.routeDirectionOptions : [],
    routeStopsByDirectionKey: data.routeStopsByDirectionKey ?? {},
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Error HTTP ${response.status} en ${url}`)
  }
  return response.json() as Promise<T>
}

function normalizeArrivals(arrivals: DepartureInsight[] | undefined): DepartureInsight[] {
  if (!Array.isArray(arrivals)) {
    return []
  }

  return arrivals.map((item) => ({
    ...item,
    // Arrivals returned by the realtime endpoints should be considered realtime
    // unless the server explicitly marks them otherwise. Fall back to `true`
    // when `isRealtime` is not provided to avoid mislabeling.
    isRealtime: item.isRealtime ?? true,
  }))
}
