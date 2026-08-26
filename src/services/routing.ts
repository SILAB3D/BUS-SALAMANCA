/**
 * Paradas cercanas y calculo de rutas en autobus.
 *
 * El modulo es PURO: no toca DOM, ni red, ni almacenamiento, ni el motor de
 * refresco de la app. Recibe la red oficial ya cargada y devuelve numeros. Asi
 * se puede probar entero desde Node (`npm test`) y, sobre todo, asi la pestana
 * experimental no puede estropear nada de lo que ya funciona: si algo de aqui
 * falla, falla dentro de su pantalla.
 *
 * QUE NO HACE, a proposito:
 *
 *  - No consulta la fuente oficial de llegadas. Esa fuente limita por IP y ya
 *    tiene su cola; una pantalla de rutas que pidiera tiempos de veinte paradas
 *    dejaria sin turno al aviso de proximo bus, que es lo que de verdad tiene
 *    que llegar a tiempo.
 *  - No construye ningun indice al arrancar. Todo se calcula cuando alguien
 *    pide una ruta, a partir de datos que ya estan en memoria.
 *
 * El tiempo de viaje se ESTIMA a partir de la distancia real entre paradas del
 * recorrido. El GTFS incluido daria minutos exactos, pero son 543.000 filas y
 * caduca; indexarlas por trayecto encarece el arranque de toda la app para una
 * funcion experimental. La espera si sale del horario cuando lo hay (se inyecta
 * con `waitMinutes`), que es donde mas se nota el error.
 */

import type { LineDirection, NetworkStop } from '../types'

/* ------------------------------------------------------------------ *
 * Geometria                                                            *
 * ------------------------------------------------------------------ */

export interface GeoPoint {
  lat: number
  lon: number
}

const EARTH_RADIUS_M = 6_371_000

/** Distancia en metros entre dos puntos (formula del semiverseno). */
export function distanceMeters(from: GeoPoint, to: GeoPoint): number {
  const lat1 = toRadians(from.lat)
  const lat2 = toRadians(to.lat)
  const deltaLat = toRadians(to.lat - from.lat)
  const deltaLon = toRadians(to.lon - from.lon)

  const a =
    Math.sin(deltaLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2

  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)))
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180
}

export function isValidPoint(point: GeoPoint | null | undefined): point is GeoPoint {
  return (
    !!point &&
    Number.isFinite(point.lat) &&
    Number.isFinite(point.lon) &&
    Math.abs(point.lat) <= 90 &&
    Math.abs(point.lon) <= 180
  )
}

/* ------------------------------------------------------------------ *
 * Parametros del calculo                                               *
 * ------------------------------------------------------------------ */

/**
 * Velocidad andando, en km/h.
 *
 * 4,6 es el paso de alguien que va a coger un autobus por una acera urbana, no
 * el paseo de 5 km/h de los libros. Quedarse corto aqui hace que el calculo
 * prefiera rutas absurdas con tal de andar menos.
 */
export const WALK_SPEED_KMH = 4.6

/**
 * Velocidad comercial del autobus urbano, en km/h.
 *
 * Incluye semaforos y paradas: la velocidad punta no sirve para estimar un
 * trayecto de ciudad. Se ajusta con `DWELL_MINUTES` parada a parada.
 */
export const BUS_SPEED_KMH = 17

/** Minutos que se pierden en cada parada intermedia (abrir, subir, cerrar). */
export const DWELL_MINUTES = 0.35

/** Distancia maxima a pie hasta la primera parada, o desde la ultima. */
export const MAX_ACCESS_METERS = 900

/** Distancia maxima a pie en un transbordo entre dos paradas distintas. */
export const MAX_TRANSFER_METERS = 350

/**
 * Penalizacion de cada transbordo, en minutos, ademas de la espera real.
 *
 * Cambiar de autobus cansa y se falla: dos rutas de la misma duracion no valen
 * lo mismo si una obliga a un transbordo. Sin esta penalizacion el calculo
 * proponia dar dos saltos para ganar un minuto.
 */
export const TRANSFER_PENALTY_MINUTES = 4

/** Transbordos como mucho. Con dos, en una ciudad como Salamanca, sobra. */
export const MAX_TRANSFERS = 2

/** Espera que se supone cuando no hay horario que consultar. */
export const DEFAULT_WAIT_MINUTES = 7

/** Por debajo de esto, ir andando gana casi siempre: se ofrece como opcion. */
export const WALKABLE_METERS = 1_300

export function walkMinutes(meters: number): number {
  return meters / ((WALK_SPEED_KMH * 1000) / 60)
}

/* ------------------------------------------------------------------ *
 * Paradas cercanas                                                     *
 * ------------------------------------------------------------------ */

export interface NearbyStop {
  stop: NetworkStop
  meters: number
  minutes: number
}

/**
 * Paradas mas cercanas a un punto, de menor a mayor distancia.
 *
 * `maxMeters` acota el resultado: una parada a dos kilometros no es "cercana"
 * por mucho que sea la septima mas proxima, y ensenarla induce a error.
 */
export function nearestStops(
  origin: GeoPoint,
  stops: NetworkStop[],
  limit = 6,
  maxMeters = MAX_ACCESS_METERS,
): NearbyStop[] {
  if (!isValidPoint(origin)) {
    return []
  }

  const found: NearbyStop[] = []

  for (const stop of stops) {
    if (!isValidPoint(stop)) {
      continue
    }

    const meters = distanceMeters(origin, stop)
    if (meters <= maxMeters) {
      found.push({ stop, meters, minutes: walkMinutes(meters) })
    }
  }

  found.sort((left, right) => left.meters - right.meters)
  return found.slice(0, limit)
}

/* ------------------------------------------------------------------ *
 * Rutas                                                                *
 * ------------------------------------------------------------------ */

export interface WalkLeg {
  kind: 'walk'
  from: GeoPoint
  to: GeoPoint
  fromName: string
  toName: string
  meters: number
  minutes: number
  /**
   * Recorrido real por las calles, cuando el callejero esta cargado.
   *
   * Opcional a proposito: el calculo tiene que seguir dando una ruta completa
   * sin el, y `streets.json` puede no estar generado. Cuando esta, ademas de
   * poder dibujarse, los metros del tramo son los de este recorrido y no los de
   * la linea recta.
   */
  path?: GeoPoint[]
  /** El tramo se ha medido por el callejero y no en linea recta. */
  onStreets?: boolean
}

export interface BusLeg {
  kind: 'bus'
  lineId: string
  directionKey: string
  /** Rotulo del sentido, para decir hacia donde va el autobus que hay que coger. */
  headsign: string
  from: NetworkStop
  to: NetworkStop
  /** Paradas del trayecto, de la de subida a la de bajada, ambas incluidas. */
  stops: NetworkStop[]
  /** Minutos dentro del autobus. */
  minutes: number
  /** Minutos de espera estimados en la parada. */
  waitMinutes: number
}

export type RouteLeg = WalkLeg | BusLeg

export interface Itinerary {
  /** Suma de andar, esperar y viajar. */
  totalMinutes: number
  walkMinutes: number
  rideMinutes: number
  waitMinutes: number
  transfers: number
  legs: RouteLeg[]
}

export interface PlanRequest {
  origin: GeoPoint
  destination: GeoPoint
  originName: string
  destinationName: string
  /** Todos los sentidos de la red, con su secuencia real de paradas. */
  directions: LineDirection[]
  /**
   * Espera estimada en una parada para un sentido concreto.
   *
   * Se inyecta para que el modulo siga siendo puro: quien llama decide si la
   * saca del horario programado o usa un valor fijo.
   */
  waitMinutes?: (stopId: string, lineId: string, directionKey: string) => number
  maxTransfers?: number
}

export type PlanOutcome =
  | { status: 'ok', best: Itinerary, alternatives: Itinerary[] }
  /** Se llega antes andando; no hay nada que proponer en autobus. */
  | { status: 'walk', walking: Itinerary }
  | { status: 'unreachable', reason: string }

interface Label {
  /** Minutos acumulados desde el origen. */
  cost: number
  transfers: number
  /** Como se llego hasta aqui; `null` en las paradas de salida. */
  via: RouteLeg | null
  previousStopId: string | null
}

/**
 * Calcula la ruta mas rapida en autobus entre dos puntos.
 *
 * Es un Dijkstra sobre las paradas donde el coste es el TIEMPO en minutos. Cada
 * arista de autobus va de la parada de subida a la de bajada de un mismo
 * sentido, asi que el camino resultante ya sale troceado en tramos: subir,
 * bajar, andar, subir otra vez.
 */
export function planRoute(request: PlanRequest): PlanOutcome {
  const { origin, destination, directions } = request

  if (!isValidPoint(origin) || !isValidPoint(destination)) {
    return { status: 'unreachable', reason: 'Falta el origen o el destino.' }
  }

  const directMeters = distanceMeters(origin, destination)
  const walking = walkOnly(request, directMeters)

  const maxTransfers = request.maxTransfers ?? MAX_TRANSFERS
  const wait = request.waitMinutes ?? (() => DEFAULT_WAIT_MINUTES)

  const stopsById = new Map<string, NetworkStop>()
  /** Sentidos que pasan por cada parada, con la posicion que ocupa en ellos. */
  const throughStop = new Map<string, Array<{ direction: LineDirection, index: number }>>()

  for (const direction of directions) {
    direction.stops.forEach((stop, index) => {
      if (!isValidPoint(stop)) {
        return
      }
      stopsById.set(stop.stopId, stop)
      const list = throughStop.get(stop.stopId)
      if (list) {
        list.push({ direction, index })
      } else {
        throughStop.set(stop.stopId, [{ direction, index }])
      }
    })
  }

  const allStops = Array.from(stopsById.values())
  const access = nearestStops(origin, allStops, 8, MAX_ACCESS_METERS)
  const egress = nearestStops(destination, allStops, 8, MAX_ACCESS_METERS)

  if (access.length === 0 || egress.length === 0) {
    return directMeters <= WALKABLE_METERS && walking
      ? { status: 'walk', walking }
      : {
          status: 'unreachable',
          reason: 'No hay ninguna parada de la red a menos de 900 m del origen o del destino.',
        }
  }

  const egressByStopId = new Map(egress.map((item) => [item.stop.stopId, item]))
  const labels = new Map<string, Label>()
  const settled = new Set<string>()

  for (const entry of access) {
    labels.set(entry.stop.stopId, {
      cost: entry.minutes,
      transfers: 0,
      previousStopId: null,
      via: {
        kind: 'walk',
        from: origin,
        to: { lat: entry.stop.lat, lon: entry.stop.lon },
        fromName: request.originName,
        toName: entry.stop.stopName,
        meters: entry.meters,
        minutes: entry.minutes,
      },
    })
  }

  /** Tiempos acumulados de cada sentido; se calculan una vez por consulta. */
  const cumulative = new Map<string, number[]>()

  const rideMinutes = (direction: LineDirection, from: number, to: number): number => {
    let table = cumulative.get(direction.key)
    if (!table) {
      table = buildCumulativeMinutes(direction)
      cumulative.set(direction.key, table)
    }
    return Math.max(0, table[to] - table[from])
  }

  while (true) {
    const current = cheapestUnsettled(labels, settled)
    if (!current) {
      break
    }

    settled.add(current)
    const label = labels.get(current)
    if (!label) {
      break
    }

    // Ya se ha llegado a una parada valida de bajada: cualquier etiqueta que
    // salga ahora es mas cara, asi que no hace falta seguir.
    if (egressByStopId.has(current) && label.transfers >= 0) {
      // No se corta el bucle: otra parada de bajada puede dar un total menor
      // sumando el paseo final. Se sigue hasta agotar lo barato.
    }

    if (label.transfers > maxTransfers) {
      continue
    }

    // 1. Subirse a un autobus.
    for (const { direction, index } of throughStop.get(current) ?? []) {
      // Volver a subir a la misma linea de la que se acaba de bajar no lleva a
      // ninguna parte: la ruta ya venia por ahi.
      if (label.via?.kind === 'bus' && label.via.directionKey === direction.key) {
        continue
      }

      const boardingWait = wait(current, direction.stops[index] ? lineIdOf(direction) : '', direction.key)
      const transfers = label.via?.kind === 'bus' ? label.transfers + 1 : label.transfers
      if (transfers > maxTransfers) {
        continue
      }

      const penalty = label.via?.kind === 'bus' ? TRANSFER_PENALTY_MINUTES : 0

      for (let target = index + 1; target < direction.stops.length; target += 1) {
        const stop = direction.stops[target]
        if (!isValidPoint(stop)) {
          continue
        }

        const cost = label.cost + boardingWait + penalty + rideMinutes(direction, index, target)
        const known = labels.get(stop.stopId)

        if (!known || cost < known.cost) {
          labels.set(stop.stopId, {
            cost,
            transfers,
            previousStopId: current,
            via: {
              kind: 'bus',
              lineId: lineIdOf(direction),
              directionKey: direction.key,
              headsign: direction.destination,
              from: direction.stops[index],
              to: stop,
              stops: direction.stops.slice(index, target + 1),
              minutes: rideMinutes(direction, index, target),
              waitMinutes: boardingWait,
            },
          })
        }
      }
    }

    // 2. Cruzar andando a una parada de al lado (el transbordo de verdad).
    const here = stopsById.get(current)
    if (here && label.via?.kind === 'bus') {
      for (const neighbour of nearestStops(here, allStops, 4, MAX_TRANSFER_METERS)) {
        if (neighbour.stop.stopId === current) {
          continue
        }

        const cost = label.cost + neighbour.minutes
        const known = labels.get(neighbour.stop.stopId)

        if (!known || cost < known.cost) {
          labels.set(neighbour.stop.stopId, {
            cost,
            transfers: label.transfers,
            previousStopId: current,
            via: {
              kind: 'walk',
              from: { lat: here.lat, lon: here.lon },
              to: { lat: neighbour.stop.lat, lon: neighbour.stop.lon },
              fromName: here.stopName,
              toName: neighbour.stop.stopName,
              meters: neighbour.meters,
              minutes: neighbour.minutes,
            },
          })
        }
      }
    }
  }

  // Se prueban TODAS las paradas de bajada: la mas cercana al destino no es
  // siempre la que da el total menor.
  const candidates: Itinerary[] = []

  for (const entry of egress) {
    const label = labels.get(entry.stop.stopId)
    if (!label || !label.via) {
      continue
    }

    const legs = rebuild(labels, entry.stop.stopId)
    if (!legs.some((leg) => leg.kind === 'bus')) {
      continue
    }

    legs.push({
      kind: 'walk',
      from: { lat: entry.stop.lat, lon: entry.stop.lon },
      to: destination,
      fromName: entry.stop.stopName,
      toName: request.destinationName,
      meters: entry.meters,
      minutes: entry.minutes,
    })

    candidates.push(summarise(tidyLegs(legs)))
  }

  if (candidates.length === 0) {
    return walking
      ? { status: 'walk', walking }
      : { status: 'unreachable', reason: 'No se encontró ninguna combinación de líneas entre esos dos puntos.' }
  }

  candidates.sort(compareItineraries)

  // Andar gana: no tiene sentido proponer un autobus para tres manzanas.
  if (walking && walking.totalMinutes <= candidates[0].totalMinutes) {
    return { status: 'walk', walking }
  }

  return {
    status: 'ok',
    best: candidates[0],
    alternatives: distinctAlternatives(candidates.slice(1), 2, signatureOf(candidates[0])),
  }
}

/**
 * Limpia el itinerario antes de ensenarlo.
 *
 * Dos cosas que salen del calculo y no deberian llegar a la pantalla:
 *
 *  - Paseos encadenados. Bajarse en una parada, cruzar a la de al lado y seguir
 *    hasta el destino son tres pasos en el grafo, pero UN paseo para quien anda.
 *  - Paseos de cero metros, que aparecen cuando el destino ES la parada en la
 *    que uno se baja. "Andar 0 m hasta X" no es una instruccion.
 */
function tidyLegs(legs: RouteLeg[]): RouteLeg[] {
  const merged: RouteLeg[] = []

  for (const leg of legs) {
    const last = merged[merged.length - 1]

    if (leg.kind === 'walk' && last?.kind === 'walk') {
      merged[merged.length - 1] = {
        ...last,
        to: leg.to,
        toName: leg.toName,
        meters: last.meters + leg.meters,
        minutes: last.minutes + leg.minutes,
      }
      continue
    }

    merged.push(leg)
  }

  if (merged.length <= 1) {
    return merged
  }

  // Solo se tiran los paseos insignificantes del PRINCIPIO y del FINAL: son los
  // que sobran cuando el origen o el destino ya son la propia parada.
  //
  // Los de en medio se quedan por cortos que sean. Son un cambio de parada, y
  // callarlo por veinticinco metros dejaba un itinerario que decia "baja en Gran
  // Via" y acto seguido "sube en San Julian", sin explicar que hay que cruzar.
  return merged.filter((leg, index) => {
    if (leg.kind !== 'walk' || leg.meters >= NEGLIGIBLE_WALK_METERS) {
      return true
    }
    return index !== 0 && index !== merged.length - 1
  })
}

/** Por debajo de esto no es un paseo, es estar ya alli. */
const NEGLIGIBLE_WALK_METERS = 30

/** Las lineas que se usan, en orden: es lo que distingue una ruta de otra. */
function signatureOf(itinerary: Itinerary): string {
  return itinerary.legs
    .filter((leg): leg is BusLeg => leg.kind === 'bus')
    .map((leg) => leg.lineId)
    .join('-')
}

/** A igualdad de minutos gana la que obliga a menos transbordos. */
function compareItineraries(left: Itinerary, right: Itinerary): number {
  const byTime = left.totalMinutes - right.totalMinutes
  if (Math.abs(byTime) > 0.5) {
    return byTime
  }
  return left.transfers - right.transfers
}

/**
 * Alternativas que aportan algo.
 *
 * Dos itinerarios con las mismas lineas en el mismo orden son la misma ruta con
 * otra parada de bajada; ensenar las dos solo confunde. `already` trae la firma
 * de la ruta recomendada: sin ella, la primera "alternativa" era otra vez la
 * misma, con veinte metros de diferencia en el paseo final.
 */
function distinctAlternatives(candidates: Itinerary[], limit = 2, already = ''): Itinerary[] {
  const seen = new Set<string>([already])
  const result: Itinerary[] = []

  for (const itinerary of candidates) {
    const signature = signatureOf(itinerary)

    if (seen.has(signature)) {
      continue
    }

    seen.add(signature)
    result.push(itinerary)

    if (result.length >= limit) {
      break
    }
  }

  return result
}

function walkOnly(request: PlanRequest, meters: number): Itinerary | null {
  if (meters > WALKABLE_METERS) {
    return null
  }

  const minutes = walkMinutes(meters)
  return {
    totalMinutes: minutes,
    walkMinutes: minutes,
    rideMinutes: 0,
    waitMinutes: 0,
    transfers: 0,
    legs: [
      {
        kind: 'walk',
        from: request.origin,
        to: request.destination,
        fromName: request.originName,
        toName: request.destinationName,
        meters,
        minutes,
      },
    ],
  }
}

/* ------------------------------------------------------------------ *
 * Afinado con el callejero                                             *
 * ------------------------------------------------------------------ */

/**
 * Vuelve a medir los tramos a pie por donde de verdad se anda.
 *
 * SE HACE DESPUES y no dentro del calculo, por una razon de coste: el Dijkstra
 * evalua paseos entre cientos de pares de paradas, y resolver cada uno sobre un
 * callejero de cien mil nodos dejaria la pantalla congelada varios segundos. Un
 * itinerario ya elegido tiene dos o tres tramos a pie; esos si se pueden medir
 * exactos, y son los que se leen y se andan.
 *
 * La contrapartida esta dicha: la ELECCION de por donde ir se toma con
 * distancias en linea recta, que se quedan cortas siempre. Por eso el afinado
 * devuelve minutos nuevos y quien llama vuelve a ordenar con ellos: una ruta
 * que ganaba por medio minuto puede dejar de ganar cuando se descubre que su
 * paseo cruza una manzana entera.
 *
 * `resolve` se inyecta para que este modulo siga siendo puro y comprobable sin
 * red ni ficheros.
 */
export function refineWalking(
  itinerary: Itinerary,
  resolve: (from: GeoPoint, to: GeoPoint) => { meters: number, points: GeoPoint[] } | null,
): Itinerary {
  let changed = false

  const legs = itinerary.legs.map((leg) => {
    if (leg.kind !== 'walk') {
      return leg
    }

    const path = resolve(leg.from, leg.to)
    if (!path) {
      return leg
    }

    changed = true
    return {
      ...leg,
      meters: Math.round(path.meters),
      minutes: walkMinutes(path.meters),
      path: path.points,
      onStreets: true,
    }
  })

  return changed ? summarise(legs) : itinerary
}

function cheapestUnsettled(labels: Map<string, Label>, settled: Set<string>): string | null {
  let best: string | null = null
  let bestCost = Number.POSITIVE_INFINITY

  for (const [stopId, label] of labels) {
    if (settled.has(stopId) || label.cost >= bestCost) {
      continue
    }
    best = stopId
    bestCost = label.cost
  }

  return best
}

function rebuild(labels: Map<string, Label>, stopId: string): RouteLeg[] {
  const legs: RouteLeg[] = []
  let cursor: string | null = stopId
  const guard = new Set<string>()

  while (cursor) {
    if (guard.has(cursor)) {
      break
    }
    guard.add(cursor)

    const label: Label | undefined = labels.get(cursor)
    if (!label?.via) {
      break
    }

    legs.unshift(label.via)
    cursor = label.previousStopId
  }

  return legs
}

function summarise(legs: RouteLeg[]): Itinerary {
  let walk = 0
  let ride = 0
  let wait = 0
  let transfers = -1

  for (const leg of legs) {
    if (leg.kind === 'walk') {
      walk += leg.minutes
    } else {
      ride += leg.minutes
      wait += leg.waitMinutes
      transfers += 1
    }
  }

  return {
    totalMinutes: walk + ride + wait,
    walkMinutes: walk,
    rideMinutes: ride,
    waitMinutes: wait,
    transfers: Math.max(0, transfers),
    legs,
  }
}

/**
 * Minutos acumulados desde la cabecera del sentido hasta cada parada.
 *
 * Se estima con la distancia real entre paradas consecutivas, no en linea recta
 * de punta a punta: un recorrido que rodea el rio tarda lo que mide el
 * recorrido, no lo que mide la cuerda.
 */
function buildCumulativeMinutes(direction: LineDirection): number[] {
  const table: number[] = [0]
  const metersPerMinute = (BUS_SPEED_KMH * 1000) / 60

  for (let index = 1; index < direction.stops.length; index += 1) {
    const previous = direction.stops[index - 1]
    const current = direction.stops[index]

    const meters =
      isValidPoint(previous) && isValidPoint(current) ? distanceMeters(previous, current) : 0

    table.push(table[index - 1] + meters / metersPerMinute + DWELL_MINUTES)
  }

  return table
}

function lineIdOf(direction: LineDirection): string {
  return direction.key.split('|')[0] ?? ''
}
