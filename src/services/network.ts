import type { LineDirection, NetworkPayload, NetworkStop, TransitLine } from '../types'

/**
 * Red oficial de Salamanca de Transportes.
 *
 * Los datos provienen de `public/data/network.json`, generado por
 * `tools/fetch-official-network.mjs` a partir de la pagina oficial de lineas.
 * Contiene las 27 lineas con TODOS sus sentidos (80 trayectos) y la secuencia
 * ordenada de paradas de cada uno, con coordenadas.
 */

export interface Network {
  generatedAt: string
  source: string
  lineCount: number
  directionCount: number
  stopCount: number
  lines: TransitLine[]
  lineById: Map<string, TransitLine>
  directionByKey: Map<string, LineDirection>
  stopById: Map<string, NetworkStop>
  stops: NetworkStop[]

  findStops(query: string, limit?: number): NetworkStop[]
  getLinesForStop(stopId: string): TransitLine[]
  /** Sentidos de una linea que realmente pasan por la parada indicada. */
  getDirectionsThroughStop(stopId: string, lineId: string): LineDirection[]
  /** Ventana de paradas alrededor de una dada, siguiendo el orden real del trayecto. */
  getDirectionWindow(directionKey: string, pivotStopId: string, size?: number): NetworkStop[]
  getLineColor(lineId: string): string
}

export async function loadNetwork(url = '/data/network.json'): Promise<Network> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`No se pudo cargar la red oficial (HTTP ${response.status}).`)
  }

  const payload = (await response.json()) as NetworkPayload
  return buildNetwork(payload)
}

export function buildNetwork(payload: NetworkPayload): Network {
  const lines = payload.lines ?? []
  const lineById = new Map(lines.map((line) => [line.lineId, line]))
  const directionByKey = new Map<string, LineDirection>()

  for (const line of lines) {
    for (const direction of line.directions) {
      directionByKey.set(direction.key, direction)
    }
  }

  const stopById = new Map(Object.entries(payload.stopsById ?? {}))
  const stops = Array.from(stopById.values()).sort((left, right) =>
    left.stopName.localeCompare(right.stopName, 'es', { sensitivity: 'base' }),
  )

  const linesByStopId = payload.linesByStopId ?? {}

  return {
    generatedAt: payload.generatedAt,
    source: payload.source,
    lineCount: lines.length,
    directionCount: directionByKey.size,
    stopCount: stopById.size,
    lines,
    lineById,
    directionByKey,
    stopById,
    stops,

    findStops(query: string, limit = 60): NetworkStop[] {
      const needle = normalize(query)
      if (!needle) {
        return stops.slice(0, limit)
      }

      // Un codigo de parada exacto siempre gana.
      const exact = stopById.get(query.trim())
      const scored: Array<{ stop: NetworkStop, score: number }> = []

      for (const stop of stops) {
        if (exact && stop.stopId === exact.stopId) {
          continue
        }

        const name = normalize(stop.stopName)
        const position = name.indexOf(needle)

        if (position === 0) {
          scored.push({ stop, score: 0 })
        } else if (position > 0) {
          scored.push({ stop, score: 1 })
        } else if (stop.stopId.startsWith(needle)) {
          scored.push({ stop, score: 2 })
        }
      }

      scored.sort((left, right) => left.score - right.score)
      const results = scored.map((item) => item.stop)
      return (exact ? [exact, ...results] : results).slice(0, limit)
    },

    getLinesForStop(stopId: string): TransitLine[] {
      return (linesByStopId[stopId] ?? [])
        .map((lineId) => lineById.get(lineId))
        .filter((line): line is TransitLine => Boolean(line))
    },

    getDirectionsThroughStop(stopId: string, lineId: string): LineDirection[] {
      const line = lineById.get(lineId)
      if (!line) {
        return []
      }

      return line.directions.filter((direction) => direction.stops.some((stop) => stop.stopId === stopId))
    },

    getDirectionWindow(directionKey: string, pivotStopId: string, size = 9): NetworkStop[] {
      const direction = directionByKey.get(directionKey)
      if (!direction) {
        return []
      }

      const sequence = direction.stops
      const pivotIndex = sequence.findIndex((stop) => stop.stopId === pivotStopId)
      if (pivotIndex < 0) {
        return sequence.slice(0, size)
      }

      // Se muestran las paradas ANTERIORES a la registrada (por donde viene el bus)
      // mas la propia parada, que es lo util para saber por donde va.
      const before = Math.min(pivotIndex, size - 1)
      return sequence.slice(pivotIndex - before, pivotIndex + 1)
    },

    getLineColor(lineId: string): string {
      return lineById.get(lineId)?.color ?? '#173764'
    },
  }
}

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
}
