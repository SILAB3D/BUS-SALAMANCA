import JSZip from 'jszip'
import Papa from 'papaparse'

import type { Network } from './network'
import type { ScheduleDataset, ServiceDayType } from '../types'

/**
 * Horario programado a partir del GTFS estatico (`public/data/gtfs.zip`).
 *
 * Solo se usa como REFERENCIA de horario teorico (columna "hora prevista" de la
 * monitorizacion). Los tiempos que se muestran como llegadas provienen siempre de
 * la fuente en tiempo real; nunca se mezclan ambos origenes.
 *
 * Nota: el feed distribuido declara servicio dia a dia en `calendar_dates.txt` con
 * un `service_id` distinto por fecha, por lo que caduca. `stale` avisa de ello.
 *
 * Sentidos: cada `route_id` del GTFS es en realidad UN sentido ("Cementerio (295)
 * > Puente Ladrillo (309)"), con el mismo rotulo que publica la red oficial. Se
 * emparejan por ese rotulo, de modo que el horario se puede filtrar por sentido.
 * Sin ese filtro, en una parada por la que pasan los dos sentidos de la linea las
 * salidas de ambos se mezclaban y cualquier paso observado encontraba una hora
 * programada a uno o dos minutos: el desvio salia siempre "en hora" y la medicion
 * no valia para nada.
 */

type CsvRow = Record<string, string | undefined>

interface StopTimeRow {
  tripId: string
  stopId: string
  clock: string
}

export async function loadSchedule(
  network: Network | null = null,
  url = '/data/gtfs.zip',
): Promise<ScheduleDataset> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`No se pudo descargar el GTFS estatico (HTTP ${response.status}).`)
  }

  const zip = await JSZip.loadAsync(await response.arrayBuffer())

  const [routes, trips, stopTimes, calendarDates] = await Promise.all([
    readCsv(zip, 'routes.txt'),
    readCsv(zip, 'trips.txt'),
    readCsv(zip, 'stop_times.txt'),
    readCsv(zip, 'calendar_dates.txt'),
  ])

  // route_id -> route_short_name (el numero de linea que usa la app).
  const lineIdByRouteId = new Map<string, string>()
  for (const row of routes) {
    const routeId = text(row.route_id)
    const shortName = text(row.route_short_name) || routeId
    if (routeId) {
      lineIdByRouteId.set(routeId, shortName)
    }
  }

  // route_id -> sentido de la red oficial (`${lineId}|uno`), cuando se reconoce.
  const directionKeyByRouteId = mapRoutesToDirections(routes, network)

  // trip_id -> { lineId, serviceId, directionKey }
  const tripInfo = new Map<string, { lineId: string, serviceId: string, directionKey: string | null }>()
  for (const row of trips) {
    const tripId = text(row.trip_id)
    const routeId = text(row.route_id)
    const lineId = lineIdByRouteId.get(routeId)
    if (tripId && lineId) {
      tripInfo.set(tripId, {
        lineId,
        serviceId: text(row.service_id),
        directionKey: directionKeyByRouteId.get(routeId) ?? null,
      })
    }
  }

  // Tipo de dia de cada service_id, deducido de las fechas de calendar_dates.
  const dayTypeByServiceId = new Map<string, ServiceDayType>()
  const dates: string[] = []

  for (const row of calendarDates) {
    const serviceId = text(row.service_id)
    const date = text(row.date)
    if (!serviceId || date.length !== 8 || text(row.exception_type) !== '1') {
      continue
    }

    dates.push(date)
    dayTypeByServiceId.set(serviceId, dayTypeFromGtfsDate(date))
  }

  dates.sort()
  const validFrom = dates[0] ?? null
  const validTo = dates[dates.length - 1] ?? null

  // Indice parada -> pasos, ya filtrado a lo minimo necesario.
  const byStop = new Map<string, StopTimeRow[]>()
  for (const row of stopTimes) {
    const tripId = text(row.trip_id)
    const stopId = text(row.stop_id)
    if (!tripId || !stopId || !tripInfo.has(tripId)) {
      continue
    }

    const clock = toClock(text(row.departure_time) || text(row.arrival_time))
    if (!clock) {
      continue
    }

    const list = byStop.get(stopId)
    if (list) {
      list.push({ tripId, stopId, clock })
    } else {
      byStop.set(stopId, [{ tripId, stopId, clock }])
    }
  }

  // Con nombre propio para poder llamarse a si mismo: las salidas de cabecera de
  // un sentido son las horas programadas en su primera parada, asi que
  // `getDirectionDepartures` no es mas que `getScheduledTimes` con la parada ya
  // resuelta. Una sola implementacion, o las dos respuestas podrian discrepar.
  const dataset: ScheduleDataset = {
    validFrom: formatIsoDate(validFrom),
    validTo: formatIsoDate(validTo),
    stale: isStale(validTo),

    getScheduledTimes(
      stopId: string,
      lineId: string,
      dayType: ServiceDayType,
      directionKey: string | null = null,
    ): string[] {
      const rows = byStop.get(stopId)
      if (!rows) {
        return []
      }

      const result = new Set<string>()

      for (const row of rows) {
        const info = tripInfo.get(row.tripId)
        if (!info || info.lineId !== lineId) {
          continue
        }

        // Con un sentido elegido se descartan los trayectos de los demas. Los
        // trayectos que no se han podido emparejar con la red oficial se
        // conservan: es preferible una hora de mas que una tabla vacia.
        if (directionKey && info.directionKey && info.directionKey !== directionKey) {
          continue
        }

        // Si el service_id no aparece en calendar_dates no se puede clasificar el
        // dia; se incluye para no dejar la tabla vacia.
        const rowDayType = dayTypeByServiceId.get(info.serviceId)
        if (rowDayType && rowDayType !== dayType) {
          continue
        }

        result.add(row.clock)
      }

      return Array.from(result).sort(compareClock)
    },

    /**
     * Salidas de un sentido desde su cabecera.
     *
     * La cabecera es, por definicion, la primera parada del recorrido en la red
     * oficial: `direction.stops[0]`. Consultando ahi con el sentido ya fijado se
     * obtienen las salidas de ese sentido y solo de ese, que es lo que se
     * publica como "horario de la linea".
     *
     * Sin red cargada no hay recorrido del que sacar la cabecera, y entonces no
     * se devuelve nada: inventar una parada daria un horario que parece bueno y
     * no lo es.
     */
    getDirectionDepartures(directionKey: string, dayType: ServiceDayType): string[] {
      const direction = network?.directionByKey.get(directionKey)
      const origin = direction?.stops[0]
      if (!direction || !origin) {
        return []
      }

      return dataset.getScheduledTimes(
        origin.stopId,
        direction.key.split('|')[0],
        dayType,
        direction.key,
      )
    },
  }

  return dataset
}

/**
 * Empareja cada `route_id` del GTFS con el sentido equivalente de la red oficial.
 *
 * Primero por rotulo completo ("Cementerio (295) > Puente Ladrillo (309)"), que
 * cubre los 80 sentidos publicados. Los trayectos que el GTFS trae de mas (29
 * variantes parciales) se asignan por destino dentro de la misma linea.
 */
function mapRoutesToDirections(routes: CsvRow[], network: Network | null): Map<string, string> {
  const result = new Map<string, string>()
  if (!network) {
    return result
  }

  const byLabel = new Map<string, string>()
  const byDestination = new Map<string, string>()

  for (const line of network.lines) {
    for (const direction of line.directions) {
      byLabel.set(`${line.lineId}#${normalizeLabel(direction.label)}`, direction.key)
      const destinationKey = `${line.lineId}#${normalizeLabel(direction.destination)}`
      if (!byDestination.has(destinationKey)) {
        byDestination.set(destinationKey, direction.key)
      }
    }
  }

  for (const row of routes) {
    const routeId = text(row.route_id)
    const lineId = text(row.route_short_name) || routeId
    const label = text(row.route_long_name)
    if (!routeId || !label) {
      continue
    }

    const exact = byLabel.get(`${lineId}#${normalizeLabel(label)}`)
    if (exact) {
      result.set(routeId, exact)
      continue
    }

    const destination = label.split('>').slice(1).join('>')
    const guess = byDestination.get(`${lineId}#${normalizeLabel(destination)}`)
    if (guess) {
      result.set(routeId, guess)
    }
  }

  return result
}

/** Sin tildes, sin puntuacion y sin espacios de mas: los rotulos oficiales varian. */
function normalizeLabel(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

async function readCsv(zip: JSZip, fileName: string): Promise<CsvRow[]> {
  const file = zip.file(fileName)
  if (!file) {
    return []
  }

  const parsed = Papa.parse<CsvRow>(await file.async('text'), {
    header: true,
    skipEmptyLines: true,
  })

  return parsed.data
}

function text(value: string | undefined): string {
  return String(value ?? '').trim()
}

/** Normaliza "7:05:00" o "25:10:00" a "HH:MM" en rango 00-23. */
function toClock(value: string): string | null {
  const parts = value.split(':')
  if (parts.length < 2) {
    return null
  }

  const hours = Number.parseInt(parts[0], 10)
  const minutes = Number.parseInt(parts[1], 10)
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
    return null
  }

  return `${String(hours % 24).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

function compareClock(left: string, right: string): number {
  return left.localeCompare(right)
}

function dayTypeFromGtfsDate(date: string): ServiceDayType {
  const parsed = new Date(
    Number.parseInt(date.slice(0, 4), 10),
    Number.parseInt(date.slice(4, 6), 10) - 1,
    Number.parseInt(date.slice(6, 8), 10),
  )

  const day = parsed.getDay()
  if (day === 0) {
    return 'sunday'
  }
  if (day === 6) {
    return 'saturday'
  }
  return 'weekday'
}

function formatIsoDate(value: string | null): string | null {
  if (!value || value.length !== 8) {
    return null
  }
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
}

function isStale(validTo: string | null): boolean {
  if (!validTo || validTo.length !== 8) {
    return true
  }

  const end = new Date(
    Number.parseInt(validTo.slice(0, 4), 10),
    Number.parseInt(validTo.slice(4, 6), 10) - 1,
    Number.parseInt(validTo.slice(6, 8), 10),
  )

  return end.getTime() < Date.now()
}

export function currentDayType(reference = new Date()): ServiceDayType {
  const day = reference.getDay()
  if (day === 0) {
    return 'sunday'
  }
  if (day === 6) {
    return 'saturday'
  }
  return 'weekday'
}
