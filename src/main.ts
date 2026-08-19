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
import { matchSlot, observe } from './services/punctuality'
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
  clearLogs,
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
  persistTab,
  persistTracking,
  state,
  TRACKING_BUS_TARGET,
  type MonitorJob,
  type TabId,
} from './state'
import type { StopFeed } from './types'
import { patch } from './dom'
import { liveMinutes } from './ui'
import { describeArrival, renderApp, stopName } from './views'

/* ------------------------------------------------------------------ *
 * Plugins nativos                                                      *
 * ------------------------------------------------------------------ */

interface BatteryOptimizationPlugin {
  isIgnoringBatteryOptimizations(): Promise<{ ignored: boolean }>
  requestIgnoreBatteryOptimizations(): Promise<void>
}

interface TrackingUpdate {
  stopId: string
  lineId: string
  minutes: number
  arriving: boolean
  status: 'ok' | 'empty' | 'throttled' | 'error'
  /** Autobuses ya contados por el servicio, que es quien manda mientras esta vivo. */
  busesSeen: number
  /** El servicio ha completado los tres autobuses y se esta deteniendo. */
  finished: boolean
  at: number
}

interface BusPassedUpdate {
  stopId: string
  lineId: string
  busesSeen: number
  target: number
  at: number
}

interface BusTrackingPlugin {
  start(options: {
    stopId: string
    stopName: string
    lineId: string
    destination: string
    intervalSeconds: number
    busesSeen: number
  }): Promise<void>
  stop(): Promise<void>
  isRunning(): Promise<{ running: boolean }>
  addListener(
    event: 'arrivalUpdate',
    handler: (update: TrackingUpdate) => void,
  ): Promise<{ remove: () => Promise<void> }>
  addListener(
    event: 'busPassed',
    handler: (update: BusPassedUpdate) => void,
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

const root = document.querySelector<HTMLDivElement>('#app')
if (!root) {
  throw new Error('No se encontró el contenedor #app.')
}

const appRoot = root

let renderQueued = false
let lastAutoCycleAt = 0

/**
 * El servicio nativo esta al mando del aviso.
 *
 * Mientras lo este, la parte web no publica su propia notificacion: serian dos
 * avisos distintos, y el de la web se congelaria en cuanto la app pasara a
 * segundo plano. Tampoco cuenta autobuses aqui, para no contar dos veces.
 */
let trackingServiceActive = false
let refreshInFlight = false
let toastTimer: number | null = null
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
    if (document.visibilityState === 'visible') {
      void refreshVisible('manual')
      void syncPermissions()
    }
  })

  void refreshVisible('auto')
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

  // 1. El aviso activo manda: siempre es lo primero.
  if (state.tracking) {
    add(state.tracking.stopId, FRESHNESS.focused, 'high')
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

  if (state.tab === 'paradas') {
    if (state.expandedStopId) {
      add(state.expandedStopId, FRESHNESS.focused, 'high')
    }
    for (const favourite of state.favourites) {
      add(favourite.stopId, FRESHNESS.visible)
    }
  }

  if (state.tab === 'inicio') {
    for (const favourite of state.favourites) {
      add(favourite.stopId, FRESHNESS.visible)
    }
  }

  // 4. Recorridos en seguimiento: la parada propia primero, luego hacia atras.
  if (state.tab === 'seguimiento' || state.tracking) {
    for (const follow of state.follows) {
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
        onFeed: (feed) => {
          done += 1
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
    render()
  }
}

/** Refresca una sola parada de inmediato (botón de la tarjeta). */
async function refreshOneStop(stopId: string): Promise<void> {
  state.refreshing = true
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
 * Aviso de próximo bus                                                 *
 * ------------------------------------------------------------------ */

async function startTracking(stopId: string, lineId: string): Promise<void> {
  if (state.tracking) {
    await stopTracking(false)
  }

  const job = {
    id: `${stopId}|${lineId}`,
    stopId,
    stopName: stopName(stopId),
    lineId,
    startedAt: Date.now(),
    lastMinutes: null,
    lastNotifiedAt: 0,
    armed: false,
    missingStreak: 0,
    busesSeen: 0,
  }

  state.tracking = job
  persistTracking()
  log(
    'info',
    'aviso',
    `Seguimiento iniciado: línea ${lineId} en ${job.stopName} (${TRACKING_BUS_TARGET} autobuses).`,
  )

  // El servicio nativo mantiene vivo el aviso aunque la app pase a segundo plano.
  if (isNative()) {
    try {
      await BusTracking.start({
        stopId,
        stopName: job.stopName,
        lineId,
        destination: describeArrival(stopId, lineId),
        intervalSeconds: TRACKING_INTERVAL_SECONDS,
        busesSeen: 0,
      })
      trackingServiceActive = true
      // Si una version anterior dejo una notificacion web, aqui sobra: el servicio
      // ya publica la suya y esa se quedaria fija para siempre.
      await cancelNotification(notificationId(job.id))
    } catch (error) {
      trackingServiceActive = false
      log('warn', 'aviso', `No se pudo iniciar el servicio en segundo plano: ${errorMessage(error)}`)
      showToast('El aviso funcionará solo con la app abierta', 'error')
    }
  }

  await refreshOneStop(stopId)
}

async function stopTracking(notify = true): Promise<void> {
  const job = state.tracking
  if (!job) {
    return
  }

  state.tracking = null
  persistTracking()

  await cancelNotification(notificationId(job.id))

  if (isNative()) {
    trackingServiceActive = false
    try {
      await BusTracking.stop()
    } catch {
      /* el servicio ya no estaba activo */
    }
  }

  log('info', 'aviso', `Seguimiento detenido: línea ${job.lineId}.`)

  if (notify) {
    showToast('Aviso detenido', 'info')
    render()
  }
}

/**
 * Reconecta la interfaz con el servicio nativo tras reabrir la app, para que la
 * pantalla y la notificación no cuenten historias distintas.
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
      if (state.tracking && state.tracking.stopId === update.stopId) {
        state.tracking.busesSeen = update.busesSeen
        persistTracking()
      }

      if (update.finished) {
        trackingServiceActive = false
        void finishTracking()
        return
      }

      render()
    })

    await BusTracking.addListener('busPassed', (update) => {
      if (!state.tracking || state.tracking.stopId !== update.stopId) {
        return
      }

      state.tracking.busesSeen = update.busesSeen
      state.tracking.armed = false
      state.tracking.lastMinutes = null
      state.tracking.missingStreak = 0
      persistTracking()

      log(
        'info',
        'aviso',
        `Autobús ${update.busesSeen} de ${update.target} de la línea ${update.lineId} ha pasado por ${stopName(update.stopId)}.`,
      )
      showToast(`Autobús ${update.busesSeen} de ${update.target} ya ha pasado`, 'info')
      render()
    })

    const { running } = await BusTracking.isRunning()
    trackingServiceActive = running && Boolean(state.tracking)

    if (running && !state.tracking) {
      // El servicio quedó vivo pero la app perdió el estado: se detiene para no
      // dejar una notificación huérfana.
      await BusTracking.stop()
    } else if (!running && state.tracking && state.tracking.busesSeen >= TRACKING_BUS_TARGET) {
      // El servicio completó los tres autobuses con la app cerrada: se cierra el
      // aviso en lugar de revivirlo.
      await finishTracking()
    } else if (!running && state.tracking) {
      await BusTracking.start({
        stopId: state.tracking.stopId,
        stopName: state.tracking.stopName,
        lineId: state.tracking.lineId,
        destination: describeArrival(state.tracking.stopId, state.tracking.lineId),
        intervalSeconds: TRACKING_INTERVAL_SECONDS,
        busesSeen: state.tracking.busesSeen,
      })
      trackingServiceActive = true
      // El servicio publica su propia notificación: cualquier resto de la web
      // sobra, porque ya no se volvería a actualizar.
      await cancelNotification(notificationId(state.tracking.id))
    }
  } catch (error) {
    trackingServiceActive = false
    log('warn', 'aviso', `Servicio en segundo plano no disponible: ${errorMessage(error)}`)
  }
}

function evaluateTracking(feed: StopFeed): void {
  const job = state.tracking
  if (!job || job.stopId !== feed.stopId) {
    return
  }

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
      void registerBusPassed()
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
    void registerBusPassed()
    return
  }

  job.lastMinutes = minutes
  job.lastNotifiedAt = Date.now()
  persistTracking()

  // Con el servicio nativo vivo, la notificación es suya y solo suya: publicar
  // otra desde aquí dejaría un segundo aviso que se congela al irse a segundo
  // plano. Esto es solo el respaldo para cuando el servicio no está disponible.
  if (isNative() && !trackingServiceActive && !document.hidden) {
    void showTrackingNotification({
      id: notificationId(job.id),
      stopName: job.stopName,
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
 * Un autobús más ha pasado. El aviso solo termina cuando se han visto pasar
 * TRACKING_BUS_TARGET; hasta entonces se rearma y sigue con el siguiente.
 */
async function registerBusPassed(): Promise<void> {
  const job = state.tracking
  if (!job) {
    return
  }

  job.busesSeen += 1
  job.armed = false
  job.lastMinutes = null
  job.missingStreak = 0
  persistTracking()

  if (job.busesSeen >= TRACKING_BUS_TARGET) {
    await finishTracking()
    return
  }

  // Mismo id en todos los avisos intermedios: se sustituyen en vez de apilarse.
  await showArrivalAlert(notificationId(`${job.id}|done`), job.lineId, job.stopName, {
    seen: job.busesSeen,
    target: TRACKING_BUS_TARGET,
  })
  log(
    'info',
    'aviso',
    `Autobús ${job.busesSeen} de ${TRACKING_BUS_TARGET} de la línea ${job.lineId} ha pasado por ${job.stopName}.`,
  )
  showToast(`Autobús ${job.busesSeen} de ${TRACKING_BUS_TARGET} ya ha pasado`, 'info')
  render()
}

/** Cierra el aviso: ya han pasado los tres autobuses. */
async function finishTracking(): Promise<void> {
  const job = state.tracking
  if (!job) {
    return
  }

  await showArrivalAlert(notificationId(`${job.id}|done`), job.lineId, job.stopName, {
    seen: TRACKING_BUS_TARGET,
    target: TRACKING_BUS_TARGET,
  })
  log(
    'info',
    'aviso',
    `Aviso completado: han pasado ${TRACKING_BUS_TARGET} autobuses de la línea ${job.lineId} por ${job.stopName}.`,
  )
  await stopTracking(false)
  showToast(`Han pasado ${TRACKING_BUS_TARGET} autobuses de la línea ${job.lineId}`, 'success')
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

function paint(): void {
  // Repintado incremental: solo se tocan los nodos que han cambiado. Antes se
  // reescribía todo el HTML cada segundo, y eso cerraba cualquier desplegable
  // abierto (el elemento sobre el que el sistema lo había desplegado dejaba de
  // existir), además de perder foco, cursor y desplazamiento.
  patch(appRoot, renderApp())
  syncMap()
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
    state.search.directionKey = state.network?.lineById.get(target.value)?.directions[0]?.key ?? ''
    render()
  }

  if (action === 'pick-search-direction') {
    state.search.directionKey = target.value
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
        state.tab = tab
        state.sheet = null
        persistTab()
        render()
        void refreshVisible('auto')
      }
      return
    }

    case 'refresh':
      await refreshVisible('manual')
      return

    case 'refresh-stop':
      await refreshOneStop(stopId)
      return

    case 'retry-boot':
      window.location.reload()
      return

    case 'search-mode': {
      const mode = element.dataset.mode as 'nombre' | 'linea' | 'mapa' | undefined
      if (mode) {
        state.search.mode = mode
        if (mode !== 'nombre' && !state.search.lineId) {
          const firstLine = state.network?.lines[0]
          state.search.lineId = firstLine?.lineId ?? ''
          state.search.directionKey = firstLine?.directions[0]?.key ?? ''
        }
        render()
      }
      return
    }

    case 'select-stop':
      state.search.selectedStopId = stopId
      render()
      await refreshOneStop(stopId)
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

      const lines = state.network?.getLinesForStop(stopId) ?? []
      state.draft.lineId = lines[0]?.lineId ?? ''
      state.draft.directionKey =
        state.network?.getDirectionsThroughStop(stopId, state.draft.lineId)[0]?.key ?? ''
      state.sheet = { kind: 'pick-line', stopId, purpose }
      render()
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
      await stopTracking()
      return

    case 'remove-follow':
      state.follows = state.follows.filter((item) => item.id !== element.dataset.follow)
      persistFollows()
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
    await startTracking(stopId, lineId)
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
        { id, stopId, stopName: stopName(stopId), lineId, directionKey, createdAt: Date.now() },
      ]
      persistFollows()
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
    map = L.map(container, { zoomControl: true, attributionControl: true })
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap',
    }).addTo(map)
    mapLayer = L.layerGroup().addTo(map)
    mapSignature = ''
  }

  const direction = state.network.directionByKey.get(state.search.directionKey)
  const stops = direction?.stops ?? []
  const signature = `${state.search.directionKey}|${state.search.selectedStopId ?? ''}`

  if (signature === mapSignature) {
    map.invalidateSize()
    return
  }

  mapSignature = signature
  mapLayer?.clearLayers()

  const color = state.network.getLineColor(direction?.key.split('|')[0] ?? '')
  const points: Array<[number, number]> = []

  for (const stop of stops) {
    if (!Number.isFinite(stop.lat) || !Number.isFinite(stop.lon)) {
      continue
    }

    points.push([stop.lat, stop.lon])
    const selected = state.search.selectedStopId === stop.stopId

    const marker = L.circleMarker([stop.lat, stop.lon], {
      radius: selected ? 9 : 6,
      color: '#ffffff',
      weight: 2,
      fillColor: selected ? '#ffcf3d' : color,
      fillOpacity: 1,
    })

    marker.bindTooltip(`${stop.stopName} · ${stop.stopId}`)
    marker.on('click', () => {
      state.search.selectedStopId = stop.stopId
      render()
      void refreshOneStop(stop.stopId)
    })

    if (mapLayer) {
      marker.addTo(mapLayer)
    }
  }

  // El trazado une las paradas en el orden real del trayecto.
  if (points.length > 1 && mapLayer) {
    L.polyline(points, { color, weight: 4, opacity: 0.65 }).addTo(mapLayer)
  }

  if (points.length > 0) {
    map.fitBounds(points, { padding: [28, 28], maxZoom: 16 })
  } else {
    map.setView([40.9701, -5.6635], 13)
  }

  window.setTimeout(() => map?.invalidateSize(), 60)
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
