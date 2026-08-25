import { Capacitor, registerPlugin } from '@capacitor/core'
import * as L from 'leaflet'
import 'leaflet/dist/leaflet.css'

import './style.css'

import {
  DEFAULT_MAX_AGE_MS,
  fetchStopArrivals,
  fetchStopsSequentially,
  MIN_REQUEST_SPACING_MS,
} from './services/arrivals'
import { loadNetwork } from './services/network'
import { checkForUpdate, isNativeAndroid, readInstalledVersion, Updater } from './services/updates'
import { matchSlot, observe } from './services/punctuality'
import {
  DEFAULT_WAIT_MINUTES,
  isValidPoint,
  nearestStops,
  planRoute,
  type GeoPoint,
} from './services/routing'
import { currentDayType, loadSchedule } from './services/schedule'
import {
  cancelNotification,
  ensureNotificationPermission,
  isNative,
  notificationId,
  showArrivalAlert,
  showTrackingNotification,
} from './services/notifications'
import {
  addMonitorPass,
  APP_VERSION_CODE,
  clearLogs,
  enforceActiveLimit,
  formatMinutesClock,
  isFavourite,
  isWithinWindow,
  localDateKey,
  log,
  monitorSlots,
  parseClockToMinutes,
  persistFavourites,
  persistFollows,
  persistMonitorPasses,
  persistMonitorRuntime,
  persistMonitors,
  persistSettings,
  persistTab,
  persistTrackings,
  readInstallAttempt,
  writeInstallAttempt,
  emptyMapsState,
  state,
  clampBusTarget,
  trackingBusTarget,
  TRACKING_WARN_MINUTES,
  markTourSeen,
  MAX_ACTIVE_JOBS,
  MAX_FOLLOW_JOBS,
  MAX_TRACKING_JOBS,
  type MonitorJob,
  type RoutePoint,
  type TabId,
  type TrackingJob,
} from './state'
import type { StopFeed } from './types'
import { patch } from './dom'
import { esc, liveMinutes, readableTextColor } from './ui'
import { describeArrival, renderApp, stopName, TOUR_STEPS } from './views'

/* ------------------------------------------------------------------ *
 * Plugins nativos                                                      *
 * ------------------------------------------------------------------ */

interface BatteryOptimizationPlugin {
  isIgnoringBatteryOptimizations(): Promise<{ ignored: boolean }>
  requestIgnoreBatteryOptimizations(): Promise<void>
}

interface TrackingUpdate {
  /** `${stopId}|${lineId}`: identifica a cuál de los avisos vivos pertenece. */
  jobId: string
  stopId: string
  lineId: string
  minutes: number
  arriving: boolean
  status: 'ok' | 'empty' | 'throttled' | 'error'
  /** Autobuses ya contados por el servicio, que es quien manda mientras esta vivo. */
  busesSeen: number
  /** El aviso ha completado los tres autobuses y se esta cerrando. */
  finished: boolean
  at: number
}

interface BusPassedUpdate {
  jobId: string
  stopId: string
  lineId: string
  busesSeen: number
  target: number
  at: number
}

interface TrackingJobPayload {
  id: string
  stopId: string
  stopName: string
  lineId: string
  destination: string
  busesSeen: number
}

/** Un control de puntualidad tal y como lo entiende el servicio nativo. */
interface MonitorJobPayload {
  id: string
  stopId: string
  stopName: string
  lineId: string
  startMinutes: number
  endMinutes: number
}

/** Un paso detectado en segundo plano, todavía sin emparejar con el horario. */
interface NativePass {
  monitorId: string
  at: number
  reason: 'jump' | 'gone'
}

interface BusTrackingPlugin {
  /**
   * Sustituye lo que el servicio tiene vivo por estas listas. Las dos vacías
   * detienen el servicio.
   */
  sync(options: {
    jobs: TrackingJobPayload[]
    /** Controles de puntualidad: se miden dentro de su franja, con la app cerrada. */
    monitors: MonitorJobPayload[]
    intervalSeconds: number
    vibrateOnApproach: boolean
    /** Autobuses que hay que ver pasar antes de cerrar cada aviso (1 a 3). */
    busTarget: number
  }): Promise<void>
  stop(): Promise<void>
  /** `stopped`: avisos que se detuvieron desde su notificacion, quiza sin la app abierta. */
  status(): Promise<{ running: boolean, stopped: string[] }>
  clearStopped(): Promise<void>
  /** Entrega los pasos medidos en segundo plano Y los borra: solo se leen una vez. */
  takePasses(): Promise<{ passes: NativePass[] }>
  addListener(
    event: 'arrivalUpdate',
    handler: (update: TrackingUpdate) => void,
  ): Promise<{ remove: () => Promise<void> }>
  addListener(
    event: 'busPassed',
    handler: (update: BusPassedUpdate) => void,
  ): Promise<{ remove: () => Promise<void> }>
  addListener(
    event: 'jobStopped',
    handler: (update: { jobId: string }) => void,
  ): Promise<{ remove: () => Promise<void> }>
}

const BatteryOptimization = registerPlugin<BatteryOptimizationPlugin>('BatteryOptimization')
const BusTracking = registerPlugin<BusTrackingPlugin>('BusTracking')

/* ------------------------------------------------------------------ *
 * Constantes de refresco                                               *
 * ------------------------------------------------------------------ */

/** Cada cuanto se reevalua que hay que refrescar (no cuanto se pide a la web). */
const TICK_MS = 1_000

/** Frescura objetivo segun el uso que se le esta dando a la parada. */
const FRESHNESS = {
  /** Parada abierta en pantalla. */
  focused: 15_000,
  /** Resto de paradas guardadas visibles. */
  visible: 45_000,
  /** Paradas del recorrido en seguimiento. */
  follow: 40_000,
  /** Paradas con control de puntualidad dentro de su franja. */
  monitor: 30_000,
}

/** Cadencia minima entre lotes automaticos completos. */
const AUTO_CYCLE_MS = 20_000

/** Cuatro actualizaciones por minuto del aviso de proximo bus. */
const TRACKING_INTERVAL_SECONDS = 15

/**
 * Controles de puntualidad que el servicio nativo mide a la vez.
 *
 * Coincide con `MAX_MONITORS` de BusTrackingService: por encima de ese numero el
 * servicio se queda con los primeros, asi que conviene decirlo en el registro en
 * lugar de dejar controles callados que no miden nada.
 */
const MAX_BACKGROUND_MONITORS = 6

const root = document.querySelector<HTMLDivElement>('#app')
if (!root) {
  throw new Error('No se encontró el contenedor #app.')
}

const appRoot = root

let renderQueued = false
let lastAutoCycleAt = 0

/** Última vez que se recogieron los pasos medidos por el servicio nativo. */
let lastDrainAt = 0

/**
 * El servicio nativo esta al mando de los avisos.
 *
 * Mientras lo este, la parte web no publica sus propias notificaciones: serian
 * avisos duplicados, y los de la web se congelarian en cuanto la app pasara a
 * segundo plano. Tampoco cuenta autobuses aqui, para no contar dos veces.
 */
let trackingServiceActive = false

/**
 * Controles de puntualidad que mide el servicio nativo.
 *
 * De los que estan aqui NO se detectan pasos en la web: el servicio consulta
 * también con la app cerrada y ya lleva su propia deteccion, asi que hacerlo en
 * los dos sitios apuntaria el mismo autobus dos veces. Es un conjunto y no un
 * simple interruptor porque el servicio solo admite un numero de controles: los
 * que se queden fuera siguen midiendose aqui, con la app abierta.
 */
let nativeMonitorIds = new Set<string>()
let refreshInFlight = false
let toastTimer: number | null = null

/**
 * Elemento al que hay que desplazarse en el proximo repintado.
 *
 * El desplazamiento no puede hacerse en el manejador: el nodo destino todavia
 * no existe hasta que `patch` aplica el HTML nuevo.
 */
let scrollPending: string | null = null
let map: L.Map | null = null
let mapLayer: L.LayerGroup | null = null
let mapSignature = ''

/* ------------------------------------------------------------------ *
 * Arranque                                                             *
 * ------------------------------------------------------------------ */

void bootstrap()

async function bootstrap(): Promise<void> {
  const splashStartedAt = Date.now()

  render()

  try {
    state.bootPhase = 'Cargando la red de líneas…'
    render()
    state.network = await loadNetwork()
    log('info', 'red', `${state.network.lineCount} líneas y ${state.network.directionCount} sentidos cargados.`)

    // El horario programado solo alimenta la pantalla de puntualidad: si falla,
    // la app sigue siendo plenamente utilizable.
    state.bootPhase = 'Cargando el horario oficial…'
    render()
    try {
      state.schedule = await loadSchedule(state.network)
      if (state.schedule.stale) {
        log('warn', 'horario', `El GTFS incluido caducó el ${state.schedule.validTo ?? 'desconocido'}.`)
      }
    } catch (error) {
      state.scheduleError = 'No se pudo cargar el horario programado; la puntualidad no estará disponible.'
      log('warn', 'horario', errorMessage(error))
    }

    state.ready = true
    dropStaleFavourites()
  } catch (error) {
    state.bootError = `No se pudo iniciar la aplicación: ${errorMessage(error)}`
    log('error', 'arranque', errorMessage(error))
  }

  // La animación dura 1,5 s exactos; no se retira antes para que no parpadee.
  const elapsed = Date.now() - splashStartedAt
  window.setTimeout(() => dismissSplash(), Math.max(0, 1500 - elapsed))

  render()

  void setupPermissions()
  await restoreTrackingService()

  window.setInterval(tick, TICK_MS)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') {
      // "Ver por donde viene" consulta OCHO paradas por ciclo contra una fuente
      // que limita por IP. Con la app en segundo plano nadie mira ese recorrido,
      // asi que se para: lo que se ahorra ahi es lo que hace que el aviso de
      // proximo bus —que si tiene que seguir vivo— llegue a tiempo.
      pauseFollows('la app pasó a segundo plano')
      return
    }

    if (document.visibilityState === 'visible') {
      void refreshVisible('manual')
      // Mientras la app no estaba delante, quien medía era el servicio nativo.
      void drainNativePasses()
      void syncPermissions()
      // El permiso de instalacion se concede en una pantalla de ajustes DEL
      // SISTEMA, y nada dentro de la app avisa de que ha cambiado. Sin releerlo
      // aqui, el aviso seguiria pidiendolo para siempre despues de concederlo.
      void syncInstallPermission()
    }
  })

  void refreshVisible('auto')
  void setupUpdates()
}

/* ------------------------------------------------------------------ *
 * Actualizacion automatica                                             *
 * ------------------------------------------------------------------ */

async function setupUpdates(): Promise<void> {
  if (!isNativeAndroid()) {
    return
  }

  // Lo primero: qué versión hay instalada DE VERDAD. Todo lo demás (ofrecer o
  // no una actualización, y lo que se enseña en Ajustes) cuelga de este número.
  state.installed = await readInstalledVersion()
  if (state.installed.versionCode !== APP_VERSION_CODE) {
    log(
      'warn',
      'actualización',
      `El sistema dice que hay instalada la compilación ${state.installed.versionCode}, y este bundle es el de la ${APP_VERSION_CODE}.`,
    )
  }
  render()

  reviewInstallAttempt()

  await Updater.addListener('downloadProgress', (payload) => {
    state.update.percent = payload.percent
    render()
  })

  await syncInstallPermission()

  // Comprobacion del arranque: CALLA sus errores. Sin cobertura, o con GitHub
  // limitando por peticiones, la app tiene que seguir funcionando sin molestar.
  // El precio es que un fallo real se ve igual que «no hay novedades»; para eso
  // esta la comprobacion manual de Ajustes.
  const outcome = await checkForUpdate()

  if (outcome.status === 'update') {
    state.update.release = outcome.release
    // Una descarga anterior solo vale si es EXACTAMENTE la versión que se está
    // ofreciendo. Antes valía cualquiera: quien había descargado una release y
    // no la había instalado se encontraba con que «Instalar» le reinstalaba la
    // vieja, y al abrir la app volvía a ofrecerse la misma actualización.
    state.update.downloadedPath = await adoptPendingDownload(outcome.release.versionCode)
    state.update.phase = state.update.downloadedPath ? 'ready' : 'available'
    log(
      'info',
      'actualización',
      `Disponible la versión ${outcome.release.versionName} (compilación ${outcome.release.versionCode}).`,
    )
    render()
    return
  }

  // Sin novedades: cualquier APK guardada ya está instalada o se ha quedado
  // atrás, y son diez megas de caché que no van a usarse nunca.
  state.update.downloadedPath = await adoptPendingDownload(null)

  if (outcome.status === 'error') {
    log('warn', 'actualización', outcome.message)
  }
}

/**
 * Recupera la descarga guardada si sirve, y la tira si no.
 *
 * @param versionCode compilación que se está ofreciendo, o `null` si no hay
 *   ninguna: entonces no hay descarga que valga.
 */
async function adoptPendingDownload(versionCode: number | null): Promise<string | null> {
  try {
    const pending = await Updater.pendingUpdate()

    if (pending.ready && pending.path && versionCode !== null && pending.versionCode === versionCode) {
      return pending.path
    }

    if (pending.ready) {
      await Updater.clearPending()
      log(
        'info',
        'actualización',
        `Se descarta una descarga anterior (compilación ${pending.versionCode}) que ya no corresponde.`,
      )
    }
  } catch {
    /* sin descarga previa, o el plugin no está disponible */
  }

  return null
}

/**
 * ¿Se completó la instalación que se lanzó la última vez?
 *
 * Si no, se dice y se tira la descarga guardada para bajarla de nuevo. Callarlo
 * y limitarse a volver a ofrecer la misma versión es justo lo que convierte un
 * fallo puntual en un bucle: la ventana reaparece una y otra vez sin que nada
 * explique por qué sigues en la versión de siempre.
 */
function reviewInstallAttempt(): void {
  const attempted = readInstallAttempt()
  if (attempted <= 0) {
    return
  }

  // Se limpia siempre: este aviso es de un intento concreto y no debe repetirse
  // en cada arranque.
  writeInstallAttempt(0)

  if (state.installed.versionCode >= attempted) {
    log('info', 'actualización', `Instalada la compilación ${state.installed.versionCode}.`)
    return
  }

  state.update.error =
    `La instalación anterior no llegó a completarse: sigues en la compilación ${state.installed.versionCode}. `
    + 'Se descargará de nuevo desde cero.'

  log(
    'warn',
    'actualización',
    `Se mandó instalar la compilación ${attempted} y el sistema sigue con la ${state.installed.versionCode}.`,
  )

  // La APK guardada no vale: puede ser justo la que no se pudo instalar.
  void Updater.clearPending().catch(() => undefined)
  state.update.downloadedPath = null
}

async function syncInstallPermission(): Promise<void> {
  if (!isNativeAndroid()) {
    return
  }

  try {
    const { granted } = await Updater.canInstall()
    if (granted !== state.update.canInstall) {
      state.update.canInstall = granted
      render()
    }
  } catch {
    /* el plugin solo existe en Android */
  }
}

/** Descarga si hace falta e invoca al instalador del sistema. */
async function runUpdate(): Promise<void> {
  const update = state.update
  if (!update.release) {
    return
  }

  update.error = null

  try {
    if (!update.downloadedPath) {
      update.phase = 'downloading'
      update.percent = -1
      render()

      const result = await Updater.download({ url: update.release.apkUrl })
      update.downloadedPath = result.path
    }

    update.phase = 'ready'
    render()

    await syncInstallPermission()
    if (!state.update.canInstall) {
      // La APK ya esta en disco: al conceder el permiso se instala sin
      // volver a descargarla.
      render()
      return
    }

    update.phase = 'installing'
    render()
    // Queda anotado ANTES de lanzar el instalador: a partir de aquí la app puede
    // morir en cualquier momento, y al volver hay que poder distinguir "se
    // instaló" de "no llegó a instalarse".
    writeInstallAttempt(update.release.versionCode)
    await Updater.install({ path: update.downloadedPath })
  } catch (error) {
    const message = errorMessage(error)

    if (message.includes('PERMISSION_REQUIRED')) {
      update.phase = 'ready'
      state.update.canInstall = false
      render()
      return
    }

    update.phase = 'error'
    update.error = message
    // Una descarga rota no debe reutilizarse en el reintento.
    if (message.includes('descargar')) {
      update.downloadedPath = null
    }
    log('error', 'actualización', message)
    render()
  }
}

/** Comprobacion manual: esta SI cuenta lo que ocurre, sea lo que sea. */
async function checkUpdateManually(): Promise<void> {
  state.update.manualChecking = true
  state.update.manualMessage = null
  render()

  await syncInstallPermission()
  const outcome = await checkForUpdate()

  if (outcome.status === 'update') {
    state.update.release = outcome.release
    state.update.downloadedPath = await adoptPendingDownload(outcome.release.versionCode)
    state.update.phase = state.update.downloadedPath ? 'ready' : 'available'
    state.update.dismissed = false
    state.update.manualMessage = {
      text: `Disponible SALBUS v${outcome.release.versionName} (compilación ${outcome.release.versionCode}).`,
      tone: 'info',
    }
  } else if (outcome.status === 'current') {
    // La comprobación devuelve el versionCode REAL del sistema; si una
    // instalación se quedó a medias, aquí se ve el número de siempre.
    state.update.release = null
    state.update.phase = 'idle'
    state.update.downloadedPath = await adoptPendingDownload(null)
    state.update.manualMessage = {
      text: `Ya tienes la última versión (compilación ${outcome.versionCode}).`,
      tone: 'info',
    }
  } else if (outcome.status === 'unsupported') {
    state.update.manualMessage = {
      text: 'Las actualizaciones automáticas solo funcionan en la aplicación de Android.',
      tone: 'warn',
    }
  } else {
    state.update.manualMessage = { text: outcome.message, tone: 'error' }
  }

  state.update.manualChecking = false
  render()
}

function dismissSplash(): void {
  const splash = document.querySelector<HTMLElement>('#splash')
  if (!splash) {
    return
  }

  splash.classList.add('is-done')
  window.setTimeout(() => splash.remove(), 360)
}

function dropStaleFavourites(): void {
  const network = state.network
  if (!network) {
    return
  }

  const before = state.favourites.length
  state.favourites = state.favourites.filter((favourite) => network.stopById.has(favourite.stopId))
  state.follows = state.follows.filter((follow) => network.stopById.has(follow.stopId))
  state.monitors = state.monitors.filter((monitor) => network.stopById.has(monitor.stopId))
  state.trackings = state.trackings.filter((job) => network.stopById.has(job.stopId))

  if (state.favourites.length !== before) {
    persistFavourites()
    log('warn', 'paradas', 'Se eliminaron paradas guardadas que ya no existen en la red oficial.')
  }
}

/* ------------------------------------------------------------------ *
 * Permisos                                                             *
 * ------------------------------------------------------------------ */

async function setupPermissions(): Promise<void> {
  state.permissions.notifications = await ensureNotificationPermission()
  await syncBatteryPermission(false)
  render()
}

async function syncPermissions(): Promise<void> {
  await syncBatteryPermission(false)
  render()
}

async function syncBatteryPermission(prompt: boolean): Promise<void> {
  if (Capacitor.getPlatform() !== 'android') {
    state.permissions.battery = 'granted'
    return
  }

  try {
    let result = await BatteryOptimization.isIgnoringBatteryOptimizations()

    if (!result.ignored && prompt) {
      await BatteryOptimization.requestIgnoreBatteryOptimizations()
      await wait(600)
      result = await BatteryOptimization.isIgnoringBatteryOptimizations()
    }

    state.permissions.battery = result.ignored ? 'granted' : 'denied'
  } catch {
    state.permissions.battery = 'unknown'
  }
}

/* ------------------------------------------------------------------ *
 * Motor de refresco                                                    *
 * ------------------------------------------------------------------ */

/** Paradas que interesan ahora mismo, con su frescura objetivo, mas prioritarias primero. */
function buildRefreshPlan(): Array<{ stopId: string, maxAgeMs: number, priority: 'high' | 'normal' }> {
  const plan = new Map<string, { stopId: string, maxAgeMs: number, priority: 'high' | 'normal' }>()

  const add = (stopId: string, maxAgeMs: number, priority: 'high' | 'normal' = 'normal') => {
    const existing = plan.get(stopId)
    if (!existing || maxAgeMs < existing.maxAgeMs) {
      plan.set(stopId, { stopId, maxAgeMs, priority })
    }
  }

  // 1. Los avisos activos mandan: siempre son lo primero.
  for (const job of state.trackings) {
    if (job.active) {
      add(job.stopId, FRESHNESS.focused, 'high')
    }
  }

  // 2. Controles de puntualidad dentro de su franja horaria. Con un autobús ya
  // entrando se aprieta el ritmo: es el momento en que se decide si ha pasado.
  for (const monitor of state.monitors) {
    if (isWithinWindow(monitor)) {
      const armed = state.monitorRuntime[monitor.id]?.armed === true
      add(monitor.stopId, armed ? FRESHNESS.focused : FRESHNESS.monitor, 'high')
    }
  }

  // 3. Lo que se esta mirando en pantalla.
  if (state.tab === 'buscar' && state.search.selectedStopId) {
    add(state.search.selectedStopId, FRESHNESS.focused, 'high')
  }

  // Inicio ES la lista de paradas guardadas, pero SOLO se consulta la que está
  // desplegada: es la única que enseña tiempos (plegada solo se ven sus líneas),
  // y pedir las diez guardadas para no mirar ninguna dejaba sin turno en la cola
  // al aviso de próximo bus, que sí tiene que llegar a tiempo.
  if (state.tab === 'inicio' && state.expandedStopId) {
    add(state.expandedStopId, FRESHNESS.focused, 'high')
  }

  // 4. Recorridos en seguimiento: la parada propia primero, luego hacia atras.
  // Solo los activos: uno en reposo no gasta consultas de una fuente limitada.
  for (const follow of state.follows) {
    if (follow.active) {
      const window = state.network?.getDirectionWindow(follow.directionKey, follow.stopId, 8) ?? []
      // Se recorre al reves para pedir antes las paradas mas cercanas al usuario.
      for (const stop of [...window].reverse()) {
        add(stop.stopId, FRESHNESS.follow)
      }
    }
  }

  return Array.from(plan.values()).sort((left, right) => {
    if (left.priority !== right.priority) {
      return left.priority === 'high' ? -1 : 1
    }
    return left.maxAgeMs - right.maxAgeMs
  })
}

function tick(): void {
  // Reloj y antigüedades se repintan siempre: el repintado es incremental
  // (`patch`), así que no cierra desplegables ni interrumpe lo que se esté
  // haciendo, ni siquiera con una hoja abierta.
  if (state.ready) {
    render()
  }

  // Con un control de puntualidad dentro de su franja se sigue consultando
  // aunque la pantalla no esté en primer plano: perder esas consultas es perder
  // justo el paso que se quería medir.
  const measuring = state.monitors.some((monitor) => isWithinWindow(monitor))

  // Con el servicio nativo midiendo, los pasos aparecen en la pantalla de
  // puntualidad al ritmo al que él los detecta, no solo al reabrir la app.
  if (measuring && nativeMonitorIds.size > 0 && Date.now() - lastDrainAt >= AUTO_CYCLE_MS) {
    lastDrainAt = Date.now()
    void drainNativePasses()
  }

  if (refreshInFlight || (document.visibilityState !== 'visible' && !measuring)) {
    return
  }

  if (Date.now() - lastAutoCycleAt < AUTO_CYCLE_MS) {
    return
  }

  void refreshVisible('auto')
}

async function refreshVisible(source: 'auto' | 'manual'): Promise<void> {
  if (refreshInFlight || !state.ready) {
    return
  }

  const plan = buildRefreshPlan().filter((entry) => {
    const feed = state.feeds[entry.stopId]
    return !feed || Date.now() - feed.fetchedAt >= (source === 'manual' ? 0 : entry.maxAgeMs)
  })

  if (plan.length === 0) {
    if (source === 'manual') {
      showToast('Los datos ya están al día', 'info')
    }
    return
  }

  refreshInFlight = true
  lastAutoCycleAt = Date.now()
  state.refreshing = true

  // Todas entran en cola a la vez; se iran marcando "en curso" segun les toque.
  // Es lo que permite distinguir en pantalla lo actualizado de lo que espera.
  for (const entry of plan) {
    state.stopSync[entry.stopId] = 'queued'
  }

  if (plan.length > 1) {
    const seconds = Math.round(((plan.length - 1) * MIN_REQUEST_SPACING_MS) / 1000)
    state.refreshQueueLabel = `Actualizando ${plan.length} paradas · ~${seconds} s`
  }

  render()

  try {
    let done = 0

    await fetchStopsSequentially(
      plan.map((entry) => entry.stopId),
      {
        maxAgeMs: source === 'manual' ? 0 : DEFAULT_MAX_AGE_MS,
        priority: plan[0]?.priority,
        onStart: (stopId) => {
          state.stopSync[stopId] = 'loading'
          render()
        },
        onFeed: (feed) => {
          done += 1
          delete state.stopSync[feed.stopId]
          applyFeed(feed)
          state.refreshQueueLabel =
            plan.length > 1 && done < plan.length ? `Actualizando ${done + 1} de ${plan.length}…` : null
          render()
        },
      },
    )

    state.lastRefreshAt = Date.now()
  } catch (error) {
    log('error', 'llegadas', errorMessage(error))
  } finally {
    refreshInFlight = false
    state.refreshing = false
    state.refreshQueueLabel = null
    // Un error a mitad de lote dejaria paradas colgadas en "en cola" para
    // siempre. Solo se limpian las de este lote: una consulta suelta en curso
    // (refreshOneStop) lleva su propia marca y la gestiona ella.
    for (const entry of plan) {
      delete state.stopSync[entry.stopId]
    }
    render()
  }
}

/** Refresca una sola parada de inmediato (botón de la tarjeta). */
async function refreshOneStop(stopId: string): Promise<void> {
  state.refreshing = true
  state.stopSync[stopId] = 'loading'
  render()

  try {
    const feed = await fetchStopArrivals(stopId, { maxAgeMs: 0, priority: 'high' })
    applyFeed(feed)
    state.lastRefreshAt = Date.now()

    if (feed.status === 'throttled') {
      showToast('La fuente oficial está limitando las consultas; se muestra el último dato', 'error')
    }
  } finally {
    state.refreshing = false
    delete state.stopSync[stopId]
    render()
  }
}

function applyFeed(feed: StopFeed): void {
  state.feeds[feed.stopId] = feed

  if (feed.status === 'error' && feed.message) {
    log('error', `parada ${feed.stopId}`, feed.message)
  }

  if (feed.status === 'throttled') {
    log('warn', 'fuente', 'La web oficial devolvió 429; se amplía el espaciado entre consultas.')
  }

  evaluateTracking(feed)
  evaluateMonitors(feed)
}

/* ------------------------------------------------------------------ *
 * Avisos de próximo bus                                                *
 * ------------------------------------------------------------------ */

/** Los avisos que consultan y publican notificación ahora mismo. */
function activeTrackings(): TrackingJob[] {
  return state.trackings.filter((job) => job.active)
}

function trackingById(id: string): TrackingJob | undefined {
  return state.trackings.find((job) => job.id === id)
}

/**
 * Pone el servicio nativo exactamente al día: avisos activos y controles de
 * puntualidad.
 *
 * Se mandan SIEMPRE las listas completas, nunca altas y bajas sueltas: es lo que
 * garantiza que la barra de notificaciones enseñe justo lo que hay en pantalla,
 * ni un aviso de más ni uno de menos.
 *
 * Los controles van aquí porque medir a qué hora pasa de verdad un autobús
 * exige consultar durante toda la franja, y con la app en segundo plano el
 * navegador se congela: se perdía justo el paso que se quería medir.
 */
async function syncTrackingService(): Promise<void> {
  const jobs = activeTrackings()
  const monitors = state.monitors.slice(0, MAX_BACKGROUND_MONITORS)

  if (state.monitors.length > monitors.length) {
    log(
      'warn',
      'puntualidad',
      `Solo los ${MAX_BACKGROUND_MONITORS} primeros controles se miden en segundo plano; los demás necesitan la app abierta.`,
    )
  }

  if (!isNative()) {
    trackingServiceActive = false
    nativeMonitorIds = new Set()
    return
  }

  try {
    await BusTracking.sync({
      jobs: jobs.map((job) => ({
        id: job.id,
        stopId: job.stopId,
        stopName: job.stopName,
        lineId: job.lineId,
        destination: describeArrival(job.stopId, job.lineId),
        busesSeen: job.busesSeen,
      })),
      monitors: monitors.map((monitor) => ({
        id: monitor.id,
        stopId: monitor.stopId,
        stopName: monitor.stopName,
        lineId: monitor.lineId,
        startMinutes: monitor.startMinutes,
        endMinutes: monitor.endMinutes,
      })),
      intervalSeconds: TRACKING_INTERVAL_SECONDS,
      vibrateOnApproach: state.settings.vibrateOnApproach,
      busTarget: trackingBusTarget(),
    })

    trackingServiceActive = jobs.length > 0
    nativeMonitorIds = new Set(monitors.map((monitor) => monitor.id))

    // El servicio publica sus propias notificaciones: cualquier resto de la web
    // sobra, porque ya no se volvería a actualizar.
    for (const job of state.trackings) {
      await cancelNotification(notificationId(job.id))
    }
  } catch (error) {
    trackingServiceActive = false
    nativeMonitorIds = new Set()
    log('warn', 'aviso', `No se pudo sincronizar el servicio en segundo plano: ${errorMessage(error)}`)
    if (jobs.length > 0) {
      showToast('El aviso funcionará solo con la app abierta', 'error')
    } else if (monitors.length > 0) {
      showToast('La puntualidad se medirá solo con la app abierta', 'error')
    }
  }
}

/**
 * Recoge los pasos que el servicio midió mientras la app no estaba delante.
 *
 * Llegan en bruto (control e instante): el emparejado con el horario oficial se
 * hace aquí, que es donde vive el GTFS. El servicio los borra al entregarlos,
 * así que esta función nunca puede contar dos veces el mismo autobús.
 */
async function drainNativePasses(): Promise<void> {
  if (!isNative()) {
    return
  }

  try {
    const { passes } = await BusTracking.takePasses()

    if (passes.length === 0) {
      return
    }

    for (const pass of passes) {
      const monitor = state.monitors.find((item) => item.id === pass.monitorId)
      if (monitor) {
        recordPass(monitor, pass.at, pass.reason === 'jump' ? 'jump' : 'gone')
      }
    }

    log('info', 'puntualidad', `${passes.length} paso(s) medidos en segundo plano.`)
  } catch (error) {
    log('warn', 'puntualidad', `No se pudieron recoger las medidas: ${errorMessage(error)}`)
  }
}

/** Crea un aviso nuevo. Los límites ya se han comprobado antes de llegar aquí. */
async function createTracking(stopId: string, lineId: string): Promise<void> {
  const id = `${stopId}|${lineId}`

  if (trackingById(id)) {
    showToast('Ya tienes ese aviso creado', 'error')
    return
  }

  const job: TrackingJob = {
    id,
    stopId,
    stopName: stopName(stopId),
    lineId,
    active: true,
    startedAt: Date.now(),
    lastMinutes: null,
    lastNotifiedAt: 0,
    armed: false,
    missingStreak: 0,
    busesSeen: 0,
    warnedAt3: false,
  }

  state.trackings = [...state.trackings, job]

  // La recién creada es la que interesa: si con ella se pasa del límite de
  // funciones activas, se apaga la más antigua.
  const turnedOff = enforceActiveLimit(id)
  persistTrackings()
  persistFollows()

  log(
    'info',
    'aviso',
    `Aviso creado: línea ${lineId} en ${job.stopName} (${trackingBusTarget()} autobús/es).`,
  )

  if (turnedOff.length > 0) {
    showToast(`Se ha pausado otra función para no pasar de ${MAX_ACTIVE_JOBS} activas`, 'info')
  }

  await syncTrackingService()
  await refreshOneStop(stopId)
}

/** Quita un aviso por completo (ya no existe ni en reposo). */
async function removeTracking(id: string, notify = true): Promise<void> {
  const job = trackingById(id)
  if (!job) {
    return
  }

  state.trackings = state.trackings.filter((item) => item.id !== id)
  persistTrackings()

  await cancelNotification(notificationId(id))
  await syncTrackingService()

  log('info', 'aviso', `Aviso retirado: línea ${job.lineId} en ${job.stopName}.`)

  if (notify) {
    showToast('Aviso detenido', 'info')
  }

  render()
}

/**
 * Enciende o apaga una función sin borrarla.
 *
 * Al encender se respeta el tope de funciones activas apagando la más antigua:
 * es preferible a rechazar la acción, porque lo que se acaba de tocar es
 * siempre lo que se quiere mirar ahora.
 */
async function toggleJobActive(kind: 'tracking' | 'follow', id: string): Promise<void> {
  const job = kind === 'tracking'
    ? trackingById(id)
    : state.follows.find((item) => item.id === id)

  if (!job) {
    return
  }

  job.active = !job.active
  const turnedOff = job.active ? enforceActiveLimit(id) : []

  persistTrackings()
  persistFollows()

  if (!job.active && kind === 'tracking') {
    await cancelNotification(notificationId(id))
  }

  await syncTrackingService()

  if (turnedOff.length > 0) {
    showToast(`Se ha pausado otra función para no pasar de ${MAX_ACTIVE_JOBS} activas`, 'info')
  } else {
    showToast(job.active ? 'Función activada' : 'Función en pausa', 'info')
  }

  render()
  void refreshVisible('auto')
}

/**
 * Reconecta la interfaz con el servicio nativo tras reabrir la app, para que la
 * pantalla y las notificaciones no cuenten historias distintas.
 */
async function restoreTrackingService(): Promise<void> {
  if (!isNative()) {
    return
  }

  try {
    await BusTracking.addListener('arrivalUpdate', (update) => {
      // El servicio sigue consultando en segundo plano; sus datos se integran en
      // la misma cache que usa la interfaz.
      const existing = state.feeds[update.stopId]
      const arrival = {
        stopId: update.stopId,
        lineId: update.lineId,
        minutesUntil: Math.max(0, update.minutes),
        status: update.arriving ? ('arriving' as const) : ('scheduled' as const),
        estimatedClock: new Date(update.at + update.minutes * 60_000).toLocaleTimeString('es-ES', {
          hour: '2-digit',
          minute: '2-digit',
        }),
        observedAt: update.at,
      }

      state.feeds[update.stopId] = {
        stopId: update.stopId,
        stopName: existing?.stopName ?? null,
        status: update.status,
        arrivals: [arrival, ...(existing?.arrivals ?? []).filter((item) => item.lineId !== update.lineId)],
        fetchedAt: update.at,
        message: null,
      }

      // El servicio es quien cuenta los autobuses mientras vive: la web se limita
      // a copiar su cuenta para que la pantalla diga lo mismo que la notificación.
      const job = trackingById(update.jobId)
      if (job) {
        job.busesSeen = update.busesSeen
        persistTrackings()
      }

      if (update.finished) {
        void finishTracking(update.jobId, true)
        return
      }

      render()
    })

    await BusTracking.addListener('busPassed', (update) => {
      const job = trackingById(update.jobId)
      if (!job) {
        return
      }

      job.busesSeen = update.busesSeen
      job.armed = false
      job.lastMinutes = null
      job.missingStreak = 0
      job.warnedAt3 = false
      persistTrackings()

      log(
        'info',
        'aviso',
        `Autobús ${update.busesSeen} de ${update.target} de la línea ${update.lineId} ha pasado por ${stopName(update.stopId)}.`,
      )
      showToast(`Autobús ${update.busesSeen} de ${update.target} ya ha pasado`, 'info')
      render()
    })

    // "Detener" desde la notificación, posiblemente con la app cerrada.
    await BusTracking.addListener('jobStopped', (update) => {
      void removeTracking(update.jobId, false)
    })

    const status = await BusTracking.status()

    // Un aviso que se detuvo desde su notificación NO se revive: antes se
    // reabría solo al entrar en la app, y la notificación que acababa de
    // quitarse volvía a aparecer.
    if (status.stopped.length > 0) {
      const removed = state.trackings.filter((job) => status.stopped.includes(job.id))
      if (removed.length > 0) {
        state.trackings = state.trackings.filter((job) => !status.stopped.includes(job.id))
        persistTrackings()
        log('info', 'aviso', `${removed.length} aviso(s) detenidos desde la notificación.`)
      }
      await BusTracking.clearStopped()
    }

    // Los avisos que ya vieron sus tres autobuses con la app cerrada se cierran
    // en lugar de revivirse.
    for (const job of activeTrackings()) {
      if (job.busesSeen >= trackingBusTarget()) {
        await finishTracking(job.id, true)
      }
    }

    await syncTrackingService()

    // Lo medido con la app cerrada se incorpora antes de pintar nada: es lo que
    // hace que la pantalla de puntualidad ya esté completa al abrirla.
    await drainNativePasses()
  } catch (error) {
    trackingServiceActive = false
    nativeMonitorIds = new Set()
    log('warn', 'aviso', `Servicio en segundo plano no disponible: ${errorMessage(error)}`)
  }
}

function evaluateTracking(feed: StopFeed): void {
  for (const job of activeTrackings()) {
    if (job.stopId === feed.stopId) {
      evaluateTrackingJob(job, feed)
    }
  }
}

function evaluateTrackingJob(job: TrackingJob, feed: StopFeed): void {
  const arrival = feed.arrivals
    .filter((item) => item.lineId === job.lineId)
    .sort((left, right) => liveMinutes(left) - liveMinutes(right))[0]

  // Mientras el servicio nativo vive, es él quien cuenta los pasos: contar también
  // aquí duplicaría autobuses y terminaría el aviso antes de tiempo.
  const countsPasses = !trackingServiceActive

  if (!arrival) {
    // Un fallo de red no dice nada del autobús; solo una respuesta buena sin la
    // línea cuenta como ausencia.
    if (feed.status !== 'ok' && feed.status !== 'empty') {
      return
    }

    job.missingStreak += 1

    // Dos ciclos sin ver la línea después de haberla tenido encima: ha pasado.
    if (countsPasses && job.armed && job.missingStreak >= 2) {
      void registerBusPassed(job)
    }

    return
  }

  const minutes = liveMinutes(arrival)
  job.missingStreak = 0

  if (minutes <= 3) {
    job.armed = true
  }

  // Se alejó tras haber estado encima: el bus ya pasó.
  if (countsPasses && job.armed && job.lastMinutes !== null && job.lastMinutes <= 2 && minutes >= 6) {
    void registerBusPassed(job)
    return
  }

  // Vibración de los 3 minutos. Con el servicio nativo vivo la da él, que
  // también funciona con la app en segundo plano; esto es el respaldo para
  // cuando no lo hay (navegador, o servicio no disponible).
  if (!job.warnedAt3 && minutes <= TRACKING_WARN_MINUTES) {
    job.warnedAt3 = true
    if (!trackingServiceActive) {
      vibrateShort()
    }
  }

  job.lastMinutes = minutes
  job.lastNotifiedAt = Date.now()
  persistTrackings()

  // Con el servicio nativo vivo, la notificación es suya y solo suya: publicar
  // otra desde aquí dejaría un segundo aviso que se congela al irse a segundo
  // plano. Esto es solo el respaldo para cuando el servicio no está disponible.
  if (isNative() && !trackingServiceActive && !document.hidden) {
    void showTrackingNotification({
      id: notificationId(job.id),
      lineId: job.lineId,
      destination: describeArrival(job.stopId, job.lineId),
      minutes,
      arriving: arrival.status === 'arriving' || minutes <= 0,
      updatedAt: new Date(feed.fetchedAt),
      stale: feed.status === 'throttled',
    })
  }
}

/**
 * Vibración corta de "quedan 3 minutos".
 *
 * Una sola por autobús: el indicador `warnedAt3` se reinicia cuando el autobús
 * pasa, no en cada consulta, que serían cuatro zumbidos por minuto.
 */
function vibrateShort(): void {
  if (!state.settings.vibrateOnApproach) {
    return
  }

  try {
    navigator.vibrate?.(220)
  } catch {
    /* el navegador o el sistema pueden tenerlo bloqueado */
  }
}

/**
 * Un autobús más ha pasado. El aviso solo termina cuando se han visto pasar
 * trackingBusTarget(); hasta entonces se rearma y sigue con el siguiente.
 */
async function registerBusPassed(job: TrackingJob): Promise<void> {
  job.busesSeen += 1
  job.armed = false
  job.lastMinutes = null
  job.missingStreak = 0
  job.warnedAt3 = false
  persistTrackings()

  if (job.busesSeen >= trackingBusTarget()) {
    await finishTracking(job.id)
    return
  }

  // Mismo id en todos los avisos intermedios: se sustituyen en vez de apilarse.
  await showArrivalAlert(notificationId(`${job.id}|done`), job.lineId, job.stopName, {
    seen: job.busesSeen,
    target: trackingBusTarget(),
  })
  log(
    'info',
    'aviso',
    `Autobús ${job.busesSeen} de ${trackingBusTarget()} de la línea ${job.lineId} ha pasado por ${job.stopName}.`,
  )
  showToast(`Autobús ${job.busesSeen} de ${trackingBusTarget()} ya ha pasado`, 'info')
  render()
}

/**
 * Cierra un aviso: ya han pasado todos los autobuses que se esperaban.
 *
 * `alreadyNotified` lo ponen los cierres que vienen del servicio nativo, que ya
 * ha publicado él su aviso de "completado". Sin eso salían DOS notificaciones
 * iguales cada vez que pasaba el autobús: la del servicio y la de aquí.
 */
async function finishTracking(id: string, alreadyNotified = false): Promise<void> {
  const job = trackingById(id)
  if (!job) {
    return
  }

  const target = trackingBusTarget()

  if (!alreadyNotified) {
    await showArrivalAlert(notificationId(`${job.id}|done`), job.lineId, job.stopName, {
      seen: target,
      target,
    })
  }

  const cuantos = target > 1 ? `${target} autobuses` : 'el autobús'

  log('info', 'aviso', `Aviso completado: ha pasado ${cuantos} de la línea ${job.lineId} por ${job.stopName}.`)
  await removeTracking(id, false)
  showToast(`Ya ha pasado ${cuantos} de la línea ${job.lineId}`, 'success')
  render()
}

/* ------------------------------------------------------------------ *
 * Puntualidad                                                          *
 * ------------------------------------------------------------------ */

function evaluateMonitors(feed: StopFeed): void {
  const at = feed.fetchedAt || Date.now()
  const now = new Date(at)
  let touched = false

  for (const monitor of state.monitors) {
    if (monitor.stopId !== feed.stopId) {
      continue
    }

    if (!isWithinWindow(monitor, now)) {
      // Fuera de la franja se olvida el estado: un autobús que quedó "entrando"
      // ayer no puede contarse como un paso de hoy.
      if (state.monitorRuntime[monitor.id]) {
        delete state.monitorRuntime[monitor.id]
        touched = true
      }
      continue
    }

    // Un 429 o un error de red no dicen nada de la parada. Tratarlos como
    // "el autobús ya no aparece" inventaría pasos que nunca ocurrieron.
    if (feed.status !== 'ok' && feed.status !== 'empty') {
      continue
    }

    state.monitorSeenAt[monitor.id] = at

    // Con el servicio nativo al mando, la detección es suya: repetirla aquí
    // apuntaría dos veces el mismo autobús mientras la app estuviera abierta.
    // Su estado de detección tampoco se puede reflejar aquí, así que se descarta
    // el de la web para no dejar colgado un "autobús entrando" que ya no avanza.
    if (nativeMonitorIds.has(monitor.id)) {
      if (state.monitorRuntime[monitor.id]) {
        delete state.monitorRuntime[monitor.id]
        touched = true
      }
      continue
    }

    const arrival = feed.arrivals
      .filter((item) => item.lineId === monitor.lineId)
      .sort((left, right) => liveMinutes(left) - liveMinutes(right))[0]

    const detection = observe(state.monitorRuntime[monitor.id], {
      minutes: arrival ? liveMinutes(arrival) : null,
      at,
    })

    state.monitorRuntime[monitor.id] = detection.runtime
    touched = true

    if (detection.passAt !== null && detection.reason) {
      recordPass(monitor, detection.passAt, detection.reason)
    }
  }

  if (touched) {
    persistMonitorRuntime()
  }
}

/**
 * Guarda un paso observado y lo asocia a la salida programada más cercana de la
 * franja del control (±15 min). Si no hay ninguna se guarda igualmente sin hora
 * programada: antes se descartaba, y con ello se perdía justo la información que
 * delata que el horario oficial ya no se cumple.
 */
function recordPass(monitor: MonitorJob, passAt: number, reason: 'jump' | 'gone'): void {
  const at = new Date(passAt)
  const dayType = currentDayType(at)
  const observedMinutes = at.getHours() * 60 + at.getMinutes()
  const match = matchSlot(observedMinutes, monitorSlots(monitor, dayType))
  const deltaText = match.delta === null || match.delta === 0
    ? 'en hora'
    : `${match.delta > 0 ? '+' : ''}${match.delta} min`

  addMonitorPass(monitor.id, {
    at: passAt,
    date: localDateKey(at),
    dayType,
    minutes: observedMinutes,
    slot: match.slot,
    delta: match.delta,
    reason,
  })

  log(
    'info',
    'puntualidad',
    match.slot
      ? `Línea ${monitor.lineId} pasó por ${monitor.stopName} a las ${formatMinutesClock(
          observedMinutes,
        )} (programado ${match.slot}, ${deltaText}).`
      : `Línea ${monitor.lineId} pasó por ${monitor.stopName} a las ${formatMinutesClock(
          observedMinutes,
        )}; el horario oficial no recoge ninguna salida cercana.`,
  )

  render()
}

/* ------------------------------------------------------------------ *
 * Render + eventos                                                     *
 * ------------------------------------------------------------------ */

function render(): void {
  if (renderQueued) {
    return
  }

  renderQueued = true
  requestAnimationFrame(() => {
    renderQueued = false
    paint()
  })
}

// Solo en el servidor de desarrollo: permite a tools/uicheck.mjs colocar la
// interfaz en estados que de otro modo exigirian un dispositivo (aviso de
// actualizacion, descarga en curso). Vite lo elimina de la compilacion de
// produccion, asi que no viaja en la APK.
if (import.meta.env.DEV) {
  ;(window as unknown as { __salbus?: unknown }).__salbus = { state, render }
}

function paint(): void {
  // Repintado incremental: solo se tocan los nodos que han cambiado. Antes se
  // reescribía todo el HTML cada segundo, y eso cerraba cualquier desplegable
  // abierto (el elemento sobre el que el sistema lo había desplegado dejaba de
  // existir), además de perder foco, cursor y desplazamiento.
  patch(appRoot, renderApp())
  syncMap()
  // Solo hace algo cuando la pestaña experimental está abierta; en cualquier
  // otra pantalla se limita a soltar el mapa si quedaba alguno.
  syncMapsMap()
  applyPendingScroll()
}

/**
 * Lleva la vista hasta la franja recien abierta (la ficha de la parada tras
 * pulsar "Ver tiempos"). Se hace despues de pintar, que es cuando el nodo
 * destino existe ya en el documento.
 */
function applyPendingScroll(): void {
  if (!scrollPending) {
    return
  }

  const target = document.getElementById(scrollPending)
  scrollPending = null

  if (!target) {
    return
  }

  // Un fotograma de margen: con el mapa saliendo de pantalla completa, la
  // posicion final del documento aun no esta asentada.
  requestAnimationFrame(() => {
    target.scrollIntoView({ behavior: 'smooth', block: 'start' })
  })
}

appRoot.addEventListener('click', (event) => {
  const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-action]')
  if (!target) {
    return
  }

  void handleAction(target.dataset.action ?? '', target)
})

appRoot.addEventListener('input', (event) => {
  const target = event.target as HTMLInputElement | null
  if (!target) {
    return
  }

  if (target.id === 'stop-query') {
    state.search.query = target.value
    render()
  }

  // Buscador de la pestaña experimental: estado aparte del buscador de siempre,
  // para que escribir en uno no mueva el otro.
  if (target.id === 'maps-query') {
    state.maps.query = target.value
    render()
  }

  if (target.id === 'alias-input') {
    state.draft.alias = target.value
  }

  if (target.dataset.action === 'draft-start') {
    state.draft.startMinutes = parseClockToMinutes(target.value)
  }

  if (target.dataset.action === 'draft-end') {
    state.draft.endMinutes = parseClockToMinutes(target.value)
  }
})

appRoot.addEventListener('change', (event) => {
  const target = event.target as HTMLSelectElement | null
  if (!target?.dataset.action) {
    return
  }

  const action = target.dataset.action

  if (action === 'pick-search-line') {
    state.search.lineId = target.value
    // El sentido NO se rellena solo: mientras siga en "Seleccionar" no hay
    // recorrido elegido, y el mapa no tiene por que ocupar la pantalla entera.
    state.search.directionKey = ''
    state.search.mapExpanded = false
    render()
  }

  if (action === 'pick-search-direction') {
    state.search.directionKey = target.value
    // Solo con linea Y sentido elegidos a mano: el recorrido es entonces lo
    // unico que interesa mirar, asi que el mapa pasa a pantalla completa.
    if (state.search.mode === 'mapa' && state.search.lineId && state.search.directionKey) {
      state.search.mapExpanded = true
    } else {
      state.search.mapExpanded = false
    }
    render()
  }

  if (action === 'pick-bus-target') {
    state.settings.trackingBusTarget = clampBusTarget(Number(target.value))
    persistSettings()
    // El servicio nativo cuenta los pasos por su cuenta: necesita el numero.
    void syncTrackingService()
    render()
  }

  if (action === 'draft-line') {
    state.draft.lineId = target.value
    const stopId = target.dataset.stop ?? ''
    state.draft.directionKey =
      state.network?.getDirectionsThroughStop(stopId, target.value)[0]?.key ?? ''
    render()
  }

  if (action === 'draft-direction') {
    state.draft.directionKey = target.value
  }

  if (action === 'monitor-day') {
    const monitorId = target.dataset.monitor ?? ''
    state.monitorDayView[monitorId] = target.value as 'weekday' | 'saturday' | 'sunday'
    render()
  }
})

async function handleAction(action: string, element: HTMLElement): Promise<void> {
  const stopId = element.dataset.stop ?? ''

  switch (action) {
    case 'tab': {
      const tab = element.dataset.tab as TabId | undefined
      if (tab) {
        await goToTab(tab)
      }
      return
    }

    case 'refresh':
      await refreshVisible('manual')
      return

    case 'refresh-stop':
      await refreshOneStop(stopId)
      return

    case 'run-update':
      await runUpdate()
      return

    case 'check-update':
      await checkUpdateManually()
      return

    case 'dismiss-update':
      // Solo hasta el proximo arranque: no se guarda en disco a proposito.
      state.update.dismissed = true
      render()
      return

    case 'open-install-settings':
      try {
        await Updater.openInstallSettings()
      } catch (error) {
        showToast(errorMessage(error), 'error')
      }
      return

    case 'retry-boot':
      window.location.reload()
      return

    case 'search-mode': {
      const mode = element.dataset.mode as 'nombre' | 'linea' | 'mapa' | undefined
      if (mode) {
        state.search.mode = mode
        // Linea y sentido se quedan en "Seleccionar" hasta que se elijan a mano.
        if (mode !== 'mapa' || !state.search.lineId || !state.search.directionKey) {
          state.search.mapExpanded = false
        }
        render()
      }
      return
    }

    case 'expand-map':
      if (!state.search.lineId || !state.search.directionKey) {
        showToast('Elige primero línea y sentido', 'info')
        return
      }
      state.search.mapExpanded = true
      render()
      return

    case 'collapse-map':
      state.search.mapExpanded = false
      render()
      return

    // Desde el globo del mapa. El mapa se queda como esta: la ficha se abre
    // por encima, asi que no hay que salir de la pantalla completa para verla.
    case 'map-select-stop':
    case 'select-stop':
      state.search.selectedStopId = stopId
      render()
      await refreshOneStop(stopId)
      return

    case 'close-stop':
      state.search.selectedStopId = null
      render()
      return

    case 'expand-stop':
      state.expandedStopId = state.expandedStopId === stopId ? null : stopId
      render()
      if (state.expandedStopId) {
        void refreshOneStop(stopId)
      }
      return

    case 'toggle-favourite':
      if (isFavourite(stopId)) {
        state.favourites = state.favourites.filter((item) => item.stopId !== stopId)
        showToast('Parada quitada de tus favoritas', 'info')
      } else {
        state.favourites = [...state.favourites, { stopId, alias: null, addedAt: Date.now() }]
        showToast('Parada guardada', 'success')
      }
      persistFavourites()
      render()
      return

    case 'remove-favourite':
      state.favourites = state.favourites.filter((item) => item.stopId !== stopId)
      persistFavourites()
      showToast('Parada quitada', 'info')
      render()
      return

    case 'rename-stop':
      state.draft.alias = state.favourites.find((item) => item.stopId === stopId)?.alias ?? ''
      state.sheet = { kind: 'rename', stopId }
      render()
      return

    case 'confirm-rename': {
      const favourite = state.favourites.find((item) => item.stopId === stopId)
      if (favourite) {
        const alias = state.draft.alias.trim()
        favourite.alias = alias.length > 0 ? alias : null
        persistFavourites()
      }
      state.sheet = null
      render()
      return
    }

    case 'stop-actions':
      state.sheet = { kind: 'stop-actions', stopId }
      render()
      return

    case 'pick-line': {
      const purpose = element.dataset.purpose as 'tracking' | 'monitor' | 'follow' | undefined
      if (!purpose) {
        return
      }

      // Cada modalidad tiene su tope de funciones creadas. Al alcanzarlo no se
      // bloquea la accion: se pregunta cual de las existentes se sustituye.
      const atLimit = purpose === 'tracking'
        ? state.trackings.length >= MAX_TRACKING_JOBS
        : purpose === 'follow' && state.follows.length >= MAX_FOLLOW_JOBS

      if (atLimit && purpose !== 'monitor') {
        state.sheet = { kind: 'replace-job', stopId, purpose }
        render()
        return
      }

      openPickLine(stopId, purpose)
      return
    }

    case 'confirm-sheet': {
      const purpose = element.dataset.purpose as 'tracking' | 'monitor' | 'follow' | undefined
      await confirmSheet(stopId, purpose)
      return
    }

    case 'close-sheet':
      state.sheet = null
      render()
      return

    case 'stop-tracking':
      await removeTracking(element.dataset.tracking ?? '')
      return

    // Enciende o apaga una funcion sin borrarla.
    case 'toggle-job':
      await toggleJobActive(
        element.dataset.kind === 'follow' ? 'follow' : 'tracking',
        element.dataset.job ?? '',
      )
      return

    case 'remove-follow':
      state.follows = state.follows.filter((item) => item.id !== element.dataset.follow)
      persistFollows()
      showToast('Seguimiento quitado', 'info')
      render()
      return

    // Se ha alcanzado el limite de la modalidad: esta es la que se sustituye.
    case 'replace-job': {
      const purpose = element.dataset.purpose === 'follow' ? 'follow' : 'tracking'
      const jobId = element.dataset.job ?? ''

      if (purpose === 'tracking') {
        await removeTracking(jobId, false)
      } else {
        state.follows = state.follows.filter((item) => item.id !== jobId)
        persistFollows()
      }

      openPickLine(stopId, purpose)
      return
    }

    // Lista de llegadas: las que pasan de ARRIVALS_PREVIEW se piden a mano.
    case 'expand-arrivals':
      state.arrivalsExpanded[stopId] = true
      render()
      return

    case 'collapse-arrivals':
      delete state.arrivalsExpanded[stopId]
      render()
      return

    case 'toggle-maps': {
      const enabled = !state.settings.experimentalMaps
      state.settings.experimentalMaps = enabled
      persistSettings()

      // Al apagarla se suelta todo lo suyo en el acto: mapa, ubicación y ruta.
      // Si no, un `watchPosition` seguiría vivo con la pestaña ya invisible.
      if (!enabled) {
        closeMaps()
        if (state.tab === 'mapas') {
          state.tab = 'inicio'
          persistTab()
        }
      }

      showToast(enabled ? 'Pestaña Mapas activada' : 'Pestaña Mapas desactivada', 'info')
      render()
      return
    }

    case 'maps-mode': {
      const mode = element.dataset.mode as 'cercanas' | 'rutas' | undefined
      if (mode) {
        state.maps.mode = mode
        state.maps.picking = null
        mapsSignature = ''
        render()
      }
      return
    }

    case 'maps-locate':
      locateMe()
      return

    case 'maps-open-stop':
      // Se reutiliza la ficha de siempre. Es la ÚNICA consulta que hace esta
      // pestaña, y solo cuando alguien toca una parada a propósito.
      state.search.selectedStopId = stopId
      render()
      await refreshOneStop(stopId)
      return

    case 'maps-pick': {
      const field = element.dataset.field as 'origin' | 'destination' | undefined
      if (field) {
        state.maps.picking = field
        state.maps.query = ''
        render()
      }
      return
    }

    case 'maps-pick-cancel':
      state.maps.picking = null
      render()
      return

    case 'maps-pick-here': {
      const point = currentLocationPoint()
      if (!point) {
        // Aún no se sabe dónde está: se pide, se deja el buscador abierto para
        // poder elegir una parada mientras tanto, y se anota el campo para
        // rellenarlo solo en cuanto llegue la posición.
        pendingLocationField = state.maps.picking
        showToast('Buscando tu ubicación…', 'info')
        locateMe()
        return
      }

      applyRoutePoint(point)
      return
    }

    case 'maps-pick-stop': {
      const stop = state.network?.stopById.get(stopId)
      if (stop) {
        applyRoutePoint({
          kind: 'stop',
          label: stop.stopName,
          lat: stop.lat,
          lon: stop.lon,
          stopId: stop.stopId,
        })
      }
      return
    }

    case 'maps-swap': {
      const { origin, destination } = state.maps
      state.maps.origin = destination
      state.maps.destination = origin
      state.maps.plan = null
      mapsSignature = ''
      render()
      return
    }

    case 'maps-plan':
      planMapsRoute()
      return

    case 'maps-focus-leg': {
      const leg = Number.parseInt(element.dataset.leg ?? '', 10)
      state.maps.focusedLeg = Number.isFinite(leg) && state.maps.focusedLeg !== leg ? leg : null
      mapsSignature = ''
      render()
      return
    }

    case 'toggle-vibration':
      state.settings.vibrateOnApproach = !state.settings.vibrateOnApproach
      persistSettings()
      // El servicio nativo lleva su propia copia del ajuste.
      await syncTrackingService()
      showToast(
        state.settings.vibrateOnApproach ? 'Vibración activada' : 'Vibración desactivada',
        'info',
      )
      render()
      return

    case 'tour-next':
      if (state.tour.step >= TOUR_STEPS - 1) {
        closeTour()
        return
      }
      state.tour.step += 1
      render()
      return

    case 'tour-back':
      state.tour.step = Math.max(0, state.tour.step - 1)
      render()
      return

    case 'tour-close':
      closeTour()
      return

    case 'tour-open':
      state.tour = { open: true, step: 0 }
      render()
      return

    case 'remove-monitor': {
      const monitorId = element.dataset.monitor ?? ''
      state.monitors = state.monitors.filter((item) => item.id !== monitorId)
      delete state.monitorPasses[monitorId]
      delete state.monitorRuntime[monitorId]
      delete state.monitorSeenAt[monitorId]
      persistMonitors()
      persistMonitorPasses()
      persistMonitorRuntime()
      // El servicio deja de medirlo en el acto: si no, seguiría despertando el
      // móvil por una franja que ya no le importa a nadie.
      await syncTrackingService()
      render()
      return
    }

    case 'request-notifications':
      state.permissions.notifications = await ensureNotificationPermission()
      render()
      return

    case 'request-battery':
      await syncBatteryPermission(true)
      render()
      return

    case 'clear-logs':
      clearLogs()
      render()
      return

    default:
      return
  }
}

/**
 * Cambio de pestaña.
 *
 * Es el unico punto por el que se cambia de pantalla, y por eso es donde viven
 * las dos limpiezas que dependen de ello: los recorridos se paran al salir de
 * "Seguir", y el buscador vuelve a "Seleccionar" al entrar en "Buscar".
 */
async function goToTab(tab: TabId): Promise<void> {
  const previous = state.tab

  if (previous === 'seguimiento' && tab !== 'seguimiento') {
    pauseFollows('se salió de la pestaña Seguir')
  }

  // Al salir de Mapas se suelta TODO lo suyo: el seguimiento de la ubicación, el
  // mapa y lo calculado. Una función experimental no puede quedarse trabajando
  // por detrás mientras miras otra pantalla.
  if (previous === 'mapas' && tab !== 'mapas') {
    closeMaps()
  }

  if (tab === 'buscar' && previous !== 'buscar') {
    // Los desplegables arrancan siempre sin elegir: al volver al buscador, una
    // linea y un sentido heredados de la visita anterior se leian como una
    // busqueda en curso que nadie habia pedido.
    state.search.lineId = ''
    state.search.directionKey = ''
    state.search.mapExpanded = false
    state.search.selectedStopId = null
  }

  state.tab = tab
  state.sheet = null
  persistTab()
  render()
  void refreshVisible('auto')
}

/**
 * Para todos los recorridos activos.
 *
 * No se reactivan solos al volver: un recorrido consumiendo consultas sin que
 * nadie lo mire es justo lo que se quiere evitar, y volver a encenderlo es un
 * toque. La tarjeta lo dice donde se ve.
 */
function pauseFollows(reason: string): void {
  const running = state.follows.filter((follow) => follow.active)
  if (running.length === 0) {
    return
  }

  for (const follow of running) {
    follow.active = false
  }

  persistFollows()
  log('info', 'seguimiento', `${running.length} recorrido(s) en pausa: ${reason}.`)
  render()
}

/** Abre la hoja de eleccion de linea con el borrador ya preparado. */
function openPickLine(stopId: string, purpose: 'tracking' | 'monitor' | 'follow'): void {
  const lines = state.network?.getLinesForStop(stopId) ?? []
  state.draft.lineId = lines[0]?.lineId ?? ''
  state.draft.directionKey =
    state.network?.getDirectionsThroughStop(stopId, state.draft.lineId)[0]?.key ?? ''
  state.sheet = { kind: 'pick-line', stopId, purpose }
  render()
}

/**
 * Cierra el tour y lo da por visto para ESTA version. Volvera a aparecer solo
 * cuando la app se actualice, que es cuando hay algo nuevo que contar.
 */
function closeTour(): void {
  state.tour = { open: false, step: 0 }
  markTourSeen()
  render()
}

async function confirmSheet(
  stopId: string,
  purpose: 'tracking' | 'monitor' | 'follow' | undefined,
): Promise<void> {
  const lineId = state.draft.lineId
  if (!purpose || !lineId) {
    showToast('Elige una línea', 'error')
    return
  }

  if (purpose === 'tracking') {
    state.sheet = null
    render()
    await createTracking(stopId, lineId)
    state.tab = 'seguimiento'
    persistTab()
    showToast('Te avisaremos cuando se acerque', 'success')
    render()
    return
  }

  if (purpose === 'follow') {
    const directionKey =
      state.draft.directionKey || state.network?.getDirectionsThroughStop(stopId, lineId)[0]?.key || ''

    if (!directionKey) {
      showToast('No hay recorrido disponible para esa línea', 'error')
      return
    }

    const id = `${stopId}|${lineId}|${directionKey}`
    if (!state.follows.some((item) => item.id === id)) {
      state.follows = [
        ...state.follows,
        {
          id,
          stopId,
          stopName: stopName(stopId),
          lineId,
          directionKey,
          active: true,
          createdAt: Date.now(),
        },
      ]

      // El recien creado es el que interesa: si con el se pasa del tope de
      // funciones activas, se apaga la mas antigua.
      const turnedOff = enforceActiveLimit(id)
      persistFollows()
      persistTrackings()

      if (turnedOff.length > 0) {
        await syncTrackingService()
        showToast(`Se ha pausado otra función para no pasar de ${MAX_ACTIVE_JOBS} activas`, 'info')
      }
    }

    state.sheet = null
    state.tab = 'seguimiento'
    persistTab()
    render()
    void refreshVisible('auto')
    return
  }

  // Puntualidad
  const { startMinutes, endMinutes } = state.draft
  const directionKey = state.draft.directionKey || null
  const duration = endMinutes - startMinutes

  if (duration < 15) {
    showToast('La franja debe durar al menos 15 minutos', 'error')
    return
  }

  if (duration > 120) {
    showToast('La franja no puede superar las 2 horas', 'error')
    return
  }

  const id = `${stopId}|${lineId}|${directionKey ?? 'todos'}|${startMinutes}|${endMinutes}`
  if (state.monitors.some((item) => item.id === id)) {
    showToast('Ese control ya existe', 'error')
    return
  }

  state.monitors = [
    ...state.monitors,
    {
      id,
      stopId,
      stopName: stopName(stopId),
      lineId,
      directionKey,
      startMinutes,
      endMinutes,
      createdAt: Date.now(),
    },
  ]
  persistMonitors()

  // El servicio nativo es quien mide dentro de la franja, también con la app
  // cerrada: se entera del control nuevo ahora, no en el próximo arranque.
  await syncTrackingService()

  state.sheet = null
  state.tab = 'monitor'
  persistTab()
  showToast('Control de puntualidad creado', 'success')
  render()
}

/* ------------------------------------------------------------------ *
 * Mapa                                                                 *
 * ------------------------------------------------------------------ */

function syncMap(): void {
  const container = document.querySelector<HTMLDivElement>('#stop-map')

  if (!container || !state.network) {
    if (map) {
      map.remove()
      map = null
      mapLayer = null
      mapSignature = ''
    }
    return
  }

  if (!map || map.getContainer() !== container) {
    map?.remove()
    map = L.map(container, { zoomControl: false, attributionControl: true })
    L.control.zoom({ position: 'bottomleft' }).addTo(map)
    // Con el mapa ampliado las chinchetas se amontonarian: se encogen al alejar.
    map.on('zoomend', () => applyZoomScale())
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap',
    }).addTo(map)
    mapLayer = L.layerGroup().addTo(map)
    mapSignature = ''
  }

  const direction = state.network.directionByKey.get(state.search.directionKey)
  const stops = direction?.stops ?? []
  // La pantalla completa entra en la firma: al cambiar de tamano hay que
  // reencuadrar el recorrido, no solo recalcular el lienzo.
  const signature = `${state.search.directionKey}|${state.search.selectedStopId ?? ''}|${
    state.search.mapExpanded ? 'full' : 'inline'
  }`

  if (signature === mapSignature) {
    map.invalidateSize()
    return
  }

  mapSignature = signature
  mapLayer?.clearLayers()

  // Al pasar a pantalla completa el contenedor cambia de tamano, pero Leaflet
  // sigue con el anterior en cache. Sin esto el encuadre sale calculado sobre
  // la franja pequena y el recorrido queda diminuto en el centro.
  map.invalidateSize()

  const color = state.network.getLineColor(direction?.key.split('|')[0] ?? '')
  const points: Array<[number, number]> = []

  stops.forEach((stop, index) => {
    if (!Number.isFinite(stop.lat) || !Number.isFinite(stop.lon)) {
      return
    }

    points.push([stop.lat, stop.lon])
    const selected = state.search.selectedStopId === stop.stopId

    // Marcador con icono propio en lugar de un circulo de 6 px: en un movil hay
    // que poder verlo y acertarle con el dedo sin ampliar el mapa.
    const marker = L.marker([stop.lat, stop.lon], {
      icon: buildStopIcon(stop.stopId, index + 1, color, selected),
      keyboard: false,
      zIndexOffset: selected ? 1000 : 0,
    })

    marker.bindPopup(buildStopPopup(stop), {
      className: 'map-popup',
      closeButton: true,
      maxWidth: 260,
      minWidth: 200,
      autoPanPadding: [16, 16],
    })

    if (mapLayer) {
      marker.addTo(mapLayer)
    }
  })

  // El trazado une las paradas en el orden real del trayecto.
  if (points.length > 1 && mapLayer) {
    L.polyline(points, { color, weight: 5, opacity: 0.7 }).addTo(mapLayer)
  }

  if (points.length > 0) {
    map.fitBounds(points, { padding: [34, 34], maxZoom: 16 })
  } else {
    map.setView([40.9701, -5.6635], 13)
  }

  applyZoomScale()

  // Segunda pasada: la transicion de tamano del contenedor puede no haber
  // terminado cuando se pinta, y el encuadre quedaria corrido.
  window.setTimeout(() => {
    if (!map) {
      return
    }
    map.invalidateSize()
    if (points.length > 0) {
      map.fitBounds(points, { padding: [34, 34], maxZoom: 16 })
    }
    applyZoomScale()
  }, 80)
}

/**
 * Una linea entera cabe en pantalla solo muy alejado, y ahi 30 chinchetas se
 * solapan hasta ser ilegibles. Alejado se dibujan como puntos; al acercarse
 * recuperan tamano y numero de orden.
 */
function applyZoomScale(): void {
  if (!map) {
    return
  }

  const zoom = map.getZoom()
  const container = map.getContainer()
  container.classList.toggle('is-far', zoom < 14)
  container.classList.toggle('is-mid', zoom >= 14 && zoom < 15.5)
}

/** Chincheta de parada: circulo grande con el numero de orden en el recorrido. */
function buildStopIcon(stopId: string, order: number, color: string, selected: boolean): L.DivIcon {
  const size = selected ? 42 : 34

  return L.divIcon({
    className: '',
    html: `<span class="map-pin${selected ? ' is-selected' : ''}" style="--pin:${esc(
      color,
    )};--pin-text:${esc(readableTextColor(color))}" data-stop="${esc(stopId)}">${order}</span>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -size / 2],
  })
}

/**
 * Ficha reducida de la parada dentro del globo: nombre, codigo y lineas que
 * pasan por ella. Los tiempos no van aqui: pedirlos abriria una consulta por
 * cada parada que se toque, y la fuente oficial limita por IP.
 */
function buildStopPopup(stop: { stopId: string, stopName: string }): string {
  const lines = state.network?.getLinesForStop(stop.stopId) ?? []

  return `
    <div class="map-popup-body">
      <strong class="map-popup-name">${esc(stop.stopName)}</strong>
      <span class="map-popup-code">Parada ${esc(stop.stopId)}</span>
      <span class="map-popup-lines">
        ${
          lines.length === 0
            ? '<em>Sin líneas registradas</em>'
            : lines
                .map(
                  (line) =>
                    `<span class="line-chip is-sm" style="background:${esc(
                      line.color,
                    )};color:${esc(readableTextColor(line.color))}">${esc(line.lineId)}</span>`,
                )
                .join('')
        }
      </span>
      <button class="btn btn-primary btn-sm" type="button" data-action="map-select-stop" data-stop="${esc(
        stop.stopId,
      )}">Ver tiempos</button>
    </div>
  `
}

/* ------------------------------------------------------------------ *
 * Mapas (pestaña experimental)                                         *
 * ------------------------------------------------------------------ */

/** Guarda el extremo recién elegido y cierra el buscador. */
function applyRoutePoint(point: RoutePoint): void {
  const field = state.maps.picking
  if (!field) {
    return
  }

  state.maps[field] = point
  state.maps.picking = null
  state.maps.query = ''
  // El itinerario anterior ya no vale: era de otro trayecto.
  state.maps.plan = null
  state.maps.focusedLeg = null
  mapsSignature = ''
  render()
}

/**
 * Todo lo de la pestaña experimental vive en este bloque y en `routing.ts`.
 *
 * Reglas que se respetan aquí sin excepción, para que lo experimental no pueda
 * estropear lo que ya funciona:
 *
 *  - Mapa, marcadores y seguimiento de la ubicación se crean al entrar y se
 *    destruyen al salir (`closeMaps`). Fuera de la pestaña no queda nada vivo.
 *  - No se pide un solo tiempo de llegada. La fuente oficial limita por IP y su
 *    cola es para el aviso de próximo bus.
 *  - Usa su propia instancia de Leaflet, distinta de la del buscador: compartirla
 *    obligaría a que las dos pantallas se pusieran de acuerdo sobre el encuadre.
 */

let mapsMap: L.Map | null = null
let mapsLayer: L.LayerGroup | null = null
let mapsSignature = ''

/** Id del `watchPosition` en curso, o null si no se está siguiendo nada. */
let locationWatchId: number | null = null

/** Suelta el mapa, el seguimiento de ubicación y lo calculado. */
function closeMaps(): void {
  stopWatchingLocation()
  pendingLocationField = null

  // La ficha de parada se comparte con el buscador y se dibuja fuera de la
  // pantalla actual: dejarla abierta al salir la haría aparecer en la pestaña
  // siguiente, que no es donde se abrió.
  state.search.selectedStopId = null

  if (mapsMap) {
    mapsMap.remove()
    mapsMap = null
    mapsLayer = null
    mapsSignature = ''
  }

  state.maps = emptyMapsState()
}

function stopWatchingLocation(): void {
  if (locationWatchId !== null) {
    try {
      navigator.geolocation?.clearWatch(locationWatchId)
    } catch {
      /* el navegador puede no tenerlo */
    }
    locationWatchId = null
  }
}

/**
 * Extremo de la ruta que está esperando a que llegue la ubicación.
 *
 * Quien toca "Mi ubicación" antes de que el sistema sepa dónde está no puede
 * quedarse mirando: se anota qué campo quería rellenar y se rellena solo en
 * cuanto hay posición. Antes había que volver a tocar el botón, sin que nada
 * dijera cuándo.
 */
let pendingLocationField: 'origin' | 'destination' | null = null

/**
 * Pide la ubicación.
 *
 * En Android es Capacitor quien saca el diálogo del permiso en cuanto la página
 * llama a `geolocation`; por eso no hace falta plugin propio, solo declarar los
 * permisos en el manifiesto.
 *
 * Se piden LAS DOS cosas: una lectura suelta, que llega enseguida (vale incluso
 * una cacheada), y un seguimiento que la va afinando. Solo con el seguimiento la
 * primera posición puede tardar o no llegar nunca según el sistema, y la
 * pantalla se quedaba en "Buscando tu ubicación…"; solo con la lectura suelta,
 * las "paradas más cercanas" salían de un barrio de al lado, porque el primer
 * dato suele traer cientos de metros de error.
 */
function locateMe(): void {
  if (!navigator.geolocation) {
    state.maps.locationError = 'Este dispositivo no permite compartir la ubicación.'
    state.maps.locating = false
    render()
    return
  }

  state.maps.locating = true
  state.maps.locationError = null
  render()

  stopWatchingLocation()

  try {
    navigator.geolocation.getCurrentPosition(acceptPosition, rejectPosition, {
      enableHighAccuracy: false,
      timeout: 10_000,
      maximumAge: 60_000,
    })

    locationWatchId = navigator.geolocation.watchPosition(acceptPosition, rejectPosition, {
      enableHighAccuracy: true,
      timeout: 20_000,
      maximumAge: 15_000,
    })
  } catch (error) {
    state.maps.locating = false
    state.maps.locationError = errorMessage(error)
    render()
  }
}

/**
 * Una lectura de posición.
 *
 * Una posición peor NO pisa a una mejor: la lectura rápida y el seguimiento
 * llegan mezclados, y dejar que una cacheada de 500 m sustituyera a una recién
 * afinada de 20 m movía las paradas cercanas hacia atrás delante de tus ojos.
 */
function acceptPosition(position: GeolocationPosition): void {
  // Se puede haber salido de la pestaña mientras llegaba la posición.
  if (state.tab !== 'mapas') {
    stopWatchingLocation()
    return
  }

  const point: GeoPoint = {
    lat: position.coords.latitude,
    lon: position.coords.longitude,
  }

  if (!isValidPoint(point)) {
    return
  }

  const accuracy = position.coords.accuracy ?? Number.NaN
  const known = state.maps.location
  const better = !known
    || !Number.isFinite(known.accuracy)
    || !Number.isFinite(accuracy)
    || accuracy <= known.accuracy
    // Una lectura vieja deja de mandar aunque fuera más precisa: te has movido.
    || Date.now() - known.at > 20_000

  state.maps.locating = false
  state.maps.locationError = null

  if (!better) {
    render()
    return
  }

  state.maps.location = { point, accuracy, at: Date.now() }
  mapsSignature = ''

  // Alguien está esperando esta posición para rellenar un extremo de la ruta.
  if (pendingLocationField && state.maps.picking === pendingLocationField) {
    const here = currentLocationPoint()
    pendingLocationField = null
    if (here) {
      applyRoutePoint(here)
      return
    }
  }

  render()
}

function rejectPosition(error: GeolocationPositionError): void {
  pendingLocationField = null
  state.maps.locating = false

  // Un fallo de la lectura rápida no puede borrar una posición que ya se tenía;
  // el seguimiento puede seguir dando buenas lecturas después.
  if (!state.maps.location) {
    state.maps.locationError = describeGeolocationError(error)
    log('warn', 'mapas', state.maps.locationError)
  }

  if (error.code === error.PERMISSION_DENIED) {
    stopWatchingLocation()
  }

  render()
}

function describeGeolocationError(error: GeolocationPositionError): string {
  switch (error.code) {
    case error.PERMISSION_DENIED:
      return 'Has denegado el permiso de ubicación. Se concede desde los ajustes del sistema, en los permisos de SALBUS.'
    case error.POSITION_UNAVAILABLE:
      return 'El sistema no ha podido calcular dónde estás. Bajo techo suele tardar más; prueba a salir a la calle.'
    case error.TIMEOUT:
      return 'La ubicación ha tardado demasiado en llegar.'
    default:
      return 'No se ha podido obtener la ubicación.'
  }
}

/** El punto que representa "yo", ya sea como origen o como destino. */
function currentLocationPoint(): RoutePoint | null {
  const location = state.maps.location
  if (!location) {
    return null
  }

  return {
    kind: 'location',
    label: 'Mi ubicación',
    lat: location.point.lat,
    lon: location.point.lon,
  }
}

/**
 * Calcula la ruta.
 *
 * La espera en parada sale del horario programado cuando lo hay: es donde más
 * se equivoca una estimación a ojo. Si el GTFS no cubre esa línea se usa un
 * valor fijo, que es peor pero honesto.
 */
function planMapsRoute(): void {
  const { origin, destination } = state.maps
  const network = state.network

  if (!origin || !destination || !network) {
    return
  }

  state.maps.planning = true
  state.maps.focusedLeg = null
  render()

  try {
    const directions = network.lines.flatMap((line) => line.directions)
    const dayType = currentDayType()
    const nowMinutes = new Date().getHours() * 60 + new Date().getMinutes()
    const waitCache = new Map<string, number>()

    const plan = planRoute({
      origin: { lat: origin.lat, lon: origin.lon },
      destination: { lat: destination.lat, lon: destination.lon },
      originName: origin.label,
      destinationName: destination.label,
      directions,
      waitMinutes: (stopId, lineId, directionKey) => {
        const key = `${stopId}|${directionKey}`
        const cached = waitCache.get(key)
        if (cached !== undefined) {
          return cached
        }

        const wait = estimateWait(stopId, lineId, directionKey, dayType, nowMinutes)
        waitCache.set(key, wait)
        return wait
      },
    })

    state.maps.plan = plan
    mapsSignature = ''
    // El itinerario aparece por debajo del formulario, fuera de la pantalla: sin
    // llevar la vista hasta él, calcular una ruta parecía no hacer nada.
    scrollPending = 'ruta-resultado'

    if (plan.status === 'ok') {
      log(
        'info',
        'mapas',
        `Ruta calculada: ${Math.round(plan.best.totalMinutes)} min, ${plan.best.transfers} transbordo(s).`,
      )
    }
  } catch (error) {
    state.maps.plan = { status: 'unreachable', reason: errorMessage(error) }
    log('error', 'mapas', errorMessage(error))
  } finally {
    state.maps.planning = false
    render()
  }
}

/**
 * Minutos de espera estimados en una parada.
 *
 * Se calcula la frecuencia real de esa línea en esa parada (la mediana de los
 * huecos entre salidas programadas) y se supone que se llega a la mitad del
 * hueco, que es lo que ocurre cuando no se mira el horario. Usar "la próxima
 * salida a las 08:12" sería más preciso, pero el GTFS incluido caduca y esa
 * hora exacta acabaría siendo mentira; una frecuencia envejece mucho mejor.
 */
function estimateWait(
  stopId: string,
  lineId: string,
  directionKey: string,
  dayType: ReturnType<typeof currentDayType>,
  nowMinutes: number,
): number {
  const schedule = state.schedule
  if (!schedule) {
    return DEFAULT_WAIT_MINUTES
  }

  let times: string[]
  try {
    times = schedule.getScheduledTimes(stopId, lineId, dayType, directionKey)
  } catch {
    return DEFAULT_WAIT_MINUTES
  }

  // Solo la franja de alrededor: a las ocho de la mañana no importa la
  // frecuencia de las tres de la tarde.
  const window = times
    .map((clock) => parseClockToMinutes(clock))
    .filter((minutes) => Math.abs(minutes - nowMinutes) <= 90)
    .sort((left, right) => left - right)

  if (window.length < 2) {
    return DEFAULT_WAIT_MINUTES
  }

  const gaps: number[] = []
  for (let index = 1; index < window.length; index += 1) {
    gaps.push(window[index] - window[index - 1])
  }

  gaps.sort((left, right) => left - right)
  const headway = gaps[Math.floor(gaps.length / 2)]

  // Una frecuencia absurda (un solo paso al día, o datos rotos) no puede
  // convertirse en una espera de hora y media dentro del cálculo.
  return Math.min(DEFAULT_WAIT_MINUTES * 3, Math.max(1, headway / 2))
}

/**
 * Dibuja el mapa de la pestaña.
 *
 * Igual que el del buscador, se repinta solo cuando cambia algo de verdad: la
 * firma evita rehacer marcadores y encuadre en cada latido del reloj.
 */
function syncMapsMap(): void {
  const container = document.querySelector<HTMLDivElement>('#maps-map')

  if (!container || !state.network || state.tab !== 'mapas') {
    if (mapsMap) {
      mapsMap.remove()
      mapsMap = null
      mapsLayer = null
      mapsSignature = ''
    }
    return
  }

  if (!mapsMap || mapsMap.getContainer() !== container) {
    mapsMap?.remove()
    mapsMap = L.map(container, { zoomControl: false, attributionControl: true })
    L.control.zoom({ position: 'bottomleft' }).addTo(mapsMap)
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap',
    }).addTo(mapsMap)
    mapsLayer = L.layerGroup().addTo(mapsMap)
    mapsSignature = ''
  }

  const maps = state.maps
  const signature = [
    maps.mode,
    maps.location ? `${maps.location.point.lat.toFixed(5)},${maps.location.point.lon.toFixed(5)}` : '',
    maps.origin ? `${maps.origin.lat},${maps.origin.lon}` : '',
    maps.destination ? `${maps.destination.lat},${maps.destination.lon}` : '',
    maps.plan?.status ?? '',
    maps.focusedLeg ?? '',
  ].join('|')

  if (signature === mapsSignature) {
    mapsMap.invalidateSize()
    return
  }

  mapsSignature = signature
  mapsLayer?.clearLayers()
  mapsMap.invalidateSize()

  const bounds: Array<[number, number]> = []

  if (maps.mode === 'cercanas') {
    paintNearby(bounds)
  } else {
    paintRoute(bounds)
  }

  if (bounds.length === 1) {
    mapsMap.setView(bounds[0], 16)
  } else if (bounds.length > 1) {
    mapsMap.fitBounds(bounds, { padding: [36, 36], maxZoom: 17 })
  } else {
    // Sin nada que enseñar, el centro de Salamanca es mejor que el Atlántico.
    mapsMap.setView([40.9701, -5.6635], 13)
  }

  // El contenedor puede seguir cambiando de tamaño cuando se pinta; sin esta
  // segunda pasada el encuadre queda calculado sobre el tamaño anterior.
  window.setTimeout(() => {
    if (!mapsMap || state.tab !== 'mapas') {
      return
    }
    mapsMap.invalidateSize()
    if (bounds.length > 1) {
      mapsMap.fitBounds(bounds, { padding: [36, 36], maxZoom: 17 })
    }
  }, 80)
}

function paintNearby(bounds: Array<[number, number]>): void {
  const location = state.maps.location
  if (!location || !mapsLayer || !state.network) {
    return
  }

  const here: [number, number] = [location.point.lat, location.point.lon]
  bounds.push(here)

  // Circulo del margen de error: enseñar un punto exacto cuando el GPS dice
  // "en algún sitio de estos 300 m" es mentir con precisión.
  if (Number.isFinite(location.accuracy) && location.accuracy > 25) {
    L.circle(here, {
      radius: location.accuracy,
      color: '#1f6feb',
      weight: 1,
      opacity: 0.5,
      fillOpacity: 0.08,
    }).addTo(mapsLayer)
  }

  L.marker(here, {
    icon: L.divIcon({
      className: '',
      html: '<span class="map-me"><span class="map-me-dot"></span></span>',
      iconSize: [26, 26],
      iconAnchor: [13, 13],
    }),
    keyboard: false,
    zIndexOffset: 1200,
  }).addTo(mapsLayer)

  nearestStops(location.point, state.network.stops, 6).forEach((entry, index) => {
    const stop = entry.stop
    bounds.push([stop.lat, stop.lon])

    const marker = L.marker([stop.lat, stop.lon], {
      icon: L.divIcon({
        className: '',
        html: `<span class="map-near${index === 0 ? ' is-first' : ''}">${index + 1}</span>`,
        iconSize: [32, 32],
        iconAnchor: [16, 16],
        popupAnchor: [0, -16],
      }),
      keyboard: false,
      zIndexOffset: 100 - index,
    })

    marker.bindPopup(buildStopPopup(stop), {
      className: 'map-popup',
      closeButton: true,
      maxWidth: 260,
      minWidth: 200,
      autoPanPadding: [16, 16],
    })

    marker.addTo(mapsLayer as L.LayerGroup)
  })
}

function paintRoute(bounds: Array<[number, number]>): void {
  const maps = state.maps
  if (!mapsLayer) {
    return
  }

  for (const [point, kind] of [
    [maps.origin, 'origin'],
    [maps.destination, 'destination'],
  ] as Array<[RoutePoint | null, 'origin' | 'destination']>) {
    if (!point) {
      continue
    }

    bounds.push([point.lat, point.lon])
    L.marker([point.lat, point.lon], {
      icon: L.divIcon({
        className: '',
        html: `<span class="map-end is-${kind}"></span>`,
        iconSize: [22, 22],
        iconAnchor: [11, 11],
      }),
      keyboard: false,
      zIndexOffset: 900,
    }).addTo(mapsLayer)
  }

  const plan = maps.plan
  if (!plan || plan.status === 'unreachable') {
    return
  }

  const itinerary = plan.status === 'walk' ? plan.walking : plan.best

  itinerary.legs.forEach((leg, index) => {
    const dimmed = maps.focusedLeg !== null && maps.focusedLeg !== index

    if (leg.kind === 'walk') {
      const points: Array<[number, number]> = [
        [leg.from.lat, leg.from.lon],
        [leg.to.lat, leg.to.lon],
      ]
      points.forEach((point) => bounds.push(point))

      L.polyline(points, {
        color: '#6b7a90',
        weight: 4,
        opacity: dimmed ? 0.25 : 0.85,
        dashArray: '2 8',
        lineCap: 'round',
      }).addTo(mapsLayer as L.LayerGroup)
      return
    }

    const color = state.network?.getLineColor(leg.lineId) ?? '#173764'
    const points = leg.stops
      .filter((stop) => isValidPoint(stop))
      .map((stop) => [stop.lat, stop.lon] as [number, number])

    points.forEach((point) => bounds.push(point))

    L.polyline(points, {
      color,
      weight: dimmed ? 4 : 6,
      opacity: dimmed ? 0.25 : 0.9,
      lineCap: 'round',
      lineJoin: 'round',
    }).addTo(mapsLayer as L.LayerGroup)

    // Solo se marcan subida y bajada: una chincheta por parada intermedia
    // convierte el trazado en un collar ilegible.
    for (const [stop, role] of [
      [leg.from, 'board'],
      [leg.to, 'alight'],
    ] as Array<[typeof leg.from, 'board' | 'alight']>) {
      if (!isValidPoint(stop)) {
        continue
      }

      L.marker([stop.lat, stop.lon], {
        icon: L.divIcon({
          className: '',
          html: `<span class="map-stopdot is-${role}" style="--dot:${esc(color)}"></span>`,
          iconSize: [18, 18],
          iconAnchor: [9, 9],
          popupAnchor: [0, -9],
        }),
        keyboard: false,
        zIndexOffset: 500,
      })
        .bindPopup(buildStopPopup(stop), { className: 'map-popup', maxWidth: 260, minWidth: 200 })
        .addTo(mapsLayer as L.LayerGroup)
    }
  })
}

/* ------------------------------------------------------------------ *
 * Utilidades                                                           *
 * ------------------------------------------------------------------ */

function showToast(message: string, tone: 'info' | 'error' | 'success'): void {
  state.toast = { message, tone }
  render()

  if (toastTimer !== null) {
    window.clearTimeout(toastTimer)
  }

  toastTimer = window.setTimeout(() => {
    state.toast = null
    toastTimer = null
    render()
  }, 3200)
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
