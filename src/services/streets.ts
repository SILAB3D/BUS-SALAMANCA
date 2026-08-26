/**
 * Callejero peatonal: por donde se anda de verdad entre dos puntos.
 *
 * QUE RESUELVE
 *
 * El calculo de rutas medía los paseos en línea recta. En una ciudad eso no es
 * una aproximación: entre dos puntos separados 200 m en el mapa puede haber un
 * río, una vía de tren o una manzana entera, y el error iba SIEMPRE en la misma
 * dirección —a menos— porque la recta es el camino más corto que existe. Con
 * las calles cargadas, un paseo se mide por donde se anda, y además se puede
 * dibujar: es lo que convierte «300 m andando» en una indicación seguible.
 *
 * COMO SE CARGA
 *
 * `public/data/streets.json` lo genera `tools/fetch-street-graph.mjs` desde
 * OpenStreetMap. Son 100.000 nodos, así que NO se carga al arrancar: se pide la
 * primera vez que alguien calcula una ruta en la pestaña experimental, una sola
 * vez por sesión, y las peticiones simultáneas comparten la misma promesa. Que
 * una función en pruebas encareciera el arranque de TODA la app sería
 * exactamente lo contrario de lo que se busca.
 *
 * Si el fichero no está —no se ha generado nunca, o la descarga falló— este
 * módulo lo dice y quien llama sigue con la línea recta de siempre. La pestaña
 * nunca se queda sin ruta por no tener callejero.
 *
 * QUE NO HACE
 *
 * No decide la ruta en autobús. Eso es de `routing.ts`, que sigue siendo puro y
 * sigue funcionando sin este módulo; aquí solo se afinan los tramos a pie.
 */

import { distanceMeters, isValidPoint, type GeoPoint } from './routing'

/* ------------------------------------------------------------------ *
 * Formato en disco                                                     *
 * ------------------------------------------------------------------ */

interface StreetPayload {
  source: string
  generatedAt: string
  nodeCount: number
  edgeCount: number
  /** Diferencias sucesivas en millonesimas de grado. */
  lat: number[]
  lon: number[]
  /** Pares planos de indices: [a0, b0, a1, b1, …]. */
  edges: number[]
}

/**
 * El grafo ya en memoria.
 *
 * Listas de adyacencia en arrays planos (CSR) y no un `Map` de arrays: con cien
 * mil nodos, un objeto por nodo son cien mil objetos que el recolector tiene que
 * recorrer, y el camino mas corto se calcula varias veces por ruta.
 */
export interface StreetGraph {
  nodeCount: number
  lat: Float64Array
  lon: Float64Array
  /** `neighbours[offsets[i] … offsets[i + 1])` son los vecinos del nodo `i`. */
  offsets: Int32Array
  neighbours: Int32Array
  /** Nodos por celda de la rejilla, para poder buscar el mas cercano a un punto. */
  grid: Map<number, number[]>
}

/* ------------------------------------------------------------------ *
 * Parametros                                                           *
 * ------------------------------------------------------------------ */

/** Lado de la celda de la rejilla, en grados (~110 m de norte a sur). */
const CELL_DEG = 0.001

/**
 * Distancia maxima entre un punto y la calle a la que se engancha.
 *
 * Mas lejos de esto, engancharlo seria inventarse un tramo: se prefiere
 * devolver `null` y que quien llama use la linea recta, que al menos no miente
 * sobre por donde se pasa.
 */
const MAX_SNAP_METERS = 260

/**
 * Tope de nodos que se sacan de la cola antes de rendirse.
 *
 * Es una red de cien mil nodos y esto se ejecuta en el hilo de la interfaz. Un
 * paseo urbano se resuelve en unos cientos; llegar a este numero significa que
 * el destino esta al otro lado de algo intransitable, y para eso vale mas
 * responder rapido que responder.
 */
const MAX_EXPANSIONS = 60_000

/* ------------------------------------------------------------------ *
 * Carga                                                                *
 * ------------------------------------------------------------------ */

let pending: Promise<StreetGraph | null> | null = null
let cached: StreetGraph | null = null

/** El callejero ya esta en memoria (sin pedirlo si no lo esta). */
export function peekStreetGraph(): StreetGraph | null {
  return cached
}

/**
 * Carga el callejero una sola vez.
 *
 * Devuelve `null` —y no lanza— cuando no se puede: quien llama tiene que poder
 * seguir con la estimacion en linea recta sin envolver la llamada en un
 * `try`. Un fallo aqui empeora la precision; no puede romper la pantalla.
 */
export function loadStreetGraph(url = '/data/streets.json'): Promise<StreetGraph | null> {
  if (cached) {
    return Promise.resolve(cached)
  }

  if (!pending) {
    pending = fetch(url)
      .then((response) => {
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`)
        }
        return response.json() as Promise<StreetPayload>
      })
      .then((payload) => {
        cached = buildStreetGraph(payload)
        return cached
      })
      .catch(() => {
        // Se olvida el intento fallido: puede haber sido un fichero que aun no
        // estaba servido, y volver a intentarlo mas tarde no cuesta nada.
        pending = null
        return null
      })
  }

  return pending
}

export function buildStreetGraph(payload: StreetPayload): StreetGraph {
  const count = payload.lat.length
  const lat = new Float64Array(count)
  const lon = new Float64Array(count)

  // Las coordenadas van guardadas como diferencia con la anterior: se deshace
  // la cadena de una pasada.
  let runningLat = 0
  let runningLon = 0

  for (let index = 0; index < count; index += 1) {
    runningLat += payload.lat[index]
    runningLon += payload.lon[index]
    lat[index] = runningLat / 1e6
    lon[index] = runningLon / 1e6
  }

  // El grafo es no dirigido, asi que cada arista se cuenta en sus dos extremos.
  const degree = new Int32Array(count)
  const edges = payload.edges

  for (let index = 0; index < edges.length; index += 2) {
    degree[edges[index]] += 1
    degree[edges[index + 1]] += 1
  }

  const offsets = new Int32Array(count + 1)
  for (let index = 0; index < count; index += 1) {
    offsets[index + 1] = offsets[index] + degree[index]
  }

  const neighbours = new Int32Array(offsets[count])
  const cursor = offsets.slice(0, count)

  for (let index = 0; index < edges.length; index += 2) {
    const from = edges[index]
    const to = edges[index + 1]
    neighbours[cursor[from]] = to
    cursor[from] += 1
    neighbours[cursor[to]] = from
    cursor[to] += 1
  }

  const grid = new Map<number, number[]>()
  for (let index = 0; index < count; index += 1) {
    const key = cellKey(lat[index], lon[index])
    const bucket = grid.get(key)
    if (bucket) {
      bucket.push(index)
    } else {
      grid.set(key, [index])
    }
  }

  return { nodeCount: count, lat, lon, offsets, neighbours, grid }
}

function cellKey(lat: number, lon: number): number {
  // Dos enteros en uno. El desplazamiento de 20 bits deja sitio de sobra para
  // el rango de una ciudad sin tener que construir cadenas de texto, que es lo
  // que hacia lenta la rejilla cuando se indexaban cien mil nodos.
  const row = Math.floor(lat / CELL_DEG) + 90_000
  const column = Math.floor(lon / CELL_DEG) + 180_000
  return row * 1_048_576 + column
}

/* ------------------------------------------------------------------ *
 * Enganche a la calle mas cercana                                      *
 * ------------------------------------------------------------------ */

/**
 * Nodo del callejero mas cercano a un punto.
 *
 * Se buscan anillos de celdas cada vez mas amplios y se para en cuanto el mejor
 * candidato esta mas cerca que el borde del anillo siguiente: sin esa condicion
 * se devolvia el primer nodo encontrado, que podia ser el de una calle paralela.
 */
export function nearestNode(graph: StreetGraph, point: GeoPoint): number | null {
  if (!isValidPoint(point)) {
    return null
  }

  const row = Math.floor(point.lat / CELL_DEG) + 90_000
  const column = Math.floor(point.lon / CELL_DEG) + 180_000

  let best = -1
  let bestMeters = Number.POSITIVE_INFINITY

  // Cada celda mide ~110 m de lado; tres anillos cubren de sobra el tope de
  // enganche sin recorrer media ciudad.
  for (let ring = 0; ring <= 3; ring += 1) {
    for (let deltaRow = -ring; deltaRow <= ring; deltaRow += 1) {
      for (let deltaColumn = -ring; deltaColumn <= ring; deltaColumn += 1) {
        // Solo el borde del anillo: el interior ya se miro en la vuelta anterior.
        if (ring > 0 && Math.abs(deltaRow) !== ring && Math.abs(deltaColumn) !== ring) {
          continue
        }

        const bucket = graph.grid.get((row + deltaRow) * 1_048_576 + (column + deltaColumn))
        if (!bucket) {
          continue
        }

        for (const index of bucket) {
          const meters = distanceMeters(point, { lat: graph.lat[index], lon: graph.lon[index] })
          if (meters < bestMeters) {
            bestMeters = meters
            best = index
          }
        }
      }
    }

    // El anillo siguiente no puede tener nada mas cerca que esto.
    if (best >= 0 && bestMeters <= ring * CELL_DEG * 111_000) {
      break
    }
  }

  return best >= 0 && bestMeters <= MAX_SNAP_METERS ? best : null
}

/* ------------------------------------------------------------------ *
 * Camino mas corto a pie                                               *
 * ------------------------------------------------------------------ */

export interface WalkPath {
  /** Metros por la calle, incluidos los dos enganches a la acera. */
  meters: number
  /** Puntos del recorrido, del origen al destino, listos para dibujar. */
  points: GeoPoint[]
}

/**
 * Camino andando entre dos puntos por el callejero.
 *
 * Es un A* con la distancia en linea recta como estimacion. Esa estimacion
 * nunca puede pasarse (por la calle siempre se anda igual o mas que en recta),
 * que es la condicion para que el primer camino encontrado sea el mas corto de
 * verdad y no simplemente uno cualquiera.
 *
 * Devuelve `null` si alguno de los extremos queda demasiado lejos de cualquier
 * calle o si no hay forma de llegar: quien llama sigue entonces con la recta.
 */
export function walkPath(graph: StreetGraph, from: GeoPoint, to: GeoPoint): WalkPath | null {
  const start = nearestNode(graph, from)
  const goal = nearestNode(graph, to)

  if (start === null || goal === null) {
    return null
  }

  if (start === goal) {
    return { meters: distanceMeters(from, to), points: [from, to] }
  }

  const target: GeoPoint = { lat: graph.lat[goal], lon: graph.lon[goal] }

  const cost = new Float64Array(graph.nodeCount).fill(Number.POSITIVE_INFINITY)
  const cameFrom = new Int32Array(graph.nodeCount).fill(-1)
  const closed = new Uint8Array(graph.nodeCount)

  cost[start] = 0

  const open = new MinHeap()
  open.push(start, distanceMeters({ lat: graph.lat[start], lon: graph.lon[start] }, target))

  let expansions = 0
  let found = false

  while (open.size > 0) {
    const current = open.pop()

    if (closed[current]) {
      continue
    }

    closed[current] = 1
    expansions += 1

    if (current === goal) {
      found = true
      break
    }

    if (expansions > MAX_EXPANSIONS) {
      break
    }

    const here: GeoPoint = { lat: graph.lat[current], lon: graph.lon[current] }

    for (let slot = graph.offsets[current]; slot < graph.offsets[current + 1]; slot += 1) {
      const next = graph.neighbours[slot]
      if (closed[next]) {
        continue
      }

      const step = distanceMeters(here, { lat: graph.lat[next], lon: graph.lon[next] })
      const candidate = cost[current] + step

      if (candidate < cost[next]) {
        cost[next] = candidate
        cameFrom[next] = current
        open.push(
          next,
          candidate + distanceMeters({ lat: graph.lat[next], lon: graph.lon[next] }, target),
        )
      }
    }
  }

  if (!found) {
    return null
  }

  const path: GeoPoint[] = []
  for (let node = goal; node !== -1; node = cameFrom[node]) {
    path.push({ lat: graph.lat[node], lon: graph.lon[node] })
  }
  path.reverse()

  // Los dos enganches: del punto real a la acera, y de la acera al punto real.
  const entry = distanceMeters(from, path[0])
  const exit = distanceMeters(path[path.length - 1], to)

  return {
    meters: entry + cost[goal] + exit,
    points: [from, ...path, to],
  }
}

/* ------------------------------------------------------------------ *
 * Cola de prioridad                                                    *
 * ------------------------------------------------------------------ */

/**
 * Monticulo binario sobre dos arrays paralelos.
 *
 * Sin el, la cola era un array que se reordenaba en cada insercion: con cien
 * mil nodos eso convertia un calculo de milisegundos en varios segundos con la
 * interfaz congelada. No se implementa el borrado de entradas obsoletas —se
 * ignoran al salir mirando `closed`—, que es mas barato que mantener el indice.
 */
class MinHeap {
  private items: number[] = []
  private keys: number[] = []

  get size(): number {
    return this.items.length
  }

  push(item: number, key: number): void {
    this.items.push(item)
    this.keys.push(key)

    let child = this.items.length - 1
    while (child > 0) {
      const parent = (child - 1) >> 1
      if (this.keys[parent] <= this.keys[child]) {
        break
      }
      this.swap(parent, child)
      child = parent
    }
  }

  pop(): number {
    const top = this.items[0]
    const lastItem = this.items.pop() as number
    const lastKey = this.keys.pop() as number

    if (this.items.length > 0) {
      this.items[0] = lastItem
      this.keys[0] = lastKey

      let parent = 0
      while (true) {
        const left = parent * 2 + 1
        const right = left + 1
        let smallest = parent

        if (left < this.items.length && this.keys[left] < this.keys[smallest]) {
          smallest = left
        }
        if (right < this.items.length && this.keys[right] < this.keys[smallest]) {
          smallest = right
        }
        if (smallest === parent) {
          break
        }

        this.swap(parent, smallest)
        parent = smallest
      }
    }

    return top
  }

  private swap(left: number, right: number): void {
    const item = this.items[left]
    this.items[left] = this.items[right]
    this.items[right] = item

    const key = this.keys[left]
    this.keys[left] = this.keys[right]
    this.keys[right] = key
  }
}
