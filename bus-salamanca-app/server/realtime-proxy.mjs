import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import cors from 'cors'
import express from 'express'
import GtfsRealtimeBindings from 'gtfs-realtime-bindings'
import JSZip from 'jszip'
import Papa from 'papaparse'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')

const app = express()
app.use(cors())
app.use(express.json())

const config = {
  port: Number.parseInt(process.env.REALTIME_PORT ?? '8787', 10),
  staticZipPath: path.resolve(projectRoot, process.env.GTFS_STATIC_ZIP_PATH ?? 'public/data/gtfs.zip'),
  tripUpdatesUrl: process.env.GTFS_RT_TRIP_UPDATES_URL?.trim() ?? '',
  vehiclePositionsUrl: process.env.GTFS_RT_VEHICLE_POSITIONS_URL?.trim() ?? '',
  authHeader: process.env.GTFS_RT_AUTH_HEADER?.trim() ?? '',
  authToken: process.env.GTFS_RT_AUTH_TOKEN?.trim() ?? '',
  refreshMs: Number.parseInt(process.env.GTFS_RT_REFRESH_MS ?? '15000', 10),
  webFallbackEnabled: (process.env.REALTIME_WEB_FALLBACK_ENABLED ?? 'true').trim().toLowerCase() !== 'false',
  webBaseUrl: process.env.REALTIME_WEB_BASE_URL?.trim() ?? 'https://salamancadetransportes.com/tiempos-de-llegada/',
  webCacheMs: Number.parseInt(process.env.REALTIME_WEB_CACHE_MS ?? '10000', 10),
  staticScheduleFallbackEnabled: (process.env.REALTIME_STATIC_SCHEDULE_FALLBACK_ENABLED ?? 'false').trim().toLowerCase() === 'true',
}

const state = {
  staticLoaded: false,
  connected: false,
  providerName: 'gtfs-rt-proxy',
  vehicleCount: 0,
  tripUpdateCount: 0,
  updatedAt: null,
  statusMessage: 'Inicializando proxy realtime...',
  routesById: new Map(),
  stopsById: new Map(),
  tripsById: new Map(),
  staticStopTimesByStopId: new Map(),
  stopTimesByTripId: new Map(),
  routeDirectionOptions: [],
  routeStopsByDirectionKey: {},
  rtByTripStop: new Map(),
  rtByTripSequence: new Map(),
  webArrivalsCache: new Map(),
}

await bootstrap()

app.get('/status', (_request, response) => {
  response.json({
    providerName: state.providerName,
    connected: state.connected,
    vehicleCount: state.vehicleCount,
    tripUpdateCount: state.tripUpdateCount,
    updatedAt: state.updatedAt,
    statusMessage: state.statusMessage,
  })
})

app.get('/stops/:stopId/arrivals', async (request, response) => {
  const stopId = request.params.stopId
  const limit = Number.parseInt(String(request.query.limit ?? '8'), 10)

  const arrivals = await buildArrivalsForStop(stopId, sanitizeLimit(limit, 8))

  response.json({
    stopId,
    arrivals,
  })
})

app.get('/hub/arrivals', async (request, response) => {
  const stopIds = String(request.query.stopIds ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  const limit = sanitizeLimit(Number.parseInt(String(request.query.limit ?? '5'), 10), 5)

  const stopEntries = await Promise.all(
    stopIds.map(async (stopId) => [stopId, await buildArrivalsForStop(stopId, limit)])
  )

  response.json({
    stops: Object.fromEntries(stopEntries),
  })
})

app.get('/metadata', (_request, response) => {
  response.json({
    routes: Array.from(state.routesById.values()).map((route) => ({
      routeId: route.route_id,
      shortName: route.route_short_name || route.route_id,
      longName: route.route_long_name || route.route_short_name || route.route_id,
      description: route.route_desc || '',
      routeColor: normalizeColor(route.route_color, '173764'),
      routeTextColor: normalizeColor(route.route_text_color, 'FFFFFF'),
      tripCount: 0,
      headsigns: [],
    })),
    stopOptions: Array.from(state.stopsById.values()).map((stop) => ({
      stopId: stop.stop_id,
      stopName: stop.stop_name || stop.stop_id,
      lat: Number.parseFloat(stop.stop_lat || '0') || 0,
      lon: Number.parseFloat(stop.stop_lon || '0') || 0,
      url: stop.stop_url || '',
    })),
    routeDirectionOptions: state.routeDirectionOptions,
    routeStopsByDirectionKey: state.routeStopsByDirectionKey,
  })
})

app.listen(config.port, () => {
  console.log(`[realtime-proxy] Escuchando en http://localhost:${config.port}`)
})

if (config.tripUpdatesUrl || config.vehiclePositionsUrl) {
  void refreshRealtimeFeeds()
  setInterval(() => {
    void refreshRealtimeFeeds()
  }, config.refreshMs)
} else {
  state.statusMessage = config.webFallbackEnabled
    ? 'Proxy sin GTFS-RT directo. Usando fallback web por parada.'
    : 'Proxy iniciado sin feeds GTFS-RT configurados. Define GTFS_RT_TRIP_UPDATES_URL y/o GTFS_RT_VEHICLE_POSITIONS_URL.'
}

async function bootstrap() {
  await loadStaticGtfs()
}

async function loadStaticGtfs() {
  const zipBuffer = await fs.readFile(config.staticZipPath)
  const zip = await JSZip.loadAsync(zipBuffer)
  const routes = await readCsv(zip, 'routes.txt')
  const stops = await readCsv(zip, 'stops.txt')
  const trips = await readCsv(zip, 'trips.txt')
  const stopTimes = await readCsv(zip, 'stop_times.txt')

  state.routesById = new Map(routes.map((route) => [route.route_id, route]))
  state.stopsById = new Map(stops.map((stop) => [stop.stop_id, stop]))
  state.tripsById = new Map(trips.map((trip) => [trip.trip_id, trip]))
  state.staticStopTimesByStopId = new Map()
  state.stopTimesByTripId = new Map()

  for (const stopTime of stopTimes) {
    const listByTrip = state.stopTimesByTripId.get(stopTime.trip_id) ?? []
    listByTrip.push(stopTime)
    state.stopTimesByTripId.set(stopTime.trip_id, listByTrip)
  }

  for (const entries of state.stopTimesByTripId.values()) {
    entries.sort((left, right) => Number.parseInt(left.stop_sequence, 10) - Number.parseInt(right.stop_sequence, 10))
  }

  state.routeDirectionOptions = buildRouteDirectionOptions()
  state.routeStopsByDirectionKey = buildRouteStopsByDirectionKey()

  for (const stopTime of stopTimes) {
    const trip = state.tripsById.get(stopTime.trip_id)
    if (!trip) {
      continue
    }

    const route = state.routesById.get(trip.route_id)
    const current = state.staticStopTimesByStopId.get(stopTime.stop_id) ?? []

    current.push({
      stopId: stopTime.stop_id,
      stopSequence: Number.parseInt(stopTime.stop_sequence, 10),
      tripId: stopTime.trip_id,
      routeId: trip.route_id,
      routeShortName: route?.route_short_name || trip.route_id,
      routeColor: normalizeColor(route?.route_color, '173764'),
      routeTextColor: normalizeColor(route?.route_text_color, 'FFFFFF'),
      headsign: trip.trip_headsign || route?.route_long_name || trip.route_id,
      arrivalTime: stopTime.arrival_time,
      departureTime: stopTime.departure_time,
    })

    state.staticStopTimesByStopId.set(stopTime.stop_id, current)
  }

  state.staticLoaded = true
  state.statusMessage = 'GTFS estatico cargado. Esperando datos realtime.'
}

function buildRouteDirectionOptions() {
  const options = []
  const seen = new Set()

  for (const trip of state.tripsById.values()) {
    const route = state.routesById.get(trip.route_id)
    if (!route) {
      continue
    }

    const routeShortName = route.route_short_name || route.route_id
    const headsign = String(trip.trip_headsign || route.route_long_name || routeShortName).trim()
    const directionId = String(trip.direction_id ?? '').trim()
    const key = `${routeShortName}|${headsign}|${directionId}`
    if (seen.has(key)) {
      continue
    }

    seen.add(key)
    options.push({
      key,
      routeShortName,
      headsign,
      label: `${routeShortName} · ${headsign}`,
    })
  }

  options.sort((left, right) => left.label.localeCompare(right.label, 'es', { numeric: true }))
  return options
}

function buildRouteStopsByDirectionKey() {
  const result = {}

  for (const option of state.routeDirectionOptions) {
    const [routeShortName, headsign, directionId] = String(option.key).split('|')
    const trip = Array.from(state.tripsById.values()).find((candidate) => {
      const route = state.routesById.get(candidate.route_id)
      if (!route) {
        return false
      }

      const candidateShortName = route.route_short_name || route.route_id
      const candidateHeadsign = String(candidate.trip_headsign || route.route_long_name || candidateShortName).trim()
      const candidateDirectionId = String(candidate.direction_id ?? '').trim()

      return candidateShortName === routeShortName
        && candidateHeadsign === headsign
        && candidateDirectionId === directionId
    })

    if (!trip) {
      result[option.key] = []
      continue
    }

    const routeStops = (state.stopTimesByTripId.get(trip.trip_id) ?? []).map((entry) => {
      const stop = state.stopsById.get(entry.stop_id)
      return {
        stopId: entry.stop_id,
        stopName: stop?.stop_name || entry.stop_id,
      }
    })

    result[option.key] = routeStops
  }

  return result
}

async function refreshRealtimeFeeds() {
  const headers = buildAuthHeaders()

  try {
    const [tripUpdatesFeed, vehiclePositionsFeed] = await Promise.all([
      config.tripUpdatesUrl ? fetchGtfsRtFeed(config.tripUpdatesUrl, headers) : Promise.resolve(null),
      config.vehiclePositionsUrl ? fetchGtfsRtFeed(config.vehiclePositionsUrl, headers) : Promise.resolve(null),
    ])

    updateTripUpdatesState(tripUpdatesFeed)
    updateVehiclePositionsState(vehiclePositionsFeed)
    state.connected = Boolean(tripUpdatesFeed || vehiclePositionsFeed)
    state.updatedAt = new Date().toISOString()
    state.statusMessage = state.connected
      ? 'Feeds GTFS-RT cargados correctamente.'
      : 'No hay feeds GTFS-RT configurados.'
  } catch (error) {
    state.connected = false
    state.statusMessage = error instanceof Error
      ? `Error al refrescar GTFS-RT: ${error.message}`
      : 'Error desconocido al refrescar GTFS-RT.'
  }
}

async function fetchGtfsRtFeed(url, headers) {
  const response = await fetch(url, { headers })
  if (!response.ok) {
    throw new Error(`No se pudo descargar ${url}. HTTP ${response.status}.`)
  }

  const buffer = Buffer.from(await response.arrayBuffer())
  return GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buffer)
}

function updateTripUpdatesState(feed) {
  state.rtByTripStop = new Map()
  state.rtByTripSequence = new Map()
  state.tripUpdateCount = 0

  if (!feed) {
    return
  }

  for (const entity of feed.entity ?? []) {
    const tripUpdate = entity.tripUpdate
    const tripId = tripUpdate?.trip?.tripId
    if (!tripId) {
      continue
    }

    for (const stopUpdate of tripUpdate.stopTimeUpdate ?? []) {
      state.tripUpdateCount += 1

      const parsedUpdate = {
        arrivalTime: toNumber(stopUpdate.arrival?.time),
        arrivalDelay: toNumber(stopUpdate.arrival?.delay),
        departureTime: toNumber(stopUpdate.departure?.time),
        departureDelay: toNumber(stopUpdate.departure?.delay),
      }

      if (stopUpdate.stopId) {
        state.rtByTripStop.set(`${tripId}|${stopUpdate.stopId}`, parsedUpdate)
      }

      if (typeof stopUpdate.stopSequence === 'number') {
        state.rtByTripSequence.set(`${tripId}|${stopUpdate.stopSequence}`, parsedUpdate)
      }
    }
  }
}

function updateVehiclePositionsState(feed) {
  state.vehicleCount = feed?.entity?.filter((entity) => entity.vehicle)?.length ?? 0
}

async function buildArrivalsForStop(stopId, limit) {
  if (config.webFallbackEnabled) {
    const webArrivals = await getWebFallbackArrivals(stopId, limit)
    if (webArrivals.length > 0) {
      state.providerName = 'salamanca-web-fallback'
      state.connected = true
      state.updatedAt = new Date().toISOString()
      state.statusMessage = 'Datos de llegadas obtenidos desde la web publica por parada.'
      return webArrivals
    }

    state.providerName = 'salamanca-web-fallback'
    state.connected = false
    state.updatedAt = new Date().toISOString()
    state.statusMessage = 'No se han podido obtener llegadas desde la web publica para esta parada.'
  }

  if (!config.staticScheduleFallbackEnabled) {
    return []
  }

  const referenceDate = new Date()
  const staticRows = state.staticStopTimesByStopId.get(stopId) ?? []

  return staticRows
    .map((row) => {
      const scheduledEpochMs = buildNextOccurrence(row.arrivalTime, referenceDate)
      const realtimeUpdate = state.rtByTripStop.get(`${row.tripId}|${stopId}`)
        ?? state.rtByTripSequence.get(`${row.tripId}|${row.stopSequence}`)
        ?? null

      const estimatedEpochMs = resolveEstimatedEpochMs(realtimeUpdate, scheduledEpochMs)
      const delaySeconds = resolveDelaySeconds(realtimeUpdate, scheduledEpochMs, estimatedEpochMs)

      return {
        stopId,
        tripId: row.tripId,
        routeId: row.routeId,
        routeShortName: row.routeShortName,
        routeColor: row.routeColor,
        routeTextColor: row.routeTextColor,
        headsign: row.headsign,
        arrivalTime: formatTime(estimatedEpochMs),
        departureTime: formatTime(estimatedEpochMs),
        estimatedTime: formatTime(estimatedEpochMs),
        scheduledTime: row.arrivalTime,
        minutesUntil: Math.max(0, Math.round((estimatedEpochMs - referenceDate.getTime()) / 60000)),
        delaySeconds,
        isRealtime: Boolean(realtimeUpdate),
        comparableEpochMs: estimatedEpochMs,
      }
    })
    .filter((arrival) => arrival.comparableEpochMs >= referenceDate.getTime() - 60000)
    .sort((left, right) => left.comparableEpochMs - right.comparableEpochMs)
    .slice(0, limit)
    .map(({ comparableEpochMs, ...arrival }) => arrival)
}

async function getWebFallbackArrivals(stopId, limit) {
  const now = Date.now()
  const cached = state.webArrivalsCache.get(stopId)
  if (cached && now - cached.timestamp < config.webCacheMs) {
    return cached.arrivals.slice(0, limit)
  }

  try {
    const url = new URL(config.webBaseUrl)
    url.searchParams.set('ref', stopId)
    const response = await fetch(url)

    if (!response.ok) {
      return []
    }

    const html = await response.text()
    const arrivals = parseWebFallbackArrivals(html, stopId)
    state.webArrivalsCache.set(stopId, {
      timestamp: now,
      arrivals,
    })
    return arrivals.slice(0, limit)
  } catch {
    return []
  }
}

function parseWebFallbackArrivals(html, stopId) {
  const normalized = String(html ?? '').replace(/\r?\n/g, ' ')
  const rows = []
  const regex = /<b>\s*L[ií]nea\s*([^:<]+):\s*<\/b>[\s\S]*?<span[^>]*class="right"[^>]*>\s*(\d+)\s*minutos\s*<\/span>/gi
  const referenceDate = new Date()
  let match = null

  while ((match = regex.exec(normalized)) !== null) {
    const routeShortName = String(match[1] ?? '').trim()
    const minutesUntil = Number.parseInt(String(match[2] ?? '0'), 10)
    if (!routeShortName || !Number.isFinite(minutesUntil)) {
      continue
    }

    const estimatedEpochMs = referenceDate.getTime() + minutesUntil * 60000
    rows.push({
      stopId,
      tripId: null,
      routeId: routeShortName,
      routeShortName,
      routeColor: '173764',
      routeTextColor: 'FFFFFF',
      headsign: `Linea ${routeShortName}`,
      arrivalTime: formatTime(estimatedEpochMs),
      departureTime: formatTime(estimatedEpochMs),
      estimatedTime: formatTime(estimatedEpochMs),
      scheduledTime: null,
      minutesUntil,
      delaySeconds: null,
      isRealtime: true,
      comparableEpochMs: estimatedEpochMs,
    })
  }

  return rows
    .sort((left, right) => left.comparableEpochMs - right.comparableEpochMs)
    .map(({ comparableEpochMs, ...arrival }) => arrival)
}

async function readCsv(zip, fileName) {
  const file = zip.file(fileName)
  if (!file) {
    throw new Error(`Falta ${fileName} en el GTFS estatico.`)
  }

  const content = await file.async('text')
  const parsed = Papa.parse(content, {
    header: true,
    skipEmptyLines: true,
  })

  if (parsed.errors.length > 0) {
    throw new Error(`No se pudo parsear ${fileName}: ${parsed.errors[0]?.message ?? 'error desconocido'}.`)
  }

  return parsed.data
}

function buildAuthHeaders() {
  if (!config.authHeader || !config.authToken) {
    return undefined
  }

  return {
    [config.authHeader]: config.authToken,
  }
}

function buildNextOccurrence(timeString, referenceDate) {
  const [hoursPart = '0', minutesPart = '0', secondsPart = '0'] = String(timeString).split(':')
  const hours = Number.parseInt(hoursPart, 10)
  const minutes = Number.parseInt(minutesPart, 10)
  const seconds = Number.parseInt(secondsPart, 10)
  const candidate = new Date(referenceDate)
  candidate.setHours(0, 0, 0, 0)
  candidate.setSeconds(candidate.getSeconds() + hours * 3600 + minutes * 60 + seconds)

  if (candidate.getTime() < referenceDate.getTime() - 60000) {
    candidate.setDate(candidate.getDate() + 1)
  }

  return candidate.getTime()
}

function resolveEstimatedEpochMs(realtimeUpdate, scheduledEpochMs) {
  if (!realtimeUpdate) {
    return scheduledEpochMs
  }

  if (typeof realtimeUpdate.arrivalTime === 'number') {
    return realtimeUpdate.arrivalTime * 1000
  }

  if (typeof realtimeUpdate.departureTime === 'number') {
    return realtimeUpdate.departureTime * 1000
  }

  if (typeof realtimeUpdate.arrivalDelay === 'number') {
    return scheduledEpochMs + realtimeUpdate.arrivalDelay * 1000
  }

  if (typeof realtimeUpdate.departureDelay === 'number') {
    return scheduledEpochMs + realtimeUpdate.departureDelay * 1000
  }

  return scheduledEpochMs
}

function resolveDelaySeconds(realtimeUpdate, scheduledEpochMs, estimatedEpochMs) {
  if (!realtimeUpdate) {
    return null
  }

  if (typeof realtimeUpdate.arrivalDelay === 'number') {
    return realtimeUpdate.arrivalDelay
  }

  if (typeof realtimeUpdate.departureDelay === 'number') {
    return realtimeUpdate.departureDelay
  }

  return Math.round((estimatedEpochMs - scheduledEpochMs) / 1000)
}

function formatTime(epochMs) {
  return new Date(epochMs).toLocaleTimeString('es-ES', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

function normalizeColor(value, fallback) {
  const candidate = String(value ?? '').trim().replace('#', '')
  return /^[0-9A-Fa-f]{6}$/.test(candidate) ? candidate.toUpperCase() : fallback
}

function sanitizeLimit(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.min(value, 20) : fallback
}

function toNumber(value) {
  return typeof value === 'number' ? value : null
}