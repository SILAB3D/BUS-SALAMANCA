/**
 * Descarga la red oficial de Salamanca de Transportes y genera `public/data/network.json`.
 *
 * Fuente oficial: https://salamancadetransportes.com/informacion-de-lineas/lineas/
 * Esa pagina incrusta, por cada linea, los atributos `data-paradas-trayecto-{uno..cuatro}`
 * con la secuencia ORDENADA de paradas de cada sentido (ref, nombre, lat, lng), ademas de
 * `data-nombre-trayecto-*` con el rotulo oficial "Origen (parada) > Destino (parada)".
 *
 * Uso:  node tools/fetch-official-network.mjs
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const OUTPUT_PATH = path.join(projectRoot, 'public', 'data', 'network.json')

const LINES_URL = 'https://salamancadetransportes.com/informacion-de-lineas/lineas/'

// El WAF de la web oficial responde 403 a peticiones sin User-Agent de navegador.
const USER_AGENT =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'

const DIRECTION_SLOTS = ['uno', 'dos', 'tres', 'cuatro']

async function main() {
  console.log(`[network] Descargando ${LINES_URL}`)
  const response = await fetch(LINES_URL, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'es-ES,es;q=0.9',
    },
  })

  if (!response.ok) {
    throw new Error(`La fuente oficial respondio HTTP ${response.status}.`)
  }

  const html = await response.text()
  const lines = parseLines(html)

  if (lines.length === 0) {
    throw new Error('No se pudo extraer ninguna linea; la estructura de la web oficial ha cambiado.')
  }

  const stopsById = collectStops(lines)
  const linesByStopId = collectLinesByStop(lines)

  const payload = {
    source: LINES_URL,
    generatedAt: new Date().toISOString(),
    lineCount: lines.length,
    directionCount: lines.reduce((total, line) => total + line.directions.length, 0),
    stopCount: Object.keys(stopsById).length,
    lines,
    stopsById,
    linesByStopId,
  }

  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true })
  await fs.writeFile(OUTPUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')

  console.log(
    `[network] ${payload.lineCount} lineas · ${payload.directionCount} sentidos · ${payload.stopCount} paradas`,
  )
  console.log(`[network] Escrito ${path.relative(projectRoot, OUTPUT_PATH)}`)
}

function parseLines(html) {
  const chunks = html.split("data-nombre-linea='").slice(1)
  const lines = []

  for (const rawChunk of chunks) {
    // Cada bloque de linea termina donde arranca el siguiente onclick del indice.
    const chunk = rawChunk.split('lineas_index_left_element')[0]

    const name = decodeEntities(chunk.slice(0, chunk.indexOf("'")))
    const id = matchAttribute(chunk, 'data-id-linea')
    if (!id) {
      continue
    }

    const colorMatch = rawChunk.match(/background-color:\s*(#[0-9a-fA-F]{3,8})/)
    const directions = []

    for (const slot of DIRECTION_SLOTS) {
      const rawStops = matchAttribute(chunk, `data-paradas-trayecto-${slot}`)
      if (!rawStops) {
        continue
      }

      let parsedStops
      try {
        parsedStops = JSON.parse(decodeEntities(rawStops))
      } catch {
        continue
      }

      if (!Array.isArray(parsedStops) || parsedStops.length === 0) {
        continue
      }

      const stops = parsedStops
        .map((stop) => ({
          stopId: String(stop.ref ?? '').trim(),
          stopName: collapseSpaces(String(stop.name ?? '')),
          lat: Number.parseFloat(String(stop.lat ?? '')),
          lon: Number.parseFloat(String(stop.lng ?? '')),
        }))
        .filter((stop) => stop.stopId.length > 0)

      if (stops.length === 0) {
        continue
      }

      const label = collapseSpaces(decodeEntities(matchAttribute(chunk, `data-nombre-trayecto-${slot}`) ?? ''))
      const { origin, destination, circular } = splitLabel(label, stops)

      directions.push({
        key: `${id}|${slot}`,
        slot,
        // Los trayectos 1/3 son el sentido "ida" y 2/4 el sentido "vuelta"; 3 y 4 son
        // variantes parciales (refuerzos que no cubren la linea completa).
        way: slot === 'uno' || slot === 'tres' ? 'ida' : 'vuelta',
        partial: slot === 'tres' || slot === 'cuatro',
        circular,
        label,
        origin,
        destination,
        stopCount: stops.length,
        stops,
      })
    }

    if (directions.length === 0) {
      continue
    }

    lines.push({
      lineId: id,
      shortName: id,
      name,
      title: collapseSpaces(name.replace(/^L[ií]nea\s*\d+\.\s*/i, '')),
      color: colorMatch ? colorMatch[1].toUpperCase() : '#173764',
      directions,
    })
  }

  lines.sort((left, right) => compareLineIds(left.lineId, right.lineId))
  return lines
}

function collectStops(lines) {
  const stops = {}

  for (const line of lines) {
    for (const direction of line.directions) {
      for (const stop of direction.stops) {
        const existing = stops[stop.stopId]
        if (existing) {
          // Conserva las coordenadas validas si alguna aparicion viene incompleta.
          if (!Number.isFinite(existing.lat) && Number.isFinite(stop.lat)) {
            existing.lat = stop.lat
            existing.lon = stop.lon
          }
          continue
        }

        stops[stop.stopId] = {
          stopId: stop.stopId,
          stopName: stop.stopName,
          lat: stop.lat,
          lon: stop.lon,
        }
      }
    }
  }

  return stops
}

function collectLinesByStop(lines) {
  const byStop = {}

  for (const line of lines) {
    for (const direction of line.directions) {
      for (const stop of direction.stops) {
        const entries = byStop[stop.stopId] ?? []
        if (!entries.includes(line.lineId)) {
          entries.push(line.lineId)
        }
        byStop[stop.stopId] = entries
      }
    }
  }

  for (const entries of Object.values(byStop)) {
    entries.sort(compareLineIds)
  }

  return byStop
}

function matchAttribute(source, attribute) {
  const match = source.match(new RegExp(`${attribute}='([^']*)'`))
  return match ? match[1] : null
}

function splitLabel(label, stops) {
  const separatorIndex = label.indexOf('>')

  // Las lineas 91 y 92 (servicio nocturno) son circulares: la web las rotula con
  // un solo nombre, sin "origen > destino". Se marcan como tales y se usa la
  // primera parada del recorrido como referencia en ambos extremos.
  if (separatorIndex < 0) {
    const terminus = stops[0]?.stopName ?? label
    return { origin: label || terminus, destination: label || terminus, circular: true }
  }

  return {
    origin: collapseSpaces(label.slice(0, separatorIndex)),
    destination: collapseSpaces(label.slice(separatorIndex + 1)),
    circular: false,
  }
}

function decodeEntities(value) {
  return String(value ?? '')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&')
}

function collapseSpaces(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function compareLineIds(left, right) {
  const leftNumber = Number.parseInt(left, 10)
  const rightNumber = Number.parseInt(right, 10)
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber !== rightNumber) {
    return leftNumber - rightNumber
  }
  return String(left).localeCompare(String(right), 'es')
}

await main()
