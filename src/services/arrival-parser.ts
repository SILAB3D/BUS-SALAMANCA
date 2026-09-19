import type { Arrival, StopFeed, StopFeedStatus } from '../types'

/**
 * Lectura del panel de llegadas de la fuente oficial.
 *
 * Vive aparte del cliente HTTP a proposito: aqui no hay red ni Capacitor, solo
 * texto que entra y datos que salen. Asi las pruebas de Node (`npm test`) y el
 * registrador en vivo (`tools/punctuality-live.mjs`) usan EXACTAMENTE el mismo
 * parser que la aplicacion, en vez de una copia que se va quedando atras.
 *
 * LA FUENTE CAMBIO. Hasta 2026 la web oficial pintaba el panel en el propio
 * HTML (`id="arrival_times_results"`, una fila por linea con "N minutos" o
 * "LLEGANDO A PARADA") y este modulo la raspaba. El sitio se rehizo en Next.js:
 * el HTML ya no trae ninguna llegada —las pinta el navegador despues— y el
 * raspado devolvia siempre "La respuesta no contiene el panel de llegadas",
 * que en pantalla es el "Sin conexion" de todas las paradas.
 *
 * Ahora se lee el JSON de `/api/siri/arrivals?stop=<parada>`, que es lo que
 * pide la propia web. Es la misma informacion pero mejor: en vez de un contador
 * de minutos ya redondeado trae la HORA de paso prevista, y ademas el vehiculo,
 * su posicion, su distancia a la parada y el desvio sobre el horario.
 */

/** Forma de una fila del JSON oficial. Todos los campos llegan como texto. */
interface SiriArrival {
  lineCode?: string
  lineName?: string
  /** Distancia del vehiculo a la parada, "1234 m". */
  distance?: string
  /** Hora de paso prevista, ISO con huso: "2026-09-19T12:00:00+02:00". */
  expectedArrival?: string
  /** Hora de paso programada, ISO SIN huso (hora local de Salamanca). */
  aimedArrival?: string
  vehicleId?: string
  longitude?: string
  latitude?: string
  directionName?: string
  /** Desvio sobre el horario, duracion ISO-8601 con signo: "-PT8M", "PT1M". */
  delay?: string
}

/**
 * Hasta que distancia se considera que el autobus esta ENTRANDO en la parada.
 *
 * Es el mismo umbral con el que la web oficial pinta en verde la tarjeta.
 */
const ARRIVING_DISTANCE_METERS = 200

/**
 * Y hasta cuantos minutos, ademas de la distancia.
 *
 * La distancia SOLA no sirve, y no es un detalle: en una cabecera el autobus
 * que acaba de terminar el trayecto esta a veinte metros de la parada pero no
 * sale hasta dentro de nueve minutos. Marcarlo "llegando" solo por la distancia
 * pondria "Llegando" en pantalla al lado de un tiempo de nueve minutos.
 */
const ARRIVING_MAX_MINUTES = 1

/**
 * Convierte la respuesta de `/api/siri/arrivals` en el feed de una parada.
 *
 * `observedAt` existe para las pruebas: los minutos salen de restar la hora
 * prevista al instante de la consulta, asi que sin poder fijar ese instante no
 * habria forma de comprobar nada contra un fixture.
 */
export function parseStopFeed(stopId: string, body: string, observedAt: number = Date.now()): StopFeed {
  if (looksLikeChallenge(body)) {
    return buildFeed(stopId, 'throttled', [], null, 'La fuente oficial esta pidiendo verificacion. Reintentando…')
  }

  let payload: unknown
  try {
    payload = JSON.parse(body)
  } catch {
    return buildFeed(stopId, 'error', [], null, 'La fuente oficial no devolvio datos legibles.')
  }

  if (!payload || typeof payload !== 'object') {
    return buildFeed(stopId, 'error', [], null, 'La fuente oficial no devolvio datos legibles.')
  }

  // La API contesta `{"error":"..."}` con un 400 cuando falta la parada.
  const declaredError = (payload as { error?: unknown }).error
  if (typeof declaredError === 'string' && declaredError) {
    return buildFeed(stopId, 'error', [], null, declaredError)
  }

  const rows = (payload as { data?: unknown }).data
  if (!Array.isArray(rows)) {
    return buildFeed(stopId, 'error', [], null, 'La respuesta de la fuente oficial no trae llegadas.')
  }

  const arrivals: Arrival[] = []

  /*
   * Una misma expedicion puede venir DOS VECES: la fuente publica cada paso por
   * sentido, y en una cabecera el mismo vehiculo figura a la vez como el que
   * llega y como el que sale. Cuando las dos filas caen en el mismo minuto son
   * la misma cosa contada dos veces, y en pantalla serian dos renglones
   * identicos; cuando caen en minutos distintos (llega a y cuarto, sale a y
   * media) son dos pasos de verdad por esa parada y los dos interesan.
   */
  const seen = new Set<string>()

  for (const row of rows as SiriArrival[]) {
    if (!row || typeof row !== 'object') {
      continue
    }

    const lineId = typeof row.lineCode === 'string' ? row.lineCode.trim() : ''
    if (!lineId) {
      continue
    }

    const expectedAt = parseInstant(row.expectedArrival) ?? parseInstant(row.aimedArrival)
    if (expectedAt === null) {
      continue
    }

    const minutesUntil = Math.max(0, Math.round((expectedAt - observedAt) / 60_000))
    const distanceMeters = parseDistance(row.distance)

    // Sin identificador de vehiculo, el sentido es lo unico que distingue las
    // dos caras de una cabecera, asi que hace de sustituto.
    const key = `${lineId}|${row.vehicleId ?? row.directionName ?? ''}|${minutesUntil}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)

    const arriving =
      minutesUntil <= 0 ||
      (distanceMeters !== null &&
        distanceMeters <= ARRIVING_DISTANCE_METERS &&
        minutesUntil <= ARRIVING_MAX_MINUTES)

    arrivals.push({
      stopId,
      lineId,
      minutesUntil,
      status: arriving ? 'arriving' : 'scheduled',
      // La hora de paso ya no se deduce sumando minutos: la dice la fuente.
      estimatedClock: formatClock(expectedAt),
      observedAt,
    })
  }

  arrivals.sort((left, right) => left.minutesUntil - right.minutesUntil)

  if (arrivals.length === 0) {
    return buildFeed(stopId, 'empty', [], null, 'Ahora mismo no circula ninguna linea por esta parada.')
  }

  return buildFeed(stopId, 'ok', arrivals, null, null)
}

/**
 * Es esto el muro de verificacion de Cloudflare en vez de una respuesta?
 *
 * Importa distinguirlo porque NO es un fallo: es la fuente diciendo que se le
 * esta pidiendo demasiado. Llega como un 403 con una pagina HTML, y tratarlo
 * como error dejaba la parada en "Sin conexion" y tiraba por el desague el
 * ultimo dato bueno, cuando lo que toca es esperar y conservarlo.
 */
export function looksLikeChallenge(body: string): boolean {
  if (!body) {
    return false
  }

  return (
    body.includes('_cf_chl_opt') ||
    body.includes('/cdn-cgi/challenge-platform') ||
    body.includes('<title>Just a moment...</title>')
  )
}

/** "1234 m" -> 1234. `null` si no viene o no se entiende. */
function parseDistance(value: string | undefined): number | null {
  if (typeof value !== 'string') {
    return null
  }

  const match = value.match(/-?\d+/)
  if (!match) {
    return null
  }

  const meters = Number.parseInt(match[0], 10)
  return Number.isFinite(meters) ? meters : null
}

function parseInstant(value: string | undefined): number | null {
  if (typeof value !== 'string' || !value) {
    return null
  }

  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
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
