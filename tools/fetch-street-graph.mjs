/**
 * Genera `public/data/streets.json`: el callejero peatonal de Salamanca.
 *
 * POR QUE EXISTE
 *
 * El calculo de rutas media los paseos en linea recta. En una ciudad eso no es
 * una aproximacion, es otra cosa: entre dos puntos separados 200 m en el mapa
 * puede haber un rio, una via de tren o una manzana entera, y el resultado era
 * sistematicamente optimista siempre en la misma direccion. Con las calles
 * cargadas, un paseo se mide por donde de verdad se anda y ademas se puede
 * DIBUJAR, que es lo que convierte "300 m andando" en una indicacion util.
 *
 * DE DONDE SALE
 *
 * De OpenStreetMap, via Overpass. Se piden las vias por las que se puede andar
 * dentro del rectangulo que cubre la red de autobuses, con un margen. Se
 * descartan autopistas y vias rapidas (no se anda por ellas) y todo lo que este
 * marcado como prohibido o privado para peatones.
 *
 * QUE FORMATO TIENE
 *
 * Lo mas compacto que sigue siendo legible: las coordenadas van en enteros de
 * 1e-6 grados y DIFERENCIALES respecto a la anterior (dos calles seguidas estan
 * a metros una de otra, asi que casi todos los numeros caben en tres cifras), y
 * las aristas en un unico array plano de indices. Guardar el JSON crudo de
 * Overpass costaba varias decenas de megas; asi son unos pocos cientos de kB,
 * que es lo unico que hace viable meterlo en la app.
 *
 * El fichero NO se carga al arrancar: lo pide `src/services/streets.ts` la
 * primera vez que alguien calcula una ruta en la pestana experimental. Una
 * funcion en pruebas no puede encarecer el arranque de toda la app.
 *
 * Uso:
 *   npm run data:streets
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const NETWORK_FILE = path.join(ROOT, 'public', 'data', 'network.json')
const OUTPUT_FILE = path.join(ROOT, 'public', 'data', 'streets.json')

/** Margen alrededor de la red de autobuses, en grados (~1,5 km). */
const MARGIN_DEG = 0.014

const ENDPOINTS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
]

/**
 * Overpass rechaza con un 406 a quien no se presenta.
 *
 * Es una instancia publica y gratuita: identificarse no es un formalismo, es la
 * unica forma que tiene quien la mantiene de distinguir una herramienta que se
 * ejecuta a mano de vez en cuando de un raspado automatico.
 */
const USER_AGENT = 'SALBUS/1.0 (generador del callejero peatonal de Salamanca)'

/**
 * Vias por las que se anda.
 *
 * Se excluyen autopistas y vias rapidas con sus enlaces, lo que aun no existe
 * (`construction`, `proposed`) y los circuitos. `foot=no` y los accesos
 * privados se descartan explicitamente: una ruta que cruza por un patio cerrado
 * es peor que una ruta larga.
 */
const QUERY = (bbox) => `
[out:json][timeout:240];
(
  way
    ["highway"]
    ["highway"!~"^(motorway|motorway_link|trunk|trunk_link|construction|proposed|raceway|bus_guideway)$"]
    ["foot"!~"^(no|private)$"]
    ["access"!~"^(no|private)$"]
    (${bbox});
);
out body;
>;
out skel qt;
`

async function main() {
  const bbox = await readBoundingBox()
  console.log(`Rectangulo: ${bbox}`)

  const payload = await downloadWithFallback(QUERY(bbox))
  console.log(`Overpass devolvio ${payload.elements.length} elementos.`)

  const graph = buildGraph(payload)
  console.log(
    `Grafo: ${graph.nodeCount} nodos y ${graph.edgeCount} aristas tras podar lo que no lleva a ninguna parte.`,
  )

  const encoded = encode(graph, bbox)
  await fs.writeFile(OUTPUT_FILE, JSON.stringify(encoded))

  const { size } = await fs.stat(OUTPUT_FILE)
  console.log(`Escrito ${path.relative(ROOT, OUTPUT_FILE)} · ${(size / 1024).toFixed(0)} kB`)
}

/** El rectangulo sale de la propia red de autobuses, mas un margen. */
async function readBoundingBox() {
  const network = JSON.parse(await fs.readFile(NETWORK_FILE, 'utf8'))
  const stops = Object.values(network.stopsById ?? {})

  if (stops.length === 0) {
    throw new Error('network.json no tiene paradas: ejecuta antes `npm run data:network`.')
  }

  let south = 90
  let north = -90
  let west = 180
  let east = -180

  for (const stop of stops) {
    south = Math.min(south, stop.lat)
    north = Math.max(north, stop.lat)
    west = Math.min(west, stop.lon)
    east = Math.max(east, stop.lon)
  }

  return [
    (south - MARGIN_DEG).toFixed(5),
    (west - MARGIN_DEG).toFixed(5),
    (north + MARGIN_DEG).toFixed(5),
    (east + MARGIN_DEG).toFixed(5),
  ].join(',')
}

/**
 * Overpass es un servicio publico y compartido: responde 429 cuando esta
 * ocupado. Se prueban varios espejos antes de darse por vencido, porque volver
 * a lanzar la consulta a mano es justo lo que nadie hace.
 */
async function downloadWithFallback(query) {
  let lastError = null

  for (const endpoint of ENDPOINTS) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        console.log(`Consultando ${endpoint} (intento ${attempt})…`)
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': USER_AGENT,
          },
          body: new URLSearchParams({ data: query }),
        })

        if (response.status === 429 || response.status === 504) {
          lastError = new Error(`El servidor esta ocupado (${response.status}).`)
          await wait(attempt * 15_000)
          continue
        }

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`)
        }

        return await response.json()
      } catch (error) {
        lastError = error
        await wait(attempt * 5_000)
      }
    }
  }

  throw new Error(`No se pudo descargar el callejero: ${lastError?.message ?? 'motivo desconocido'}`)
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Convierte la respuesta de Overpass en un grafo no dirigido.
 *
 * Se quedan SOLO los nodos que participan en alguna via andable: Overpass
 * devuelve tambien los de las vias descartadas, y guardarlos serian cientos de
 * kilobytes de puntos sueltos a los que no llega ninguna arista.
 */
function buildGraph(payload) {
  const coordinates = new Map()
  const ways = []

  for (const element of payload.elements) {
    if (element.type === 'node') {
      coordinates.set(element.id, { lat: element.lat, lon: element.lon })
    } else if (element.type === 'way' && Array.isArray(element.nodes)) {
      ways.push(element.nodes)
    }
  }

  const used = new Set()
  for (const nodes of ways) {
    for (const id of nodes) {
      if (coordinates.has(id)) {
        used.add(id)
      }
    }
  }

  // Orden estable y espacialmente coherente: los nodos se numeran recorriendo
  // la ciudad de sur a norte, de modo que dos indices consecutivos estan cerca
  // y las diferencias que se guardan luego son numeros pequenos.
  const ordered = [...used]
    .map((id) => ({ id, ...coordinates.get(id) }))
    .sort((left, right) => left.lat - right.lat || left.lon - right.lon)

  const indexById = new Map(ordered.map((node, index) => [node.id, index]))

  const edges = []
  const seen = new Set()

  for (const nodes of ways) {
    for (let index = 1; index < nodes.length; index += 1) {
      const from = indexById.get(nodes[index - 1])
      const to = indexById.get(nodes[index])

      if (from === undefined || to === undefined || from === to) {
        continue
      }

      const key = from < to ? `${from}:${to}` : `${to}:${from}`
      if (seen.has(key)) {
        continue
      }

      seen.add(key)
      edges.push(from, to)
    }
  }

  return { nodes: ordered, edges, nodeCount: ordered.length, edgeCount: edges.length / 2 }
}

/**
 * Codifica el grafo.
 *
 * Latitud y longitud en millonesimas de grado (una millonesima de grado son
 * ~11 cm: mas precision de la que tiene el propio OSM) y guardadas como
 * diferencia con el nodo anterior. Con los nodos ordenados por posicion, esas
 * diferencias son casi siempre de tres o cuatro cifras en vez de ocho.
 */
function encode(graph, bbox) {
  const lat = []
  const lon = []
  let previousLat = 0
  let previousLon = 0

  for (const node of graph.nodes) {
    const currentLat = Math.round(node.lat * 1e6)
    const currentLon = Math.round(node.lon * 1e6)
    lat.push(currentLat - previousLat)
    lon.push(currentLon - previousLon)
    previousLat = currentLat
    previousLon = currentLon
  }

  return {
    source: 'OpenStreetMap · Overpass API (ODbL)',
    generatedAt: new Date().toISOString(),
    bbox,
    nodeCount: graph.nodeCount,
    edgeCount: graph.edgeCount,
    /** Diferencias sucesivas en millonesimas de grado. */
    lat,
    lon,
    /** Pares planos de indices: [a0, b0, a1, b1, …]. */
    edges: graph.edges,
  }
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
