import type { Network } from './services/network'
import { averageMinutes } from './services/punctuality'
import type { MonitorRuntime } from './services/punctuality'
import type { ReleaseInfo } from './services/release-parser'
import type { GeoPoint, PlanOutcome } from './services/routing'
import type { ScheduleDataset, ServiceDayType, StopFeed } from './types'

/** Version con la que se COMPILO este bundle. Sale de package.json via Vite. */
export const APP_VERSION = `v${__APP_VERSION__}`

/** versionCode de esta compilacion, segun el bundle. */
export const APP_VERSION_CODE = __APP_VERSION_CODE__

export type TabId = 'inicio' | 'buscar' | 'monitor' | 'seguimiento' | 'mapas' | 'ajustes'
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
  /**
   * Un aviso creado puede estar en reposo: sigue existiendo y se puede reactivar
   * de un toque, pero no consulta la fuente ni publica notificacion.
   */
  active: boolean
  startedAt: number
  lastMinutes: number | null
  lastNotifiedAt: number
  /** Se arma cuando el bus se acerca; al desaparecer o alejarse se da por pasado. */
  armed: boolean
  missingStreak: number
  /** Autobuses ya vistos pasar; el aviso termina al llegar a TRACKING_BUS_TARGET. */
  busesSeen: number
  /**
   * El aviso corto (vibracion) de "quedan 3 minutos" ya se ha dado para el
   * autobus que se espera ahora. Se reinicia con cada autobus que pasa, de modo
   * que vibra una vez por autobus y no una vez por consulta.
   */
  warnedAt3: boolean
}

/**
 * Tope de autobuses que puede seguir un aviso. El numero real lo elige la
 * persona usuaria en Ajustes; este es solo el maximo que admite el selector.
 */
export const TRACKING_BUS_TARGET_MAX = 3

/** Autobuses que ve pasar un aviso antes de darse por terminado. */
export function trackingBusTarget(): number {
  return clampBusTarget(state.settings.trackingBusTarget)
}

export function clampBusTarget(value: number): number {
  if (!Number.isFinite(value)) {
    return 1
  }
  return Math.min(TRACKING_BUS_TARGET_MAX, Math.max(1, Math.round(value)))
}

/**
 * Minutos restantes a los que el aviso da un toque corto de vibracion.
 *
 * El servicio nativo (BusTrackingService) lleva su propia copia de este numero:
 * tiene que poder avisar con la app cerrada, cuando esta parte ni se ejecuta.
 */
export const TRACKING_WARN_MINUTES = 3

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
  /** Igual que en los avisos: creado pero en reposo mientras no este activo. */
  active: boolean
  createdAt: number
}

/* ------------------------------------------------------------------ *
 * Limites de las funciones de seguimiento                              *
 * ------------------------------------------------------------------ */

/** Avisos de "proximo bus" que se pueden tener creados a la vez. */
export const MAX_TRACKING_JOBS = 2

/** Seguimientos de "ver por donde viene" que se pueden tener creados a la vez. */
export const MAX_FOLLOW_JOBS = 2

/**
 * Funciones que pueden estar ACTIVAS a la vez, sumando las dos modalidades.
 * Cada una consulta la fuente oficial por su cuenta y esta limita por IP: por
 * encima de dos, todas empiezan a refrescarse tarde.
 */
export const MAX_ACTIVE_JOBS = 2

/**
 * Fase de refresco de una parada concreta. Las consultas van SIEMPRE en serie
 * (la fuente oficial limita por IP), asi que en una lista larga conviven
 * paradas ya actualizadas, una en curso y varias esperando turno.
 */
export type StopSyncPhase = 'queued' | 'loading'

export interface LogEntry {
  id: string
  at: number
  level: 'info' | 'warn' | 'error'
  scope: string
  message: string
}

/**
 * Fase del aviso de actualizacion. El boton principal absorbe el estado en su
 * propia etiqueta (Actualizar → Descargando… 45 % → Instalar → Reintentar) en
 * vez de ir anadiendo elementos al aviso.
 */
export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'installing'
  | 'error'

export interface UpdateState {
  phase: UpdatePhase
  release: ReleaseInfo | null
  /** -1 mientras no haya Content-Length: no se inventa un porcentaje. */
  percent: number
  /** Ruta local de la APK ya descargada; sobrevive a un permiso denegado. */
  downloadedPath: string | null
  /** El permiso de «instalar apps desconocidas» se concede fuera de la app. */
  canInstall: boolean
  error: string | null
  /** El aviso se puede posponer; vuelve en el siguiente arranque. */
  dismissed: boolean
  /** Resultado de la comprobacion MANUAL de Ajustes, que si cuenta lo que pasa. */
  manualMessage: { text: string, tone: 'info' | 'warn' | 'error' } | null
  manualChecking: boolean
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
  /** Paradas en cola o en curso dentro del ciclo de refresco actual. */
  stopSync: Record<string, StopSyncPhase>
  refreshing: boolean
  refreshQueueLabel: string | null
  lastRefreshAt: number | null

  search: {
    mode: SearchMode
    query: string
    lineId: string
    directionKey: string
    selectedStopId: string | null
    /** El mapa pasa a pantalla completa al elegir linea y sentido. */
    mapExpanded: boolean
  }

  favourites: FavouriteStop[]
  expandedStopId: string | null
  /** Paradas cuya lista de llegadas se ha desplegado mas alla de ARRIVALS_PREVIEW. */
  arrivalsExpanded: Record<string, boolean>

  trackings: TrackingJob[]
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
    /** Se ha alcanzado el limite de esa modalidad: hay que sustituir una. */
    | { kind: 'replace-job', stopId: string, purpose: 'tracking' | 'follow' }
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

  settings: AppSettings

  maps: MapsState

  tour: TourState

  /**
   * Version realmente instalada, la que dice el sistema.
   *
   * Arranca con la del bundle y se corrige nada mas abrir la app. No son
   * siempre lo mismo: si la WebView sirviera una copia vieja de la pagina, el
   * numero del bundle se quedaria congelado y la app se ofreceria a si misma la
   * actualizacion que acaba de instalar.
   */
  installed: { versionName: string, versionCode: number }

  update: UpdateState

  logs: LogEntry[]
}

/* ------------------------------------------------------------------ *
 * Pestana experimental "Mapas"                                         *
 * ------------------------------------------------------------------ */

/** Un extremo de la ruta: donde estoy, o una parada elegida a mano. */
export interface RoutePoint {
  kind: 'location' | 'stop'
  label: string
  lat: number
  lon: number
  /** Solo cuando el punto ES una parada de la red. */
  stopId?: string
}

export type MapsMode = 'cercanas' | 'rutas'

/**
 * Todo lo de la pestana experimental vive aqui dentro y NO se guarda en disco.
 *
 * Que sea efimero es deliberado: una ubicacion es del momento en que se pidio,
 * y arrancar la app con una posicion de ayer marcada en el mapa enganaria. Al
 * cerrar la pestana se vacia (resetMaps), asi que apagada no ocupa ni memoria.
 */
export interface MapsState {
  mode: MapsMode

  /** Ultima ubicacion conocida, con su margen de error en metros. */
  location: { point: GeoPoint, accuracy: number, at: number } | null
  locating: boolean
  /** Motivo por el que no hay ubicacion, ya redactado para leerse en pantalla. */
  locationError: string | null

  origin: RoutePoint | null
  destination: RoutePoint | null
  /** Campo que se esta rellenando; con null no hay buscador abierto. */
  picking: 'origin' | 'destination' | null
  query: string

  plan: PlanOutcome | null
  planning: boolean
  /** Tramo del itinerario resaltado en el mapa. */
  focusedLeg: number | null
}

export function emptyMapsState(): MapsState {
  return {
    mode: 'cercanas',
    location: null,
    locating: false,
    locationError: null,
    origin: null,
    destination: null,
    picking: null,
    query: '',
    plan: null,
    planning: false,
    focusedLeg: null,
  }
}

/* ------------------------------------------------------------------ *
 * Ajustes de la persona usuaria                                        *
 * ------------------------------------------------------------------ */

export interface AppSettings {
  /**
   * Vibracion corta cuando el aviso de proximo bus detecta que quedan 3 minutos.
   * Una sola vez por autobus.
   */
  vibrateOnApproach: boolean

  /**
   * Autobuses que sigue un aviso antes de terminar (1 a TRACKING_BUS_TARGET_MAX).
   *
   * Por defecto uno: quien pone un aviso casi siempre espera EL proximo autobus,
   * y encadenar tres dejaba la notificacion viva mucho despues de haberse
   * subido al primero.
   */
  trackingBusTarget: number

  /**
   * Pestana experimental "Mapas" (paradas cercanas y rutas).
   *
   * Apagada por defecto y apagada de verdad: con este ajuste en false la
   * pestana no existe, no se pide la ubicacion, no se crea ningun mapa y no se
   * calcula nada. Lo experimental no puede robarle recursos —ni turno en la
   * cola de consultas— a lo que ya funciona.
   */
  experimentalMaps: boolean
}

const DEFAULT_SETTINGS: AppSettings = {
  vibrateOnApproach: true,
  trackingBusTarget: 1,
  experimentalMaps: false,
}

/* ------------------------------------------------------------------ *
 * Tour de bienvenida                                                   *
 * ------------------------------------------------------------------ */

export interface TourState {
  open: boolean
  step: number
}

/** Llegadas que se ven de una parada antes de pulsar "Ver mas". */
export const ARRIVALS_PREVIEW = 5

const KEYS = {
  favourites: 'salbus.favourites',
  /** Formato antiguo: un unico aviso guardado como objeto suelto. */
  tracking: 'salbus.tracking',
  trackings: 'salbus.trackings',
  settings: 'salbus.settings',
  tourVersion: 'salbus.tourVersion',
  monitors: 'salbus.monitors',
  monitorStats: 'salbus.monitorStats',
  monitorPasses: 'salbus.monitorPasses',
  monitorRuntime: 'salbus.monitorRuntime',
  follows: 'salbus.follows',
  logs: 'salbus.logs',
  tab: 'salbus.tab',
}

/**
 * Avisos de proximo bus guardados.
 *
 * Hasta la v4.3 solo podia haber uno y se guardaba como objeto suelto en
 * `salbus.tracking`. Ese formato se migra a la lista actual para no perder el
 * aviso en curso al actualizar.
 */
function readTrackings(): TrackingJob[] {
  const stored = readJson<TrackingJob[]>(KEYS.trackings, [])
  const list = Array.isArray(stored) && stored.length > 0
    ? stored
    : [readJson<TrackingJob | null>(KEYS.tracking, null)].filter(
        (item): item is TrackingJob => item !== null,
      )

  return list
    .filter((job) => job && typeof job.id === 'string')
    .slice(0, MAX_TRACKING_JOBS)
    .map((job) => ({
      ...job,
      busesSeen: typeof job.busesSeen === 'number' ? job.busesSeen : 0,
      warnedAt3: job.warnedAt3 === true,
      // Un aviso guardado con el formato antiguo estaba activo por definicion.
      active: job.active !== false,
    }))
}

/** Un trabajo guardado sin `active` (formato antiguo) se considera activo. */
function normalizeFollow(job: FollowJob): FollowJob {
  return { ...job, active: job.active !== false }
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
  stopSync: {},
  refreshing: false,
  refreshQueueLabel: null,
  lastRefreshAt: null,

  search: {
    mode: 'nombre',
    query: '',
    lineId: '',
    directionKey: '',
    selectedStopId: null,
    mapExpanded: false,
  },

  favourites: readJson<FavouriteStop[]>(KEYS.favourites, []).filter(
    (item) => typeof item?.stopId === 'string',
  ),
  expandedStopId: null,
  arrivalsExpanded: {},

  // busesSeen no existia en versiones anteriores: un aviso guardado sin el empieza a contar de cero.
  trackings: readTrackings(),
  monitors: readJson<MonitorJob[]>(KEYS.monitors, [])
    .filter((item) => typeof item?.id === 'string')
    .map((item) => ({ ...item, directionKey: item.directionKey ?? null })),
  monitorPasses: readPasses(),
  monitorRuntime: readJson<Record<string, MonitorRuntime>>(KEYS.monitorRuntime, {}),
  monitorDayView: {},
  monitorSeenAt: {},
  follows: readJson<FollowJob[]>(KEYS.follows, [])
    .filter((item) => typeof item?.id === 'string')
    .map(normalizeFollow),

  sheet: null,

  draft: {
    lineId: '',
    directionKey: '',
    startMinutes: 7 * 60,
    endMinutes: 8 * 60,
    alias: '',
  },

  update: {
    phase: 'idle',
    release: null,
    percent: -1,
    downloadedPath: null,
    canInstall: false,
    error: null,
    dismissed: false,
    manualMessage: null,
    manualChecking: false,
  },

  permissions: {
    notifications: 'unknown',
    battery: 'unknown',
  },

  settings: readSettings(),

  maps: emptyMapsState(),

  // El tour se abre solo la primera vez que se arranca cada version nueva.
  tour: { open: readTourVersion() !== APP_VERSION, step: 0 },

  installed: { versionName: __APP_VERSION__, versionCode: APP_VERSION_CODE },

  logs: readJson<LogEntry[]>(KEYS.logs, []),
}

/* ------------------------------------------------------------------ *
 * Persistencia                                                         *
 * ------------------------------------------------------------------ */

export function persistFavourites(): void {
  writeJson(KEYS.favourites, state.favourites)
}

export function persistTrackings(): void {
  writeJson(KEYS.trackings, state.trackings)
  // El formato antiguo se retira: dejarlo escrito revivria avisos ya borrados.
  try {
    window.localStorage.removeItem(KEYS.tracking)
  } catch {
    /* almacenamiento no disponible */
  }
}

export function persistSettings(): void {
  writeJson(KEYS.settings, state.settings)
}

function readTourVersion(): string | null {
  try {
    return window.localStorage.getItem(KEYS.tourVersion)
  } catch {
    return null
  }
}

/** Marca el tour de ESTA version como visto; volvera con la siguiente. */
export function markTourSeen(): void {
  try {
    window.localStorage.setItem(KEYS.tourVersion, APP_VERSION)
  } catch {
    /* almacenamiento no disponible */
  }
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

/* ------------------------------------------------------------------ *
 * Funciones de seguimiento activas                                     *
 * ------------------------------------------------------------------ */

/** Una funcion de seguimiento, vista sin importar de que modalidad sea. */
export interface JobRef {
  kind: 'tracking' | 'follow'
  id: string
  active: boolean
  createdAt: number
}

/** Todas las funciones creadas, de la mas antigua a la mas reciente. */
export function allJobs(): JobRef[] {
  return [
    ...state.trackings.map((job) => ({
      kind: 'tracking' as const,
      id: job.id,
      active: job.active,
      createdAt: job.startedAt,
    })),
    ...state.follows.map((job) => ({
      kind: 'follow' as const,
      id: job.id,
      active: job.active,
      createdAt: job.createdAt,
    })),
  ].sort((left, right) => left.createdAt - right.createdAt)
}

export function activeJobCount(): number {
  return state.trackings.filter((job) => job.active).length
    + state.follows.filter((job) => job.active).length
}

/** Apaga una funcion concreta, sea de la modalidad que sea. */
export function deactivateJob(ref: JobRef): void {
  if (ref.kind === 'tracking') {
    const job = state.trackings.find((item) => item.id === ref.id)
    if (job) {
      job.active = false
    }
    return
  }

  const job = state.follows.find((item) => item.id === ref.id)
  if (job) {
    job.active = false
  }
}

/**
 * Deja como mucho MAX_ACTIVE_JOBS funciones activas, apagando siempre las mas
 * antiguas: al crear o activar una, la ultima en llegar es la que interesa.
 *
 * @param keepId Funcion que nunca se apaga (la que se acaba de crear o activar).
 * @returns Las funciones que se han apagado, para poder avisar de ello.
 */
export function enforceActiveLimit(keepId?: string): JobRef[] {
  const turnedOff: JobRef[] = []
  const active = allJobs().filter((job) => job.active && job.id !== keepId)

  // El excedente se cuenta sobre el total, incluida la funcion protegida.
  let excess = activeJobCount() - MAX_ACTIVE_JOBS

  for (const job of active) {
    if (excess <= 0) {
      break
    }
    deactivateJob(job)
    turnedOff.push(job)
    excess -= 1
  }

  return turnedOff
}

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
  // "mapas" NO esta en la lista: es experimental y puede estar apagada. Quien la
  // tuviera abierta al cerrar la app vuelve a Inicio, en vez de aterrizar en una
  // pestana que ya no existe.
  const valid: TabId[] = ['inicio', 'buscar', 'monitor', 'seguimiento', 'ajustes']
  try {
    // "paradas" existio hasta la v4.4 como pestaña propia; ahora vive dentro de
    // Inicio, asi que quien la tuviera guardada aterriza justo donde estaba.
    const raw = window.localStorage.getItem(KEYS.tab) as TabId | null
    return raw && valid.includes(raw) ? raw : 'inicio'
  } catch {
    return 'inicio'
  }
}

function readSettings(): AppSettings {
  const stored = readJson<Partial<AppSettings>>(KEYS.settings, {})
  const settings = { ...DEFAULT_SETTINGS, ...stored }
  // Guardado por una version anterior (o a mano): se acota antes de usarlo.
  settings.trackingBusTarget = clampBusTarget(settings.trackingBusTarget)
  return settings
}
