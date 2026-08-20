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

/** Espaciado minimo entre peticiones consecutivas. Medido como seguro. */
export const MIN_REQUEST_SPACING_MS = 2_000

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
}

interface QueueTask {
  priority: number
  /** Resuelve cuando la peticion ha terminado (nunca rechaza: el error va al llamante). */
  run: () => Promise<void>
}

export interface ClientHealth {
  /** Espaciado efectivo actual entre peticiones. */
  spacingMs: number
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
let lastRequestAt = 0
let spacingMs = MIN_REQUEST_SPACING_MS
let penaltyUntil = 0
let backoffMs = BACKOFF_BASE_MS
let successStreak = 0

const health: ClientHealth = {
  spacingMs,
  queued: 0,
  penaltyUntil: 0,
  throttleEvents: 0,
  requestCount: 0,
  errorCount: 0,
  lastRequestAt: 0,
}

export function getClientHealth(): ClientHealth {
  return {
    ...health,
    spacingMs,
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

  const request = runQueued(() => requestStopFeed(stopId, options.signal), options.priority === 'high' ? 0 : 1)
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
 */
export async function fetchStopsSequentially(
  stopIds: string[],
  options: FetchOptions & {
    onFeed?: (feed: StopFeed) => void
    onStart?: (stopId: string) => void
  } = {},
): Promise<StopFeed[]> {
  const results: StopFeed[] = []

  for (const stopId of stopIds) {
    if (options.signal?.aborted) {
      break
    }

    options.onStart?.(stopId)
    const feed = await fetchStopArrivals(stopId, options)
    results.push(feed)
    options.onFeed?.(feed)
  }

  return results
}

/** Estima cuanto tardara en refrescarse un lote de paradas, para avisar en la UI. */
export function estimateBatchDurationMs(stopCount: number): number {
  return Math.max(0, stopCount - 1) * spacingMs
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

async function drainQueue(): Promise<void> {
  if (queueRunning) {
    return
  }

  queueRunning = true

  try {
    while (queue.length > 0) {
      const waitMs = Math.max(penaltyUntil - Date.now(), lastRequestAt + spacingMs - Date.now(), 0)
      if (waitMs > 0) {
        await delay(waitMs)
        continue
      }

      const task = queue.shift()
      if (!task) {
        break
      }

      lastRequestAt = Date.now()
      health.lastRequestAt = lastRequestAt

      // Se espera a que termine antes de tomar la siguiente: garantiza que nunca
      // haya dos peticiones simultaneas contra la fuente oficial.
      await task.run()
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

