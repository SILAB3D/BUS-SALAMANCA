import type { Network } from './services/network'
import { averageMinutes } from './services/punctuality'
import type { MonitorRuntime } from './services/punctuality'
import type { ScheduleDataset, ServiceDayType, StopFeed } from './types'

export const APP_VERSION = 'v4.2'

export type TabId = 'inicio' | 'buscar' | 'paradas' | 'monitor' | 'seguimiento' | 'ajustes'
export type SearchMode = 'nombre' | 'linea' | 'mapa'
export type PermissionState = 'granted' | 'denied' | 'unknown'

export interface FavouriteStop {
  stopId: string
  alias: string | null
  addedAt: number
}

/** Aviso de proximo bus: notificacion persistente que se actualiza en vivo. */
export interface TrackingJob {
  id: string
  stopId: string
  stopName: string
  lineId: string
  startedAt: number
  lastMinutes: number | null
  lastNotifiedAt: number
  /** Se arma cuando el bus se acerca; al desaparecer o alejarse se da por pasado. */
  armed: boolean
  missingStreak: number
  /** Autobuses ya vistos pasar; el aviso termina al llegar a TRACKING_BUS_TARGET. */
  busesSeen: number
}

/** Autobuses que hay que ver pasar antes de dar por terminado el aviso. */
export const TRACKING_BUS_TARGET = 3

/** Monitorizacion: registra pasos reales en una franja para calcular medias. */
export interface MonitorJob {
  id: string
  stopId: string
  stopName: string
  lineId: string
  /** Sentido elegido; sin el, el horario mezcla los dos sentidos de la parada. */
  directionKey: string | null
  startMinutes: number
  endMinutes: number
  createdAt: number
}

/** Un paso real observado. Es el dato en bruto: todo lo demas se calcula de aqui. */
export interface MonitorPass {
  /** Instante estimado del paso (epoch ms). */
  at: number
  /** Fecha local YYYY-MM-DD, para no contar dos veces el mismo dia. */
  date: string
  dayType: ServiceDayType
  /** Minuto del dia en que paso. */
  minutes: number
  /** Salida programada a la que se ha podido asociar, o null. */
  slot: string | null
  /** Desvio en minutos frente a esa salida (positivo = tarde). */
  delta: number | null
  /** Regla que lo detecto: salto del contador o desaparicion de la linea. */
  reason: 'jump' | 'gone'
}

export type MonitorPasses = Record<string, MonitorPass[]>

/** Cuantos pasos se conservan por control (unos dos meses de una franja diaria). */
export const MAX_PASSES_PER_MONITOR = 400

/** Seguimiento: sigue el avance de un bus por las paradas previas a la tuya. */
export interface FollowJob {
  id: string
  stopId: string
  stopName: string
  lineId: string
  directionKey: string
  createdAt: number
}

export interface LogEntry {
  id: string
  at: number
  level: 'info' | 'warn' | 'error'
  scope: string
  message: string
}

export interface AppState {
  ready: boolean
  bootPhase: string
  bootError: string | null

  network: Network | null
  schedule: ScheduleDataset | null
  scheduleError: string | null

  tab: TabId
  toast: { message: string, tone: 'info' | 'error' | 'success' } | null

  feeds: Record<string, StopFeed>
  refreshing: boolean
  refreshQueueLabel: string | null
  lastRefreshAt: number | null

  search: {
    mode: SearchMode
    query: string
    lineId: string
    directionKey: string
    selectedStopId: string | null
  }

  favourites: FavouriteStop[]
  expandedStopId: string | null

  tracking: TrackingJob | null
  monitors: MonitorJob[]
  monitorPasses: MonitorPasses
  monitorRuntime: Record<string, MonitorRuntime>
  monitorDayView: Record<string, ServiceDayType>
  /** Ultima vez que cada control miro su parada; alimenta el estado en pantalla. */
  monitorSeenAt: Record<string, number>
  follows: FollowJob[]

  sheet:
    | { kind: 'stop-actions', stopId: string }
    | { kind: 'pick-line', stopId: string, purpose: 'tracking' | 'monitor' | 'follow' }
    | { kind: 'rename', stopId: string }
    | null

  draft: {
    lineId: string
    directionKey: string
    startMinutes: number
    endMinutes: number
    alias: string
  }

  permissions: {
    notifications: PermissionState
    battery: PermissionState
  }

  logs: LogEntry[]
}

const KEYS = {
  favourites: 'salbus.favourites',
  tracking: 'salbus.tracking',
  monitors: 'salbus.monitors',
  monitorStats: 'salbus.monitorStats',
  monitorPasses: 'salbus.monitorPasses',
  monitorRuntime: 'salbus.monitorRuntime',
  follows: 'salbus.follows',
  logs: 'salbus.logs',
  tab: 'salbus.tab',
}

function normalizeTracking(job: TrackingJob | null): TrackingJob | null {
  if (!job || typeof job.id !== 'string') {
    return null
  }

  return { ...job, busesSeen: typeof job.busesSeen === 'number' ? job.busesSeen : 0 }
}

export const state: AppState = {
  ready: false,
  bootPhase: 'Iniciando…',
  bootError: null,

  network: null,
  schedule: null,
  scheduleError: null,

  tab: readTab(),
  toast: null,

  feeds: {},
  refreshing: false,
  refreshQueueLabel: null,
  lastRefreshAt: null,

  search: {
    mode: 'nombre',
    query: '',
    lineId: '',
    directionKey: '',
    selectedStopId: null,
  },

  favourites: readJson<FavouriteStop[]>(KEYS.favourites, []).filter(
    (item) => typeof item?.stopId === 'string',
  ),
  expandedStopId: null,

  // busesSeen no existia en versiones anteriores: un aviso guardado sin el empieza a contar de cero.
  tracking: normalizeTracking(readJson<TrackingJob | null>(KEYS.tracking, null)),
  monitors: readJson<MonitorJob[]>(KEYS.monitors, [])
    .filter((item) => typeof item?.id === 'string')
    .map((item) => ({ ...item, directionKey: item.directionKey ?? null })),
  monitorPasses: readPasses(),
  monitorRuntime: readJson<Record<string, MonitorRuntime>>(KEYS.monitorRuntime, {}),
  monitorDayView: {},
  monitorSeenAt: {},
  follows: readJson<FollowJob[]>(KEYS.follows, []).filter((item) => typeof item?.id === 'string'),

  sheet: null,

  draft: {
    lineId: '',
    directionKey: '',
    startMinutes: 7 * 60,
    endMinutes: 8 * 60,
    alias: '',
  },

  permissions: {
    notifications: 'unknown',
    battery: 'unknown',
  },

  logs: readJson<LogEntry[]>(KEYS.logs, []),
}

/* ------------------------------------------------------------------ *
 * Persistencia                                                         *
 * ------------------------------------------------------------------ */

export function persistFavourites(): void {
  writeJson(KEYS.favourites, state.favourites)
}

export function persistTracking(): void {
  writeJson(KEYS.tracking, state.tracking)
}

export function persistMonitors(): void {
  writeJson(KEYS.monitors, state.monitors)
}

export function persistMonitorPasses(): void {
  writeJson(KEYS.monitorPasses, state.monitorPasses)
}

export function persistMonitorRuntime(): void {
  writeJson(KEYS.monitorRuntime, state.monitorRuntime)
}

/**
 * Registra un paso observado. Un mismo dia y una misma salida programada solo
 * cuentan una vez: si se repite, gana la observacion mas reciente.
 */
export function addMonitorPass(monitorId: string, pass: MonitorPass): void {
  const previous = state.monitorPasses[monitorId] ?? []
  const filtered = previous.filter(
    (item) => !(item.date === pass.date && item.slot !== null && item.slot === pass.slot),
  )

  state.monitorPasses[monitorId] = [...filtered, pass]
    .sort((left, right) => left.at - right.at)
    .slice(-MAX_PASSES_PER_MONITOR)

  persistMonitorPasses()
}

export function localDateKey(at: number | Date): string {
  const date = at instanceof Date ? at : new Date(at)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`
}

/**
 * Lee los pasos guardados y, la primera vez, convierte el formato antiguo
 * (`salbus.monitorStats`: medias por hora programada) para no perder historico.
 */
function readPasses(): MonitorPasses {
  const stored = readJson<MonitorPasses>(KEYS.monitorPasses, {})
  if (Object.keys(stored).length > 0) {
    return stored
  }

  const legacy = readJson<Record<string, Record<string, Record<string, { slot: string, byDate: Record<string, number> }>>>>(
    KEYS.monitorStats,
    {},
  )

  const migrated: MonitorPasses = {}

  for (const [monitorId, byDayType] of Object.entries(legacy)) {
    for (const [dayType, bySlot] of Object.entries(byDayType ?? {})) {
      for (const sample of Object.values(bySlot ?? {})) {
        for (const [date, minutes] of Object.entries(sample?.byDate ?? {})) {
          const at = new Date(`${date}T00:00:00`).getTime() + minutes * 60_000
          const list = migrated[monitorId] ?? (migrated[monitorId] = [])
          list.push({
            at,
            date,
            dayType: dayType as ServiceDayType,
            minutes,
            slot: sample.slot,
            delta: minutes - parseClockToMinutes(sample.slot),
            reason: 'gone',
          })
        }
      }
    }
  }

  return migrated
}

export function persistFollows(): void {
  writeJson(KEYS.follows, state.follows)
}

export function persistTab(): void {
  try {
    window.localStorage.setItem(KEYS.tab, state.tab)
  } catch {
    /* almacenamiento no disponible */
  }
}

export function log(level: LogEntry['level'], scope: string, message: string): void {
  const previous = state.logs[0]
  // Evita inundar el registro con el mismo mensaje repetido.
  if (previous && previous.message === message && previous.scope === scope && Date.now() - previous.at < 30_000) {
    return
  }

  state.logs = [
    { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, at: Date.now(), level, scope, message },
    ...state.logs,
  ].slice(0, 200)

  writeJson(KEYS.logs, state.logs)
}

export function clearLogs(): void {
  state.logs = []
  writeJson(KEYS.logs, state.logs)
}

/* ------------------------------------------------------------------ *
 * Utilidades de estado                                                 *
 * ------------------------------------------------------------------ */

export function isFavourite(stopId: string): boolean {
  return state.favourites.some((item) => item.stopId === stopId)
}

export function favouriteLabel(stopId: string, fallback: string): string {
  const favourite = state.favourites.find((item) => item.stopId === stopId)
  return favourite?.alias?.trim() || fallback
}

export function minutesOfDay(reference = new Date()): number {
  return reference.getHours() * 60 + reference.getMinutes()
}

export function isWithinWindow(job: MonitorJob, reference = new Date()): boolean {
  const now = minutesOfDay(reference)
  return now >= job.startMinutes && now < job.endMinutes
}

export function formatMinutesClock(dayMinutes: number): string {
  const normalized = ((dayMinutes % 1440) + 1440) % 1440
  return `${String(Math.floor(normalized / 60)).padStart(2, '0')}:${String(normalized % 60).padStart(2, '0')}`
}

export function parseClockToMinutes(clock: string): number {
  const [hours = '0', minutes = '0'] = clock.split(':')
  return (Number.parseInt(hours, 10) || 0) * 60 + (Number.parseInt(minutes, 10) || 0)
}

/* ------------------------------------------------------------------ *
 * Puntualidad                                                          *
 * ------------------------------------------------------------------ */

/**
 * Salidas programadas de un control: las de su línea y sentido por esa parada,
 * acotadas a su franja horaria.
 *
 * Acotarlas es esencial: si se aceptaba cualquier salida del día, un paso de las
 * 08:02 en una franja de 07:00 a 08:00 se atribuía a la salida de las 08:05 y la
 * muestra desaparecía de la tabla, que solo enseña las salidas de la franja.
 */
export function monitorSlots(job: MonitorJob, dayType: ServiceDayType): string[] {
  const all = state.schedule?.getScheduledTimes(job.stopId, job.lineId, dayType, job.directionKey) ?? []

  return all.filter((clock) => {
    const minutes = parseClockToMinutes(clock)
    return minutes >= job.startMinutes && minutes < job.endMinutes
  })
}

export interface MonitorRow {
  slot: string
  /** Media de los pasos observados, en minutos del día. */
  average: number | null
  /** Desvío medio frente a la salida programada (positivo = tarde). */
  delta: number | null
  samples: number
  /** Último paso asociado a esta salida. */
  lastAt: number | null
}

export interface MonitorSummary {
  rows: MonitorRow[]
  /** Pasos observados sin ninguna salida programada cerca. */
  unmatched: MonitorPass[]
  /** Todos los pasos de ese tipo de día, del más reciente al más antiguo. */
  passes: MonitorPass[]
  days: number
}

/** Resume lo observado por un control para un tipo de día. */
export function summariseMonitor(job: MonitorJob, dayType: ServiceDayType): MonitorSummary {
  const passes = (state.monitorPasses[job.id] ?? []).filter((pass) => pass.dayType === dayType)
  const bySlot = new Map<string, MonitorPass[]>()

  for (const pass of passes) {
    if (!pass.slot) {
      continue
    }
    const list = bySlot.get(pass.slot)
    if (list) {
      list.push(pass)
    } else {
      bySlot.set(pass.slot, [pass])
    }
  }

  const rows = monitorSlots(job, dayType).map((slot) => {
    const items = bySlot.get(slot) ?? []
    const average = averageMinutes(items.map((item) => item.minutes))

    return {
      slot,
      average,
      delta: average === null ? null : average - parseClockToMinutes(slot),
      samples: items.length,
      lastAt: items.length > 0 ? Math.max(...items.map((item) => item.at)) : null,
    }
  })

  return {
    rows,
    unmatched: passes.filter((pass) => !pass.slot).slice(-12).reverse(),
    passes: [...passes].reverse(),
    days: new Set(passes.map((pass) => pass.date)).size,
  }
}

/* ------------------------------------------------------------------ *
 * localStorage helpers                                                 *
 * ------------------------------------------------------------------ */

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) {
      return fallback
    }
    const parsed = JSON.parse(raw) as T
    return parsed ?? fallback
  } catch {
    return fallback
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* cuota agotada o almacenamiento bloqueado */
  }
}

function readTab(): TabId {
  const valid: TabId[] = ['inicio', 'buscar', 'paradas', 'monitor', 'seguimiento', 'ajustes']
  try {
    const raw = window.localStorage.getItem(KEYS.tab) as TabId | null
    return raw && valid.includes(raw) ? raw : 'inicio'
  } catch {
    return 'inicio'
  }
}
