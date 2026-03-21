import JSZip from 'jszip'
import Papa from 'papaparse'

import type { DepartureInsight, FeedSummary, GtfsDataset, RouteDirectionOption, RouteInsight, RouteStop, ServiceDayType, StopOption } from '../types'

type ProgressCallback = (phase: string) => void

interface CsvMap {
  [key: string]: string | undefined
}

interface StopTimeRow {
  tripId: string
  stopId: string
  arrivalTime: string
  departureTime: string
  stopSequence: number
}

interface TripRow {
  tripId: string
  routeId: string
  serviceId: string
  headsign: string
  directionId: string
}

interface RouteRow {
  routeId: string
  shortName: string
  longName: string
  description: string
  routeColor: string
  routeTextColor: string
}

interface CalendarDateRow {
  serviceId: string
  date: string
  exceptionType: number
}

interface LoadOptions {
  onProgress?: ProgressCallback
}

export async function loadGtfsDataset(url: string, options?: LoadOptions): Promise<GtfsDataset> {
  const onProgress = options?.onProgress
  onProgress?.('Descargando GTFS...')

  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`No se pudo descargar el archivo GTFS (${response.status}).`)
  }

  const zipBuffer = await response.arrayBuffer()
  onProgress?.('Descomprimiendo GTFS...')

  const zip = await JSZip.loadAsync(zipBuffer)

  onProgress?.('Leyendo rutas...')
  const routesRaw = await readCsv(zip, 'routes.txt')
  onProgress?.('Leyendo paradas...')
  const stopsRaw = await readCsv(zip, 'stops.txt')
  onProgress?.('Leyendo viajes...')
  const tripsRaw = await readCsv(zip, 'trips.txt')
  onProgress?.('Leyendo tiempos de paso...')
  const stopTimesRaw = await readCsv(zip, 'stop_times.txt')
  onProgress?.('Leyendo calendario especial...')
  const calendarDatesRaw = await readCsv(zip, 'calendar_dates.txt', true)

  const routes = parseRoutes(routesRaw)
  const routesById = new Map(routes.map((route) => [route.routeId, route]))

  const stops = parseStops(stopsRaw)
  const stopMap = new Map(stops.map((stop) => [stop.stopId, stop]))

  const trips = parseTrips(tripsRaw)
  const tripsById = new Map(trips.map((trip) => [trip.tripId, trip]))

  const stopTimes = parseStopTimes(stopTimesRaw)
  const stopTimesByStopId = new Map<string, StopTimeRow[]>()
  const stopTimesByTripId = new Map<string, StopTimeRow[]>()

  for (const row of stopTimes) {
    const byStop = stopTimesByStopId.get(row.stopId) ?? []
    byStop.push(row)
    stopTimesByStopId.set(row.stopId, byStop)

    const byTrip = stopTimesByTripId.get(row.tripId) ?? []
    byTrip.push(row)
    stopTimesByTripId.set(row.tripId, byTrip)
  }

  for (const entries of stopTimesByTripId.values()) {
    entries.sort((a, b) => a.stopSequence - b.stopSequence)
  }

  const routeDirectionOptions = buildRouteDirectionOptions(routes, trips, stopTimesByTripId)

  const calendarDates = parseCalendarDates(calendarDatesRaw)
  const serviceIdsByDate = buildServiceIdsByDate(calendarDates)
  const serviceIdsByDayType = buildServiceIdsByDayType(calendarDates)

  const routeTripCount = new Map<string, number>()
  const routeHeadsigns = new Map<string, Set<string>>()

  for (const trip of trips) {
    routeTripCount.set(trip.routeId, (routeTripCount.get(trip.routeId) ?? 0) + 1)
    if (trip.headsign) {
      const set = routeHeadsigns.get(trip.routeId) ?? new Set<string>()
      set.add(trip.headsign)
      routeHeadsigns.set(trip.routeId, set)
    }
  }

  const routeInsights: RouteInsight[] = routes.map((route) => ({
    routeId: route.routeId,
    shortName: route.shortName,
    longName: route.longName,
    description: route.description,
    routeColor: route.routeColor,
    routeTextColor: route.routeTextColor,
    tripCount: routeTripCount.get(route.routeId) ?? 0,
    headsigns: Array.from(routeHeadsigns.get(route.routeId) ?? []),
  }))

  routeInsights.sort((a, b) => a.shortName.localeCompare(b.shortName, 'es', { numeric: true }))

  const summary: FeedSummary = {
    routes: routesRaw.length,
    stops: stopsRaw.length,
    trips: tripsRaw.length,
    stopTimes: stopTimesRaw.length,
    serviceDates: calendarDatesRaw.length,
  }

  const dataset: GtfsDataset = {
    summary,
    routes: routeInsights,
    stopOptions: stops,
    stopMap,
    getRouteDirectionOptions(): RouteDirectionOption[] {
      return routeDirectionOptions
    },
    findStops(query: string): StopOption[] {
      const normalized = normalizeText(query)
      if (!normalized) {
        return stops.slice(0, 120)
      }

      return stops
        .filter((stop) => normalizeText(stop.stopName).includes(normalized) || normalizeText(stop.stopId).includes(normalized))
        .slice(0, 120)
    },
    getUpcomingDepartures(stopId: string, referenceDate: Date, limit = 8, routeId?: string): DepartureInsight[] {
      const stopRows = stopTimesByStopId.get(stopId) ?? []
      const dateKey = toGtfsDate(referenceDate)

      const activeServiceIds = resolveActiveServiceIds(dateKey, serviceIdsByDate, trips)
      const activeServiceSet = new Set(activeServiceIds)

      const departures: DepartureInsight[] = []

      for (const row of stopRows) {
        const trip = tripsById.get(row.tripId)
        if (!trip) {
          continue
        }

        if (routeId && trip.routeId !== routeId) {
          continue
        }

        if (activeServiceSet.size > 0 && !activeServiceSet.has(trip.serviceId)) {
          continue
        }

        const route = routesById.get(trip.routeId)
        if (!route) {
          continue
        }

        const occurrence = buildOccurrence(referenceDate, row.departureTime || row.arrivalTime)
        const minutesUntil = Math.round((occurrence.getTime() - referenceDate.getTime()) / 60000)

        if (minutesUntil < -1) {
          continue
        }

        departures.push({
          stopId,
          tripId: row.tripId,
          routeId: trip.routeId,
          routeShortName: route.shortName,
          routeColor: route.routeColor,
          routeTextColor: route.routeTextColor,
          headsign: trip.headsign || route.longName || route.shortName,
          arrivalTime: row.arrivalTime,
          departureTime: row.departureTime,
          scheduledTime: row.departureTime,
          estimatedTime: row.departureTime,
          delaySeconds: null,
          isRealtime: false,
          minutesUntil,
        })
      }

      departures.sort((a, b) => {
        const left = a.minutesUntil ?? Number.MAX_SAFE_INTEGER
        const right = b.minutesUntil ?? Number.MAX_SAFE_INTEGER
        return left - right
      })

      return departures.slice(0, Math.max(1, limit))
    },
    getScheduledTimesByDayType(stopId: string, routeShortName: string, dayType: ServiceDayType, startHour: number, endHour: number): string[] {
      const stopRows = stopTimesByStopId.get(stopId) ?? []
      const serviceSet = new Set(serviceIdsByDayType[dayType])
      const schedule = new Set<string>()

      for (const row of stopRows) {
        const trip = tripsById.get(row.tripId)
        if (!trip) {
          continue
        }

        const route = routesById.get(trip.routeId)
        if (!route || route.shortName !== routeShortName) {
          continue
        }

        if (serviceSet.size > 0 && !serviceSet.has(trip.serviceId)) {
          continue
        }

        const hour = parseHour(row.departureTime)
        if (hour < startHour || hour > endHour) {
          continue
        }

        schedule.add(normalizeGtfsTime(row.departureTime))
      }

      return Array.from(schedule).sort(compareGtfsTime)
    },
    getRouteStops(routeShortName: string, pivotStopId?: string, headsign?: string): RouteStop[] {
      const route = routes.find((item) => item.shortName === routeShortName)
      if (!route) {
        return []
      }

      const normalizedHeadsign = normalizeText(headsign ?? '')
      const trip = trips.find((item) => {
        if (item.routeId !== route.routeId) {
          return false
        }

        if (!normalizedHeadsign) {
          return true
        }

        return normalizeText(item.headsign) === normalizedHeadsign
      })
      if (!trip) {
        return []
      }

      const routeStopRows = stopTimesByTripId.get(trip.tripId) ?? []
      const routeStops: RouteStop[] = routeStopRows
        .map((row) => {
          const stop = stopMap.get(row.stopId)
          if (!stop) {
            return null
          }
          return {
            stopId: stop.stopId,
            stopName: stop.stopName,
          }
        })
        .filter((item): item is RouteStop => item !== null)

      if (!pivotStopId) {
        return routeStops
      }

      const pivotIndex = routeStops.findIndex((stop) => stop.stopId === pivotStopId)
      if (pivotIndex <= 0) {
        return routeStops
      }

      return [...routeStops.slice(pivotIndex), ...routeStops.slice(0, pivotIndex)]
    },
  }

  onProgress?.('GTFS listo')
  return dataset
}

async function readCsv(zip: JSZip, fileName: string, optional = false): Promise<CsvMap[]> {
  const file = zip.file(fileName)
  if (!file) {
    if (optional) {
      return []
    }
    throw new Error(`No se encontro ${fileName} dentro del ZIP GTFS.`)
  }

  const text = await file.async('text')
  const parsed = Papa.parse<CsvMap>(text, {
    header: true,
    skipEmptyLines: true,
  })

  if (parsed.errors.length > 0) {
    throw new Error(`Error al leer ${fileName}: ${parsed.errors[0]?.message ?? 'parse error'}`)
  }

  return parsed.data
}

function parseRoutes(rows: CsvMap[]): RouteRow[] {
  return rows.map((row) => ({
    routeId: String(row.route_id ?? '').trim(),
    shortName: String(row.route_short_name ?? row.route_id ?? '').trim(),
    longName: String(row.route_long_name ?? '').trim(),
    description: String(row.route_desc ?? '').trim(),
    routeColor: normalizeColor(row.route_color, '173764'),
    routeTextColor: normalizeColor(row.route_text_color, 'FFFFFF'),
  })).filter((row) => row.routeId.length > 0)
}

function parseStops(rows: CsvMap[]): StopOption[] {
  const stops = rows.map((row) => ({
    stopId: String(row.stop_id ?? '').trim(),
    stopName: String(row.stop_name ?? '').trim(),
    lat: Number.parseFloat(String(row.stop_lat ?? '0')),
    lon: Number.parseFloat(String(row.stop_lon ?? '0')),
    url: String(row.stop_url ?? '').trim(),
  })).filter((stop) => stop.stopId.length > 0)

  stops.sort((a, b) => a.stopName.localeCompare(b.stopName, 'es', { sensitivity: 'base' }))
  return stops
}

function parseTrips(rows: CsvMap[]): TripRow[] {
  return rows.map((row) => ({
    tripId: String(row.trip_id ?? '').trim(),
    routeId: String(row.route_id ?? '').trim(),
    serviceId: String(row.service_id ?? '').trim(),
    headsign: String(row.trip_headsign ?? '').trim(),
    directionId: String(row.direction_id ?? '').trim(),
  })).filter((trip) => trip.tripId.length > 0 && trip.routeId.length > 0)
}

function buildRouteDirectionOptions(routes: RouteRow[], trips: TripRow[], stopTimesByTripId: Map<string, StopTimeRow[]>): RouteDirectionOption[] {
  const routeById = new Map(routes.map((route) => [route.routeId, route]))
  const groupedByRouteShortName = new Map<string, Array<RouteDirectionOption & { stopCount: number }>>()

  for (const trip of trips) {
    const route = routeById.get(trip.routeId)
    if (!route) {
      continue
    }

    const headsign = trip.headsign || route.longName || `Sentido ${trip.directionId || 'A'}`
    const normalizedHeadsign = normalizeText(headsign)
    const key = `${route.shortName}|${normalizedHeadsign}`
    const stopCount = stopTimesByTripId.get(trip.tripId)?.length ?? 0
    const optionsForRoute = groupedByRouteShortName.get(route.shortName) ?? []
    const existingIndex = optionsForRoute.findIndex((option) => option.key === key)

    const candidate: RouteDirectionOption & { stopCount: number } = {
      key,
      routeShortName: route.shortName,
      headsign,
      label: `Línea ${route.shortName} · ${headsign}`,
      stopCount,
    }

    if (existingIndex >= 0) {
      if (optionsForRoute[existingIndex].stopCount < candidate.stopCount) {
        optionsForRoute[existingIndex] = candidate
      }
    } else {
      optionsForRoute.push(candidate)
    }

    groupedByRouteShortName.set(route.shortName, optionsForRoute)
  }

  const options: RouteDirectionOption[] = []

  for (const [routeShortName, candidates] of groupedByRouteShortName.entries()) {
    candidates.sort((left, right) => {
      if (right.stopCount !== left.stopCount) {
        return right.stopCount - left.stopCount
      }
      return left.headsign.localeCompare(right.headsign, 'es', { sensitivity: 'base' })
    })

    const selected = candidates.slice(0, 2).map((item) => ({
      key: item.key,
      routeShortName: item.routeShortName,
      headsign: item.headsign,
      label: `Línea ${routeShortName} · ${item.headsign}`,
    }))

    options.push(...selected)
  }

  options.sort((left, right) => {
    const leftNum = Number.parseInt(left.routeShortName, 10)
    const rightNum = Number.parseInt(right.routeShortName, 10)
    if (Number.isFinite(leftNum) && Number.isFinite(rightNum) && leftNum !== rightNum) {
      return leftNum - rightNum
    }

    return left.label.localeCompare(right.label, 'es', { sensitivity: 'base' })
  })
  return options
}

function parseStopTimes(rows: CsvMap[]): StopTimeRow[] {
  return rows.map((row) => ({
    tripId: String(row.trip_id ?? '').trim(),
    stopId: String(row.stop_id ?? '').trim(),
    arrivalTime: normalizeGtfsTime(String(row.arrival_time ?? '').trim()),
    departureTime: normalizeGtfsTime(String(row.departure_time ?? row.arrival_time ?? '').trim()),
    stopSequence: Number.parseInt(String(row.stop_sequence ?? '0'), 10) || 0,
  })).filter((row) => row.tripId.length > 0 && row.stopId.length > 0)
}

function parseCalendarDates(rows: CsvMap[]): CalendarDateRow[] {
  return rows
    .map((row) => ({
      serviceId: String(row.service_id ?? '').trim(),
      date: String(row.date ?? '').trim(),
      exceptionType: Number.parseInt(String(row.exception_type ?? '0'), 10) || 0,
    }))
    .filter((row) => row.serviceId.length > 0 && row.date.length === 8)
}

function buildServiceIdsByDate(rows: CalendarDateRow[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>()

  for (const row of rows) {
    const set = map.get(row.date) ?? new Set<string>()
    if (row.exceptionType === 1) {
      set.add(row.serviceId)
    } else if (row.exceptionType === 2) {
      set.delete(row.serviceId)
    }
    map.set(row.date, set)
  }

  return map
}

function buildServiceIdsByDayType(rows: CalendarDateRow[]): Record<ServiceDayType, Set<string>> {
  const result: Record<ServiceDayType, Set<string>> = {
    weekday: new Set<string>(),
    saturday: new Set<string>(),
    sunday: new Set<string>(),
  }

  for (const row of rows) {
    if (row.exceptionType !== 1) {
      continue
    }

    const date = parseGtfsDate(row.date)
    const day = date.getDay()
    if (day === 0) {
      result.sunday.add(row.serviceId)
    } else if (day === 6) {
      result.saturday.add(row.serviceId)
    } else {
      result.weekday.add(row.serviceId)
    }
  }

  return result
}

function resolveActiveServiceIds(dateKey: string, byDate: Map<string, Set<string>>, trips: TripRow[]): Set<string> {
  const explicit = byDate.get(dateKey)
  if (explicit && explicit.size > 0) {
    return new Set(explicit)
  }

  return new Set(trips.map((trip) => trip.serviceId).filter(Boolean))
}

function normalizeColor(value: string | undefined, fallback: string): string {
  const raw = String(value ?? '').trim().replace('#', '').toUpperCase()
  if (/^[0-9A-F]{6}$/.test(raw)) {
    return `#${raw}`
  }
  return `#${fallback}`
}

function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
}

function normalizeGtfsTime(value: string): string {
  if (!value) {
    return '00:00:00'
  }

  const parts = value.split(':')
  const h = Number.parseInt(parts[0] ?? '0', 10) || 0
  const m = Number.parseInt(parts[1] ?? '0', 10) || 0
  const s = Number.parseInt(parts[2] ?? '0', 10) || 0

  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function parseHour(value: string): number {
  const normalized = normalizeGtfsTime(value)
  return Number.parseInt(normalized.split(':')[0] ?? '0', 10) || 0
}

function compareGtfsTime(left: string, right: string): number {
  return parseGtfsSeconds(left) - parseGtfsSeconds(right)
}

function parseGtfsSeconds(value: string): number {
  const normalized = normalizeGtfsTime(value)
  const [h, m, s] = normalized.split(':').map((part) => Number.parseInt(part, 10) || 0)
  return (h * 3600) + (m * 60) + s
}

function buildOccurrence(reference: Date, time: string): Date {
  const totalSeconds = parseGtfsSeconds(time)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  const occurrence = new Date(reference)
  occurrence.setHours(0, 0, 0, 0)
  occurrence.setDate(occurrence.getDate() + Math.floor(hours / 24))
  occurrence.setHours(hours % 24, minutes, seconds, 0)
  return occurrence
}

function toGtfsDate(value: Date): string {
  const year = value.getFullYear()
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')
  return `${year}${month}${day}`
}

function parseGtfsDate(value: string): Date {
  const year = Number.parseInt(value.slice(0, 4), 10)
  const month = Number.parseInt(value.slice(4, 6), 10)
  const day = Number.parseInt(value.slice(6, 8), 10)
  return new Date(year, (month - 1), day)
}
