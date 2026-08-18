import type { Arrival, StopFeed, StopFeedStatus } from '../types'

/**
 * Lectura del panel de llegadas de la web oficial.
 *
 * Vive aparte del cliente HTTP a proposito: aqui no hay red ni Capacitor, solo
 * texto que entra y datos que salen. Asi las pruebas de Node (`npm test`) y el
 * registrador en vivo (`tools/punctuality-live.mjs`) usan EXACTAMENTE el mismo
 * parser que la aplicacion, en vez de una copia que se va quedando atras.
 */

const RESULTS_BLOCK = 'id="arrival_times_results"'
const ROW_SPLIT = /<div\s+class="arrival_times_results_row">/i

/**
 * Extrae las llegadas fila a fila.
 *
 * Es importante NO usar una expresion regular global que salte de `<b>Línea N:</b>`
 * al siguiente `<span class="right">… minutos</span>`: las filas "LLEGANDO A PARADA"
 * no llevan minutos y una regex perezosa emparejaria esa linea con el tiempo de la
 * fila siguiente, ocultando los buses inminentes y desplazando todos los tiempos.
 */
export function parseStopFeed(stopId: string, html: string): StopFeed {
  const blockStart = html.indexOf(RESULTS_BLOCK)
  if (blockStart < 0) {
    return buildFeed(stopId, 'error', [], null, 'La respuesta no contiene el panel de llegadas.')
  }

  const block = html.slice(blockStart, blockStart + 20_000)
  const stopName = extractStopName(block)

  if (/No hay datos actuales de l[ií]neas/i.test(block)) {
    return buildFeed(stopId, 'empty', [], stopName, 'Ahora mismo no circula ninguna linea por esta parada.')
  }

  const observedAt = Date.now()
  const arrivals: Arrival[] = []

  for (const chunk of block.split(ROW_SPLIT).slice(1)) {
    const row = chunk.slice(0, chunk.indexOf('</div></div>') >= 0 ? chunk.indexOf('</div></div>') + 12 : 600)

    const lineMatch = row.match(/<b>\s*L[ií]nea\s*([^:<]+)\s*:\s*<\/b>/i)
    if (!lineMatch) {
      continue
    }

    const lineId = lineMatch[1].trim()
    const valueMatch = row.match(/<span[^>]*class="right"[^>]*>([\s\S]*?)<\/span>/i)
    if (!lineId || !valueMatch) {
      continue
    }

    const rawValue = valueMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    const parsed = parseArrivalValue(rawValue)
    if (!parsed) {
      continue
    }

    arrivals.push({
      stopId,
      lineId,
      minutesUntil: parsed.minutesUntil,
      status: parsed.status,
      estimatedClock: formatClock(observedAt + parsed.minutesUntil * 60_000),
      observedAt,
    })
  }

  arrivals.sort((left, right) => left.minutesUntil - right.minutesUntil)

  if (arrivals.length === 0) {
    return buildFeed(stopId, 'empty', [], stopName, 'La fuente oficial no devolvio llegadas para esta parada.')
  }

  return buildFeed(stopId, 'ok', arrivals, stopName, null)
}

function parseArrivalValue(value: string): { minutesUntil: number, status: Arrival['status'] } | null {
  if (/llegando/i.test(value) || /en\s+parada/i.test(value)) {
    return { minutesUntil: 0, status: 'arriving' }
  }

  const minutesMatch = value.match(/(\d+)\s*minuto/i)
  if (minutesMatch) {
    const minutes = Number.parseInt(minutesMatch[1], 10)
    return Number.isFinite(minutes) ? { minutesUntil: minutes, status: 'scheduled' } : null
  }

  return null
}

function extractStopName(block: string): string | null {
  const match = block.match(/parada\s+[^,]+,\s*<b>([^<]+)<\/b>/i)
  return match ? match[1].replace(/\s+/g, ' ').trim() : null
}

export function buildFeed(
  stopId: string,
  status: StopFeedStatus,
  arrivals: Arrival[],
  stopName: string | null,
  message: string | null,
): StopFeed {
  return { stopId, stopName, status, arrivals, fetchedAt: Date.now(), message }
}

function formatClock(epochMs: number): string {
  const date = new Date(epochMs)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}
