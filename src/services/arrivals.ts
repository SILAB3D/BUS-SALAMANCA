import { Capacitor, CapacitorHttp } from '@capacitor/core'

import { buildFeed, parseStopFeed } from './arrival-parser'
import type { StopFeed } from '../types'

export { parseStopFeed } from './arrival-parser'

/**
 * Cliente de llegadas contra la web oficial de Salamanca de Transportes.
 *
 * La fuente esta detras de Cloudflare con un limitador por IP que se comporta como
 * un cubo de fichas (medido el 2026-08-17 contra `?ref=<parada>`):
 *
 *   - capacidad ~6-8 peticiones en rafaga desde reposo,
 *   - reposicion aproximada de 1 ficha cada ~1,2 s,
 *   - al agotarse responde 429 y se recupera en ~6-10 s,
 *   - una peticion cada 2 s se sostiene indefinidamente sin bloqueos.
 *
 * Ademas devuelve 403 si el User-Agent no es de navegador.
 *
 * Por eso TODAS las peticiones pasan por una unica cola serializada con espaciado
 * minimo. Nunca se lanzan peticiones en paralelo: es justamente lo que bloqueaba
 * la app cuando refrescaba varias paradas a la vez.
 */

const OFFICIAL_BASE_URL = 'https://salamancadetransportes.com/tiempos-de-llegada/'

/** En web (dev) se pasa por el proxy de Vite para evitar CORS. */
const PROXY_BASE_URL = '/api/arrivals'

const USER_AGENT =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'

/**
 * Espaciado SOSTENIDO entre peticiones. Medido como seguro indefinidamente.
 *
 * Es el ritmo al que se acaba cayendo cuando hay mucho que pedir, no el de la
 * primera peticion: para eso esta la rafaga (BURST_CAPACITY).
 */
export const MIN_REQUEST_SPACING_MS = 2_000

/**
 * Peticiones que pueden salir SEGUIDAS desde reposo.
 *
 * La fuente limita con un cubo de fichas, no con un cronometro: admite una
 * rafaga y luego repone. Medido el 2026-08-17 daba 6-8 fichas de capacidad y
 * una reposicion de ~1 ficha cada 1,2 s. Aqui se usan CUATRO, muy por debajo de
 * lo medido, porque pasarse cuesta un bloqueo de 6-10 s y quedarse corto solo
 * cuesta esperar un poco mas.
 *
 * Sin esto el cliente esperaba 2 s ANTES de la primera peticion aunque llevara
 * un minuto sin pedir nada: abrir una parada tardaba 2 s de reloj en empezar a
 * consultar, y ocho paradas de un recorrido eran mas de veinte segundos.
 */
const BURST_CAPACITY = 4

/**
 * Cada cuanto vuelve una ficha al cubo.
 *
 * 1,4 s frente a los ~1,2 s medidos: mismo criterio conservador. Por debajo de
 * este ritmo la fuente aguanta indefinidamente.
 */
const REFILL_MS = 1_400

/**
 * Fichas que el trafico de fondo NO puede gastar.
 *
 * Es lo que garantiza que la parada que alguien esta MIRANDO no espere: el
 * repaso de las paradas guardadas, el recorrido de un aviso y todo lo que nadie
 * tiene delante se quedan a una ficha del fondo del cubo, y esa ficha esta
 * siempre lista para quien abre una parada. Sin la reserva, tocar una tarjeta
 * en mitad de un repaso significaba esperar a que el lote soltara una ficha.
 */
const RESERVED_FOR_FOCUS = 1

/**
 * Peticiones simultaneas como maximo.
 *
 * Antes era estrictamente UNA: se esperaba la respuesta antes de pedir la
 * siguiente, asi que la latencia (~0,6 s) se SUMABA al espaciado en vez de
 * solaparse. Dos permiten aprovechar la rafaga de verdad sin acercarse a lo que
 * bloqueaba a la fuente, que eran las peticiones sin ningun limite.
 */
const MAX_IN_FLIGHT_BACKGROUND = 2

/**
 * Y una mas, reservada igual que la ficha.
 *
 * La reserva de fichas sola no bastaba: aunque hubiera ficha, la parada recien
 * abierta tenia que esperar a que una de las dos peticiones en vuelo terminara,
 * y eso son los ~3 s que tarda la fuente en responder. Medido antes de esto:
 * 3,3 s para una parada abierta en mitad de un repaso; con el hueco reservado
 * paga solo lo que tarde la red.
 */
const MAX_IN_FLIGHT = MAX_IN_FLIGHT_BACKGROUND + 1



/** Espaciado al que se degrada temporalmente tras recibir un 429. */
const THROTTLED_SPACING_MS = 4_000

/** Espera inicial tras un 429; se duplica en cada 429 consecutivo. */
const BACKOFF_BASE_MS = 8_000
const BACKOFF_MAX_MS = 60_000

/** Cuantos aciertos seguidos hacen falta para volver al espaciado normal. */
const RECOVERY_STREAK = 5

/** Antiguedad por defecto que se considera aceptable para reutilizar cache. */
export const DEFAULT_MAX_AGE_MS = 20_000

interface FetchOptions {
  /** Si la entrada en cache es mas reciente que esto, no se pide nada. */
  maxAgeMs?: number
  /** Las peticiones prioritarias (parada en pantalla) se atienden antes. */
  priority?: 'high' | 'normal'
  signal?: AbortSignal
  /**
   * La peticion de ESTA parada sale AHORA.
   *
   * Se avisa cuando la tarea ABANDONA la cola, no cuando entra. Son cosas
   * distintas y confundirlas es lo que hacia mentir al punto de estado de cada
   * parada: un lote de ocho entra entero en el mismo milisegundo, pero sale de
   * una en una a lo largo de quince segundos. Avisando al entrar, las ocho se
   * pintaban "consultando" a la vez y ninguna llegaba a pintarse "esperando
   * turno", que es el estado en el que pasan casi todo el rato.
   *
   * No se llama si la respuesta sale de la cache ni si se engancha a una
   * peticion ya en vuelo: ahi no se consulta nada.
   */
  onStart?: (stopId: string) => void
}

interface QueueTask {
  priority: number
  /** Resuelve cuando la peticion ha terminado (nunca rechaza: el error va al llamante). */
  run: () => Promise<void>
}

export interface ClientHealth {
  /** Espaciado efectivo actual entre peticiones. */
  spacingMs: number
  /** Fichas disponibles ahora mismo: lo que puede salir sin esperar. */
  tokens: number
  /** Peticiones pendientes en cola. */
  queued: number

  /** Timestamp hasta el que la cola esta penalizada por un 429. */
  penaltyUntil: number
  throttleEvents: number
  requestCount: number
  errorCount: number
  lastRequestAt: number
}

const cache = new Map<string, StopFeed>()
const inFlight = new Map<string, Promise<StopFeed>>()

const queue: QueueTask[] = []
let queueRunning = false
/** Peticiones en vuelo ahora mismo; nunca mas de MAX_IN_FLIGHT. */
let running = 0
let lastRequestAt = 0
let spacingMs = MIN_REQUEST_SPACING_MS
let penaltyUntil = 0
let backoffMs = BACKOFF_BASE_MS
let successStreak = 0

/** Fichas del cubo. Arranca lleno: al abrir la app no se debe nada. */
let tokens = BURST_CAPACITY
let tokensAt = Date.now()

const health: ClientHealth = {
  spacingMs,
  tokens: BURST_CAPACITY,
  queued: 0,

  penaltyUntil: 0,
  throttleEvents: 0,
  requestCount: 0,
  errorCount: 0,
  lastRequestAt: 0,
}

export function getClientHealth(): ClientHealth {
  refillTokens()
  return {
    ...health,
    spacingMs,
    tokens: Math.floor(tokens),
    queued: queue.length,
    penaltyUntil,
    lastRequestAt,
  }
}


export function getCachedFeed(stopId: string): StopFeed | null {
  return cache.get(stopId) ?? null
}

export function peekCacheAge(stopId: string): number | null {
  const entry = cache.get(stopId)
  return entry ? Date.now() - entry.fetchedAt : null
}

/**
 * Obtiene las llegadas de una parada. Reutiliza cache, agrupa peticiones
 * simultaneas de la misma parada y respeta el espaciado global.
 */
export async function fetchStopArrivals(stopId: string, options: FetchOptions = {}): Promise<StopFeed> {
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS
  const cached = cache.get(stopId)

  if (cached && Date.now() - cached.fetchedAt < maxAgeMs) {
    return cached
  }

  const pending = inFlight.get(stopId)
  if (pending) {
    return pending
  }

  const request = runQueued(
    () => {
      // Ya tiene ficha y hueco: esto sale a la red ahora mismo.
      options.onStart?.(stopId)
      return requestStopFeed(stopId, options.signal)
    },
    options.priority === 'high' ? 0 : 1,
  )
    .then((feed) => {
      // Un 429 no debe destruir el ultimo dato bueno: se conserva y se marca.
      if (feed.status === 'throttled' && cached) {
        const preserved: StopFeed = {
          ...cached,
          status: 'throttled',
          message: feed.message,
        }
        cache.set(stopId, preserved)
        return preserved
      }

      cache.set(stopId, feed)
      return feed
    })
    .finally(() => {
      inFlight.delete(stopId)
    })

  inFlight.set(stopId, request)
  return request
}

/**
 * Refresca varias paradas de forma SECUENCIAL. Devuelve los resultados segun se
 * completan a traves de `onFeed`, para que la interfaz pueda ir pintando sin
 * esperar al lote completo. `onStart` avisa de la parada que entra en turno,
 * para poder distinguir en pantalla lo que ya esta al dia de lo que espera.
 *
 * El lote se decide sobre la marcha, no de antemano: entre parada y parada
 * pasan dos segundos, y en ese rato lo que hacia falta al empezar puede haber
 * dejado de hacer falta.
 *
 *  - `shouldStop` corta el lote entero. Lo usa quien abre una parada concreta:
 *    lo que se este consultando pasa a segundo plano en el acto.
 *  - `shouldSkip` descarta UNA parada sin cortar el resto. Lo usa la busqueda
 *    del autobus hacia atras, que se para en cuanto lo encuentra.
 *
 * Las dos se consultan justo antes de pedir cada parada, con lo que ya se sabe.
 */
/**
 * Pide varias paradas A LA VEZ y las va entregando segun llegan.
 *
 * La diferencia con `fetchStopsSequentially` no es de estilo: alli el llamador
 * espera cada respuesta antes de pedir la siguiente, asi que en la cola no hay
 * nunca mas de una peticion y el cupo de la fuente —que admite una rafaga— se
 * desperdicia entero. Medido contra la fuente real: ocho paradas de un
 * recorrido tardaban 29,5 s pedidas de una en una.
 *
 * Aqui entran las ocho de golpe y es la COLA la que decide el ritmo, con su
 * cubo de fichas y su tope de peticiones en vuelo. El orden de llegada deja de
 * estar garantizado, y da igual: `onFeed` pinta cada parada en cuanto llega.
 *
 * Lo unico que NO puede usar esto es la busqueda del autobus hacia atras, que
 * decide si sigue preguntando SEGUN lo que devolvio la parada anterior. Esa
 * sigue en `fetchStopsSequentially`, que existe justo para eso.
 */
export async function fetchStopsInParallel(
  stopIds: string[],
  options: FetchOptions & {
    onFeed?: (feed: StopFeed) => void
    priorityOf?: (stopId: string) => 'high' | 'normal'
  } = {},
): Promise<StopFeed[]> {
  // `onStart` NO se dispara aqui: lo hace `fetchStopArrivals` cuando la
  // peticion sale de la cola. Avisandolo al encolar, las ocho paradas se
  // marcaban "consultando" en el mismo instante y el estado dejaba de decir
  // cual se esta pidiendo de verdad.
  const pending = stopIds.map((stopId) =>
    fetchStopArrivals(stopId, {
      ...options,
      priority: options.priorityOf?.(stopId) ?? options.priority,
    }).then((feed) => {
      options.onFeed?.(feed)
      return feed
    }),
  )

  return Promise.all(pending)
}

export async function fetchStopsSequentially(
  stopIds: string[],
  options: FetchOptions & {
    onFeed?: (feed: StopFeed) => void
    shouldStop?: () => boolean
    shouldSkip?: (stopId: string) => boolean
    /**
     * Prioridad de CADA parada, cuando no todas valen lo mismo.
     *
     * Un lote no es homogeneo: entre diez paradas guardadas puede ir la que
     * alguien tiene abierta en pantalla. Con una sola prioridad para todo el
     * lote, esa parada esperaba su turno como las demas —y eso son segundos de
     * reloj mirando un hueco— porque la prioridad solo servia para ordenar
     * lotes enteros entre si, no dentro de uno.
     */
    priorityOf?: (stopId: string) => 'high' | 'normal'
  } = {},
): Promise<StopFeed[]> {
  const results: StopFeed[] = []

  for (const stopId of stopIds) {
    if (options.signal?.aborted || options.shouldStop?.()) {
      break
    }

    if (options.shouldSkip?.(stopId)) {
      continue
    }

    const feed = await fetchStopArrivals(stopId, {
      ...options,
      priority: options.priorityOf?.(stopId) ?? options.priority,
    })
    results.push(feed)
    options.onFeed?.(feed)
  }

  return results
}

/**
 * Estima cuanto tardara en refrescarse un lote, para avisar en la UI.
 *
 * Cuenta la rafaga: las primeras salen casi seguidas y solo las que quedan
 * pagan la reposicion. Con el calculo anterior —todas al espaciado sostenido—
 * el aviso prometia el doble de espera de la que hay.
 */
export function estimateBatchDurationMs(stopCount: number): number {
  refillTokens()
  const free = Math.min(stopCount, Math.floor(tokens))
  const waiting = Math.max(0, stopCount - free)
  return waiting * (spacingMs > MIN_REQUEST_SPACING_MS ? spacingMs : REFILL_MS)
}


/* ------------------------------------------------------------------ *
 * Cola serializada                                                     *
 * ------------------------------------------------------------------ */

function runQueued<T>(task: () => Promise<T>, priority: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const entry: QueueTask = {
      priority,
      run: () => task().then(resolve, reject).catch(() => undefined),
    }

    // Insercion ordenada por prioridad, manteniendo FIFO dentro de cada nivel.
    const index = queue.findIndex((item) => item.priority > priority)
    if (index < 0) {
      queue.push(entry)
    } else {
      queue.splice(index, 0, entry)
    }

    void drainQueue()
  })
}

/** Devuelve al cubo las fichas que toquen por el tiempo transcurrido. */
function refillTokens(): void {
  const now = Date.now()
  const elapsed = now - tokensAt

  if (elapsed <= 0) {
    return
  }

  // Tras un 429 la reposicion se frena al mismo ritmo degradado que el
  // espaciado: el cubo no puede recuperarse mas deprisa que la fuente.
  const rate = spacingMs > MIN_REQUEST_SPACING_MS ? spacingMs : REFILL_MS
  tokens = Math.min(BURST_CAPACITY, tokens + elapsed / rate)
  tokensAt = now
}

/**
 * Milisegundos que faltan para poder atender a esa prioridad, o 0 si ya.
 *
 * El trafico de fondo se queda a `RESERVED_FOR_FOCUS` fichas del fondo: esa
 * reserva es de quien esta mirando una parada, y es lo que hace que abrir una
 * tarjeta en mitad de un repaso no signifique ponerse a la cola.
 */
function waitForToken(priority: number): number {
  refillTokens()

  const floor = priority === 0 ? 0 : RESERVED_FOR_FOCUS
  const needed = floor + 1 - tokens

  if (needed <= 0) {
    return 0
  }

  const rate = spacingMs > MIN_REQUEST_SPACING_MS ? spacingMs : REFILL_MS
  return Math.ceil(needed * rate)
}

async function drainQueue(): Promise<void> {
  if (queueRunning) {
    return
  }

  queueRunning = true

  try {
    while (queue.length > 0) {
      // La cola esta ordenada por prioridad, asi que la primera es la que mas
      // urge; es su prioridad la que decide si puede gastar la reserva.
      const next = queue[0]
      const waitMs = Math.max(penaltyUntil - Date.now(), waitForToken(next.priority), 0)

      if (waitMs > 0) {
        await delay(waitMs)
        continue
      }

      const slots = next.priority === 0 ? MAX_IN_FLIGHT : MAX_IN_FLIGHT_BACKGROUND

      if (running >= slots) {

        // Sin ficha que gastar todavia: se espera a que vuelva un hueco. Es una
        // espera corta y acotada, no un sondeo.
        await delay(60)
        continue
      }

      const task = queue.shift()
      if (!task) {
        break
      }

      refillTokens()
      tokens = Math.max(0, tokens - 1)
      lastRequestAt = Date.now()
      health.lastRequestAt = lastRequestAt

      // Ya NO se espera la respuesta antes de tomar la siguiente: lo que limita
      // el ritmo es el cubo de fichas, no el ir de una en una. Esperandola, la
      // latencia se sumaba al espaciado y ocho paradas pasaban de ~7 s a ~21 s.
      running += 1
      void task.run().finally(() => {
        running -= 1
        // Puede haber quedado trabajo esperando hueco mientras esta corria.
        void drainQueue()
      })
    }
  } finally {
    queueRunning = false
  }
}


function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function registerThrottle(): void {
  health.throttleEvents += 1
  successStreak = 0
  spacingMs = THROTTLED_SPACING_MS
  penaltyUntil = Date.now() + backoffMs
  backoffMs = Math.min(BACKOFF_MAX_MS, backoffMs * 2)

  // El cubo se vacia: si la fuente acaba de decir que no, no quedan fichas que
  // gastar por muy de reposo que se viniera. Es lo que impide que una rafaga
  // encadene un 429 detras de otro.
  tokens = 0
  tokensAt = Date.now()
}

function registerSuccess(): void {
  successStreak += 1
  if (successStreak >= RECOVERY_STREAK) {
    spacingMs = MIN_REQUEST_SPACING_MS
    backoffMs = BACKOFF_BASE_MS
  }
}

/* ------------------------------------------------------------------ *
 * Peticion + parseo                                                    *
 * ------------------------------------------------------------------ */

async function requestStopFeed(stopId: string, signal?: AbortSignal): Promise<StopFeed> {
  health.requestCount += 1

  try {
    const { status, body } = await httpGet(stopId, signal)

    if (status === 429) {
      registerThrottle()
      return buildFeed(stopId, 'throttled', [], null, 'La fuente oficial esta limitando las consultas. Reintentando…')
    }

    if (status === 403) {
      health.errorCount += 1
      return buildFeed(stopId, 'error', [], null, 'La fuente oficial rechazo la consulta (403).')
    }

    if (status !== 200) {
      health.errorCount += 1
      return buildFeed(stopId, 'error', [], null, `La fuente oficial respondio ${status}.`)
    }

    registerSuccess()
    return parseStopFeed(stopId, body)
  } catch (error) {
    health.errorCount += 1
    const message = error instanceof Error ? error.message : 'Error de red desconocido.'
    return buildFeed(stopId, 'error', [], null, `No se pudo contactar con la fuente oficial: ${message}`)
  }
}

async function httpGet(stopId: string, signal?: AbortSignal): Promise<{ status: number, body: string }> {
  if (Capacitor.isNativePlatform()) {
    const response = await CapacitorHttp.get({
      url: `${OFFICIAL_BASE_URL}?ref=${encodeURIComponent(stopId)}`,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'es-ES,es;q=0.9',
      },
      // Evita que una respuesta colgada bloquee la cola indefinidamente.
      connectTimeout: 12_000,
      readTimeout: 12_000,
    })

    return {
      status: response.status,
      body: typeof response.data === 'string' ? response.data : String(response.data ?? ''),
    }
  }

  const response = await fetch(`${PROXY_BASE_URL}?ref=${encodeURIComponent(stopId)}`, { signal })
  return { status: response.status, body: await response.text() }
}

