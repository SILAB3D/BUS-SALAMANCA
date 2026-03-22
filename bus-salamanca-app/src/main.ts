import { Capacitor, registerPlugin } from '@capacitor/core'
import { LocalNotifications } from '@capacitor/local-notifications'
import * as L from 'leaflet'
import 'leaflet/dist/leaflet.css'

import './style.css'
import { loadGtfsDataset } from './services/gtfs'
import { fetchWebArrivals, fetchWebArrivalsForMultipleStops } from './services/web-fallback'
import type { DepartureInsight, GtfsDataset, RealtimeSnapshot, RouteDirectionOption, RouteInsight, ServiceDayType, StopOption } from './types'

interface BatteryOptimizationPlugin {
  isIgnoringBatteryOptimizations(): Promise<{ ignored: boolean }>
  requestIgnoreBatteryOptimizations(): Promise<void>
}

const BatteryOptimization = registerPlugin<BatteryOptimizationPlugin>('BatteryOptimization')

const HUB_STORAGE_KEY = 'bus-salamanca-hub-stops'
const HUB_CUSTOM_NAMES_STORAGE_KEY = 'bus-salamanca-hub-custom-names'
const DATA_MODE_STORAGE_KEY = 'bus-salamanca-data-mode'
const MONITORING_STORAGE_KEY = 'bus-salamanca-monitorings'
const MONITORING_STATS_STORAGE_KEY = 'bus-salamanca-monitoring-stats'
const LOCATOR_STORAGE_KEY = 'bus-salamanca-locators'
const SETTINGS_UPDATES_STORAGE_KEY = 'bus-salamanca-settings-updates'
const REALTIME_FAILURES_STORAGE_KEY = 'bus-salamanca-realtime-failures'
const MONITORING_AVG_FAILURES_STORAGE_KEY = 'bus-salamanca-monitoring-avg-failures'
const APP_BUILD_VERSION = 'v3.4'
const TOPBAR_CLOCK_REFRESH_SECONDS = 1
const LOCATOR_REFRESH_SECONDS = 30
const TRACKING_REFRESH_SECONDS = 30
const MONITORING_REFRESH_SECONDS = 30
const MANUAL_REFRESH_COOLDOWN_SECONDS = 25
const DEFAULT_GLOBAL_UPDATE_COOLDOWN_SECONDS = 25
const INICIO_STOP_REFRESH_COOLDOWN_SECONDS = 15

const PASS_NEAR_THRESHOLD_MIN = 3
const PASS_FAR_THRESHOLD_MIN = 5
const PASS_NEAR_CHECKPOINTS_REQUIRED = 1
const PASS_MISSING_CHECKPOINTS_REQUIRED = 2
const SEGUIMIENTO_STICKY_MAX_MISSES = 3

type TabId = 'home' | 'inicio' | 'hub' | 'monitorizacion' | 'localizador' | 'estado' | 'registros'
type DataMode = 'realtime' | 'gtfs' | 'mixed'
type InicioSearchMode = 'stop' | 'route' | 'map'

interface TrackingState {
  key: string
  stopId: string
  stopName: string
  routeShortName: string
  armed: boolean
  nearStreak: number
  missingStreak: number
  lastMinutes: number | null
  lastUpdateAt: number
  lastNotificationMinutes: number | null
}

interface MonitoringRegistration {
  id: string
  stopId: string
  stopName: string
  routeShortName: string
  startMinutes: number
  endMinutes: number
}

interface MonitoringRuntimeState {
  armed: boolean
  nearStreak: number
  missingStreak: number
  lastMinutes: number | null
}

interface MonitoringAverageStats {
  count: number
  sumMinutes: number
  minMinutes: number
  maxMinutes: number
  perDayLatest: Record<string, number>
}

interface LocatorRegistration {
  id: string
  stopId: string
  stopName: string
  routeShortName: string
}

type PermissionState = 'granted' | 'denied' | 'unknown'

interface PermissionStatusItem {
  title: string
  description: string
  state: PermissionState
}

type SettingsUpdateSource = 'manual' | 'auto' | 'system'
type SettingsUpdateStatus = 'ok' | 'error' | 'info'
type ActionModalMode = 'tracking' | 'monitoring' | 'locator'

interface SettingsUpdateEntry {
  id: string
  at: string
  tab: TabId
  source: SettingsUpdateSource
  status: SettingsUpdateStatus
  action: string
  detail: string
}

interface ActionModalState {
  stopId: string
  mode: ActionModalMode
}

interface FailureLogEntry {
  id: string
  at: string
  reason: string
  detail: string
  tab: TabId
}

const app = document.querySelector<HTMLDivElement>('#app')

if (!app) {
  throw new Error('No se encontró el contenedor principal de la aplicación.')
}

const appRoot = app

const state: {
  activeTab: TabId
  menuOpen: boolean
  dataMode: DataMode
  loading: boolean
  refreshing: boolean
  phase: string
  error: string | null
  appReloadedAt: Date | null
  dataset: GtfsDataset | null
  realtime: RealtimeSnapshot | null
  realtimeArrivalsByStop: Record<string, DepartureInsight[]>
  selectedStopId: string | null
  inicioSearchMode: InicioSearchMode
  inicioRouteShortName: string
  stopSearchDraft: string
  stopSearchApplied: string
  inicioRouteDirectionKey: string
  inicioMapRouteShortName: string
  hubStopIds: string[]
  hubCustomNamesByStopId: Record<string, string>
  hubAutoRefreshStopId: string | null
  manualRefreshCooldownUntil: number
  lastEventDetectedAt: Date | null
  locatorLastUpdatedAt: Date | null
  hubLastUpdatedAt: Date | null
  monitoringLastUpdatedAt: Date | null
  lastRefreshAt: Date | null
  lastRefreshTab: TabId | null
  trackingByKey: Record<string, TrackingState>
  trackingRouteChoiceByStop: Record<string, string>
  expandedTrackingByStop: Record<string, boolean>
  expandedMonitoringByStop: Record<string, boolean>
  expandedLocatorByStop: Record<string, boolean>
  monitoringRouteChoiceByStop: Record<string, string>
  locatorRouteChoiceByStop: Record<string, string>
  monitoringRangeByStop: Record<string, { startMinutes: number, endMinutes: number }>
  monitoringIntervalEditorStopId: string | null
  actionModal: ActionModalState | null
  monitoringDayTypeViewById: Record<string, ServiceDayType>
  expandedHubCardByStop: Record<string, boolean>
  expandedMonitoringCardById: Record<string, boolean>
  monitorings: MonitoringRegistration[]
  locators: LocatorRegistration[]
  locatorStickyMinutes: Record<string, { minutes: number, missCount: number }>
  monitoringRuntimeById: Record<string, MonitoringRuntimeState>
  monitoringStatsById: Record<string, Record<ServiceDayType, Record<string, MonitoringAverageStats>>>
  openSampleTooltipId: string | null
  permissions: {
    notifications: PermissionState
    batteryOptimization: PermissionState
  }
  settingsUpdates: SettingsUpdateEntry[]
  realtimeFailures: FailureLogEntry[]
  monitoringAverageFailures: FailureLogEntry[]
} = {
  activeTab: 'home',
  menuOpen: false,
  dataMode: loadDataMode(),
  loading: true,
  refreshing: false,
  phase: 'Preparando lectura del feed...',
  error: null,
  appReloadedAt: null,
  dataset: null,
  realtime: null,
  realtimeArrivalsByStop: {},
  selectedStopId: null,
  inicioSearchMode: 'stop',
  inicioRouteShortName: '',
  stopSearchDraft: '',
  stopSearchApplied: '',
  inicioRouteDirectionKey: '',
  inicioMapRouteShortName: '',
  hubStopIds: loadStoredStopIds(),
  hubCustomNamesByStopId: loadHubCustomNames(),
  hubAutoRefreshStopId: null,
  manualRefreshCooldownUntil: 0,
  lastEventDetectedAt: null,
  locatorLastUpdatedAt: null,
  hubLastUpdatedAt: null,
  monitoringLastUpdatedAt: null,
  lastRefreshAt: null,
  lastRefreshTab: null,
  trackingByKey: {},
  trackingRouteChoiceByStop: {},
  expandedTrackingByStop: {},
  expandedMonitoringByStop: {},
  expandedLocatorByStop: {},
  monitoringRouteChoiceByStop: {},
  locatorRouteChoiceByStop: {},
  monitoringRangeByStop: {},
  monitoringIntervalEditorStopId: null,
  actionModal: null,
  monitoringDayTypeViewById: {},
  expandedHubCardByStop: {},
  expandedMonitoringCardById: {},
  monitorings: loadMonitorings(),
  locators: loadLocators(),
  locatorStickyMinutes: {},
  monitoringRuntimeById: {},
  monitoringStatsById: loadMonitoringStats(),
  openSampleTooltipId: null,
  permissions: {
    notifications: 'unknown',
    batteryOptimization: 'unknown',
  },
  settingsUpdates: loadSettingsUpdates(),
  realtimeFailures: loadFailureLogs(REALTIME_FAILURES_STORAGE_KEY),
  monitoringAverageFailures: loadFailureLogs(MONITORING_AVG_FAILURES_STORAGE_KEY),
}

let autoRefreshTimer: number | null = null
let topbarClockTimer: number | null = null
let batteryOptimizationPrompted = false
let lastAutoRefreshRunAt = 0
let lastUpdateEventAt = 0
let transientErrorTimer: number | null = null
let inicioMap: L.Map | null = null
let inicioMapMarkerLayer: L.LayerGroup | null = null

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    void checkBatteryOptimization(false).then(() => render())
  }
})

void bootstrap()

async function bootstrap(): Promise<void> {
  await setupNotificationsPermissions()
  await loadInitialData()
  setupAutoRefresh()
  setupTopbarClockRefresh()
}

async function setupNotificationsPermissions(): Promise<void> {
  if (Capacitor.getPlatform() === 'web') {
    state.permissions.notifications = 'unknown'
    return
  }

  try {
    const permissions = await LocalNotifications.checkPermissions()
    state.permissions.notifications = mapNotificationPermission(permissions.display)

    if (permissions.display !== 'granted') {
      const requested = await LocalNotifications.requestPermissions()
      state.permissions.notifications = mapNotificationPermission(requested.display)
    }
  } catch {
    // If permissions fail, app still works without notifications.
    state.permissions.notifications = 'unknown'
  }

  await checkBatteryOptimization(true)
}

async function checkBatteryOptimization(allowPrompt: boolean): Promise<void> {
  if (Capacitor.getPlatform() !== 'android') {
    state.permissions.batteryOptimization = 'granted'
    return
  }

  try {
    let result = await BatteryOptimization.isIgnoringBatteryOptimizations()
    state.permissions.batteryOptimization = result.ignored ? 'granted' : 'denied'
    if (!result.ignored && allowPrompt && !batteryOptimizationPrompted) {
      batteryOptimizationPrompted = true
      await BatteryOptimization.requestIgnoreBatteryOptimizations()
      await new Promise((resolve) => window.setTimeout(resolve, 450))
      result = await BatteryOptimization.isIgnoringBatteryOptimizations()
      state.permissions.batteryOptimization = result.ignored ? 'granted' : 'denied'
    }
  } catch {
    state.permissions.batteryOptimization = 'unknown'
  }
}

async function loadInitialData(): Promise<void> {
  state.loading = true
  state.error = null
  state.phase = 'Cargando datos GTFS...'
  render()

  try {
    const dataset = await loadGtfsDataset('/data/gtfs.zip', {
      onProgress: (phase) => {
        state.phase = phase
        render()
      },
    })

    state.appReloadedAt = new Date()
    state.dataset = dataset
    syncStoredStopsWithDataset()
    state.realtime = {
      providerName: 'salamanca-web-fallback',
      connected: true,
      vehicleCount: 0,
      updatedAt: new Date().toISOString(),
      statusMessage: 'Datos estáticos cargados. Llegadas vía web.',
    }
    state.selectedStopId = null
    state.inicioRouteDirectionKey = ''
    state.inicioMapRouteShortName = ''
    state.inicioRouteShortName = ''

    await refreshArrivals('manual')
    pushSettingsUpdate('Carga inicial de datos', 'system', 'ok', 'inicio', 'Datos GTFS y llegadas web cargados')
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'No se pudieron cargar los datos.'
    setTransientError(errorMessage)
    pushSettingsUpdate('Carga inicial de datos', 'system', 'error', 'inicio', errorMessage)
  } finally {
    state.loading = false
    render()
  }
}

async function refreshArrivals(source: 'manual' | 'auto', force = false): Promise<void> {
  if (state.refreshing) {
    return
  }

  const nowMs = Date.now()
  const globalCooldownSeconds = getGlobalUpdateCooldownSeconds()
  const elapsedMs = nowMs - lastUpdateEventAt
  if (!force && lastUpdateEventAt > 0 && elapsedMs < globalCooldownSeconds * 1000) {
    if (source === 'manual') {
      const waitSeconds = Math.max(1, Math.ceil((globalCooldownSeconds * 1000 - elapsedMs) / 1000))
      setTransientError(`Debes esperar ${waitSeconds} s antes de actualizar de nuevo.`)
    }
    return
  }

  lastUpdateEventAt = nowMs

  state.refreshing = true

  const previousRealtime = JSON.stringify(state.realtime)
  const previousArrivals = JSON.stringify(state.realtimeArrivalsByStop)

  try {
    const selectedStopId = state.selectedStopId
    const locatorStopIds = getLocatorRealtimeStopIds()
    const monitoringStopIds = getMonitoringRealtimeStopIds()
    const hubStopIds = Array.from(new Set([...state.hubStopIds, ...locatorStopIds, ...monitoringStopIds]))
    const shouldFetchForLocator = state.activeTab === 'localizador' && state.locators.length > 0

    const [selectedArrivals, hubArrivals] = await Promise.all([
      selectedStopId
        ? fetchWebArrivals(selectedStopId, 12)
        : Promise.resolve([]),
      fetchWebArrivalsForMultipleStops(hubStopIds, 10),
    ])

    state.realtime = {
      providerName: 'salamanca-web-fallback',
      connected: true,
      vehicleCount: 0,
      updatedAt: new Date().toISOString(),
      statusMessage: 'Llegadas obtenidas desde la web pública.',
    }

    state.realtimeArrivalsByStop = {
      ...hubArrivals,
      ...(selectedStopId ? { [selectedStopId]: selectedArrivals } : {}),
    }

    if (shouldFetchForLocator) {
      state.locatorLastUpdatedAt = new Date()
      updateLocatorStickyCache()
    }

    const eventCount = Object.values(state.realtimeArrivalsByStop)
      .reduce((count, arrivals) => count + arrivals.length, 0)

    if (eventCount > 0) {
      state.lastEventDetectedAt = new Date()
    } else {
      recordRealtimeFailure(
        'Sin eventos en tiempo real',
        `No se recibieron llegadas realtime para ${hubStopIds.length} paradas solicitadas.`,
        state.activeTab,
      )
    }

    if (state.realtime?.connected !== true) {
      recordRealtimeFailure(
        'Canal realtime desconectado',
        'La fuente de tiempo real no aparece conectada en este ciclo de actualización.',
        state.activeTab,
      )
    }

    await evaluateTrackingStates()
    evaluateMonitoringStates()
    state.lastRefreshAt = new Date()
    state.lastRefreshTab = state.activeTab
    if (state.activeTab === 'hub') {
      state.hubLastUpdatedAt = new Date()
    }
    if (state.activeTab === 'monitorizacion') {
      state.monitoringLastUpdatedAt = new Date()
    }
    if (state.activeTab === 'localizador') {
      state.locatorLastUpdatedAt = new Date()
    }

    const nextRealtime = JSON.stringify(state.realtime)
    const nextArrivals = JSON.stringify(state.realtimeArrivalsByStop)
    const changed = previousRealtime !== nextRealtime || previousArrivals !== nextArrivals

    pushSettingsUpdate(
      'Actualizacion de llegadas',
      source,
      'ok',
      state.activeTab,
      changed ? 'Datos actualizados' : 'Solicitud completada sin cambios',
    )

    if (source === 'manual' || changed) {
      state.error = null
      render()
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'No se pudieron actualizar los tiempos.'
    setTransientError(errorMessage)
    pushSettingsUpdate('Actualizacion de llegadas', source, 'error', state.activeTab, errorMessage)
    recordRealtimeFailure('Error al solicitar realtime', errorMessage, state.activeTab)
  } finally {
    state.refreshing = false
  }
}

async function evaluateTrackingStates(): Promise<void> {
  const trackerKeys = Object.keys(state.trackingByKey)
  if (trackerKeys.length === 0) {
    return
  }

  const keysToComplete: string[] = []

  for (const key of trackerKeys) {
    const tracker = state.trackingByKey[key]
    const departures = getDeparturesForStop(tracker.stopId, 15)
    const current = departures.find((item) => item.routeShortName === tracker.routeShortName) ?? null

    if (current) {
      const minutes = typeof current.minutesUntil === 'number' ? current.minutesUntil : null
      const wasNearBefore = typeof tracker.lastMinutes === 'number' && tracker.lastMinutes <= PASS_NEAR_THRESHOLD_MIN

      tracker.missingStreak = 0
      tracker.lastUpdateAt = Date.now()

      if (minutes !== null && minutes <= PASS_NEAR_THRESHOLD_MIN) {
        tracker.nearStreak += 1
        if (tracker.nearStreak >= PASS_NEAR_CHECKPOINTS_REQUIRED) {
          tracker.armed = true
        }
      } else {
        tracker.nearStreak = 0
      }

      if (tracker.armed && wasNearBefore && minutes !== null && minutes >= PASS_FAR_THRESHOLD_MIN) {
        keysToComplete.push(key)
        continue
      }

      tracker.lastMinutes = minutes
      await notifyTrackingProgress(tracker, current)
      continue
    }

    if (tracker.armed) {
      tracker.missingStreak += 1
      if (tracker.missingStreak >= PASS_MISSING_CHECKPOINTS_REQUIRED) {
        keysToComplete.push(key)
      }
    }

    tracker.lastMinutes = null
    tracker.lastUpdateAt = Date.now()
  }

  for (const key of keysToComplete) {
    await completeTracking(key)
  }
}

function evaluateMonitoringStates(): void {
  if (state.monitorings.length === 0 || Object.keys(state.trackingByKey).length > 0) {
    return
  }

  const now = new Date()
  const nowMinutes = now.getHours() * 60 + now.getMinutes()

  for (const monitoring of state.monitorings) {
    if (!isMinuteInRange(nowMinutes, monitoring.startMinutes, monitoring.endMinutes)) {
      continue
    }

    const runtime = state.monitoringRuntimeById[monitoring.id] ?? {
      armed: false,
      nearStreak: 0,
      missingStreak: 0,
      lastMinutes: null,
    }

    const departures = getDeparturesForStop(monitoring.stopId, 15)
    const current = departures.find((item) => item.routeShortName === monitoring.routeShortName) ?? null

    if (!current) {
      recordMonitoringAverageFailure(
        'Sin llegada realtime en monitorización',
        `${monitoring.stopName} · línea ${monitoring.routeShortName}: no hubo llegada realtime utilizable en este ciclo.`,
        'monitorizacion',
      )
    }

    if (current) {
      const minutes = typeof current.minutesUntil === 'number' ? current.minutesUntil : null
      const wasNearBefore = typeof runtime.lastMinutes === 'number' && runtime.lastMinutes <= PASS_NEAR_THRESHOLD_MIN

      runtime.missingStreak = 0

      if (minutes !== null && minutes <= PASS_NEAR_THRESHOLD_MIN) {
        runtime.nearStreak += 1
        if (runtime.nearStreak >= PASS_NEAR_CHECKPOINTS_REQUIRED) {
          runtime.armed = true
        }
      } else {
        runtime.nearStreak = 0
      }

      if (runtime.armed && wasNearBefore && minutes !== null && minutes >= PASS_FAR_THRESHOLD_MIN) {
        registerMonitoringPass(monitoring, now)
        runtime.armed = false
        runtime.nearStreak = 0
      }

      runtime.lastMinutes = minutes
      state.monitoringRuntimeById[monitoring.id] = runtime
      continue
    }

    if (runtime.armed) {
      runtime.missingStreak += 1
      if (runtime.missingStreak >= PASS_MISSING_CHECKPOINTS_REQUIRED) {
        registerMonitoringPass(monitoring, now)
        runtime.armed = false
        runtime.nearStreak = 0
        runtime.missingStreak = 0
      }
    }

    runtime.lastMinutes = null
    state.monitoringRuntimeById[monitoring.id] = runtime
  }
}

async function notifyTrackingProgress(tracker: TrackingState, departure: DepartureInsight): Promise<void> {
  const minutes = typeof departure.minutesUntil === 'number' ? departure.minutesUntil : null
  tracker.lastNotificationMinutes = minutes

  const title = `🚌 SALBUS · Seguimiento activo · ${tracker.stopName}`
  const updatedAt = formatTimeOnly(new Date())
  const etaText = minutes === null
    ? 'sin estimación'
    : minutes <= 0
      ? 'llegada inminente'
      : `${minutes} min`
  const body = `Línea ${tracker.routeShortName} · ${getDirectionLabelForRoute(tracker.routeShortName)} · ${etaText} · actualizado ${updatedAt}`

  await pushLocalNotification(buildNotificationId(tracker.key), title, body)
}

async function completeTracking(key: string): Promise<void> {
  const tracker = state.trackingByKey[key]
  if (!tracker) {
    return
  }

  await cancelLocalNotification(buildNotificationId(tracker.key))

  delete state.trackingByKey[key]
}

function render(): void {
  const dataset = state.dataset
  const stopMatches = dataset ? dataset.findStops(state.stopSearchApplied) : []
  const selectedStop = dataset && state.selectedStopId ? dataset.stopMap.get(state.selectedStopId) ?? null : null
  const selectedDepartures = selectedStop ? getDeparturesForStop(selectedStop.stopId, 10) : []
  const routeDirectionOptions = getRouteDirectionOptions()

  const isManualCooldownActive = Date.now() < (state.manualRefreshCooldownUntil ?? 0)
  const realtimeEventCount = Object.values(state.realtimeArrivalsByStop)
    .reduce((count, arrivals) => count + arrivals.length, 0)
  const hasRealtimeData = state.realtime?.connected === true && realtimeEventCount > 0
  const bannerClass = hasRealtimeData
    ? (isManualCooldownActive ? 'banner-warning' : 'banner-ok')
    : 'banner-error'
  const remainingCooldownSeconds = getDisplayedCooldownSeconds()
  const cooldownDisplay = remainingCooldownSeconds <= 0 ? '✔' : String(remainingCooldownSeconds)
  const topbarTitle = state.activeTab === 'home' ? 'SALBUS' : formatTabLabel(state.activeTab).toUpperCase()
  const topbarTitleClass = 'topbar-title adaptive'

  appRoot.innerHTML = `
    <div class="app-shell">
      <header class="topbar ${bannerClass}">
        <button id="menu-toggle" class="icon-circle" type="button" aria-label="Abrir menú">☰</button>
        <div class="topbar-copy">
          <h1 class="${topbarTitleClass}">${escapeHtml(topbarTitle)}</h1>
        </div>
        <div class="topbar-status">
          <span class="topbar-clock">${escapeHtml(formatTimeOnly(new Date()))}</span>
          <span class="cooldown-badge" title="Tiempo restante para poder actualizar manualmente">${escapeHtml(cooldownDisplay)}</span>
        </div>
      </header>

      <div class="app-layout">
        <aside class="side-menu ${state.menuOpen ? 'open' : ''}">
          <div class="side-menu-head">
            <div class="side-menu-brand">
              <div>
                <strong class="side-menu-app-name">SALBUS</strong>
                <p class="side-menu-description">Sistema de información de autobuses urbanos de Salamanca.</p>
              </div>
              <button id="menu-close" class="menu-close-btn cooldown-badge" type="button" aria-label="Cerrar menú">✕</button>
            </div>
          </div>
          <nav class="side-nav" aria-label="Navegación principal">
            ${renderTabButton('home', '01 · Inicio')}
            ${renderTabButton('inicio', '02 · Buscar parada')}
            ${renderTabButton('hub', '03 · Mis líneas')}
            ${renderTabButton('monitorizacion', '04 · Monitorización de líneas')}
            ${renderTabButton('localizador', '05 · Seguimiento')}
            ${renderTabButton('estado', '06 · Ajustes y permisos')}
            ${renderTabButton('registros', '07 · Registros')}
          </nav>
          <p class="menu-version">SALBUS ${escapeHtml(APP_BUILD_VERSION)}</p>
        </aside>

        <button id="menu-backdrop" class="menu-backdrop ${state.menuOpen ? 'open' : ''}" type="button" aria-label="Cerrar menú"></button>

        <main class="content-column">
          ${state.error ? `<section class="error-banner">⚠ ${escapeHtml(state.error)}</section>` : ''}

          ${state.activeTab === 'home'
            ? renderHomeTab()
            : state.activeTab === 'inicio'
              ? renderInicioTab(stopMatches, selectedStop, selectedDepartures, routeDirectionOptions)
            : state.activeTab === 'hub'
              ? renderHubTab(dataset)
              : state.activeTab === 'monitorizacion'
                ? renderMonitorizacionTab(dataset)
                : state.activeTab === 'localizador'
                  ? renderLocalizadorTab(dataset)
                  : state.activeTab === 'registros'
                    ? renderRegistrosTab()
                    : renderEstadoTab(dataset)
          }
        </main>
      </div>
      ${renderActionModal()}
      ${renderMonitoringIntervalModal()}
    </div>
  `

  bindEvents()
}

function renderHomeTab(): string {
  const quickCards: Array<{ tabId: TabId, title: string }> = [
    { tabId: 'inicio', title: 'BUSCAR PARADA' },
    { tabId: 'hub', title: 'MIS LÍNEAS' },
    { tabId: 'monitorizacion', title: 'MONITORIZACIÓN' },
    { tabId: 'localizador', title: 'SEGUIMIENTO' },
  ]

  return `
    <section class="panel home-panel">
      <div class="panel-head">
        <p class="panel-copy">SALBUS es una versión mejorada del sistema original para consultar y seguir líneas urbanas con más contexto y control.</p>
      </div>
      <div class="home-grid">
        ${quickCards.map((card) => `
          <button class="home-tile" type="button" data-tab-id="${card.tabId}">
            <strong>${escapeHtml(card.title)}</strong>
          </button>
        `).join('')}
      </div>
    </section>
  `
}

function renderInicioTab(
  stopMatches: StopOption[],
  selectedStop: StopOption | null,
  departures: DepartureInsight[],
  routeDirectionOptions: RouteDirectionOption[],
): string {
  const selectedDirection = routeDirectionOptions.find((option) => option.key === state.inicioRouteDirectionKey) ?? routeDirectionOptions[0] ?? null
  const selectedMapDirection = routeDirectionOptions.find((option) => option.key === state.inicioMapRouteShortName)
    ?? routeDirectionOptions[0]
    ?? null
  const routeStops = selectedDirection ? getStopsForRouteDirection(selectedDirection) : []
  const mapStops = selectedMapDirection ? getStopsForRouteDirection(selectedMapDirection) : []
  const routeStopSelected = routeStops.some((item) => item.stopId === state.selectedStopId)

  return `
    <section class="panel">
      <div class="panel-head">
        <div>
          <h2>Buscar parada</h2>
        </div>
        <p class="panel-copy">Busca por parada, por línea/sentido o desde mapa, y registra tus favoritas en Mis líneas.</p>
      </div>
      ${state.loading ? `
        <div class="loading-area">
          <div class="loading-bar"></div>
          <p class="loading-phase">${escapeHtml(state.phase)}</p>
        </div>
      ` : ''}
      <div class="search-stack">
        <div class="search-mode-switch" role="tablist" aria-label="Modo de búsqueda">
          <button id="search-mode-stop" class="button-secondary ${state.inicioSearchMode === 'stop' ? 'active-search-mode' : ''}" type="button">Por parada</button>
          <button id="search-mode-route" class="button-secondary ${state.inicioSearchMode === 'route' ? 'active-search-mode' : ''}" type="button">Por línea</button>
          <button id="search-mode-map" class="button-secondary ${state.inicioSearchMode === 'map' ? 'active-search-mode' : ''}" type="button">Por mapa</button>
        </div>

        ${state.inicioSearchMode === 'stop' ? `
        <label class="field" for="stop-search">
          <span>Buscar parada</span>
          <div class="search-inline">
            <input id="stop-search" name="stop-search" type="search" placeholder="Escribe nombre o código de parada" value="${escapeHtml(state.stopSearchDraft)}" />
            <button id="apply-stop-search" class="icon-circle solid" type="button" aria-label="Buscar parada">🔎</button>
          </div>
        </label>
        ` : ''}

        ${state.inicioSearchMode === 'route' ? `
        <label class="field" for="route-direction-select">
          <span>Selecciona línea y sentido</span>
          <select id="route-direction-select" name="route-direction-select">
            ${routeDirectionOptions.map((routeOption) => `
              <option value="${escapeHtml(routeOption.key)}" ${routeOption.key === selectedDirection?.key ? 'selected' : ''}>${escapeHtml(routeOption.label)}</option>
            `).join('')}
          </select>
        </label>
        ` : ''}

        ${state.inicioSearchMode === 'map' ? `
        <label class="field" for="map-route-select">
          <span>Selecciona línea y sentido</span>
          <select id="map-route-select" name="map-route-select">
            ${routeDirectionOptions.map((routeOption) => `
              <option value="${escapeHtml(routeOption.key)}" ${routeOption.key === selectedMapDirection?.key ? 'selected' : ''}>${escapeHtml(routeOption.label)}</option>
            `).join('')}
          </select>
        </label>
        <div class="map-shell">
          <div id="inicio-map" class="inicio-map" aria-label="Mapa de paradas por línea"></div>
          ${mapStops.length === 0 ? '<p class="empty-state">No hay paradas disponibles para este sentido.</p>' : `<p class="slider-help">Pulsa un pin para seleccionar una parada y mostrar su nombre.</p>`}
        </div>
        ` : ''}

        <label class="field" for="stop-select">
          <span>Opciones disponibles</span>
          <select id="stop-select" name="stop-select">
            <option value="" disabled ${state.selectedStopId ? '' : 'selected'} hidden>Selecciona una parada...</option>
            ${(state.inicioSearchMode === 'route' ? routeStops : state.inicioSearchMode === 'map' ? mapStops : stopMatches).map((stop) => `
              <option value="${stop.stopId}" ${stop.stopId === state.selectedStopId ? 'selected' : ''}>
                ${escapeHtml(`${stop.stopName} · ${stop.stopId}`)}
              </option>
            `).join('')}
          </select>
        </label>

        ${state.inicioSearchMode === 'route' && !routeStopSelected && routeStops[0]
          ? `<p class="slider-help">Selecciona manualmente una parada de la línea para cargar llegadas.</p>`
          : ''}
      </div>

      <section class="stop-card start-combined-card">
        ${selectedStop ? `
        <div>
          <h3>${escapeHtml(selectedStop.stopName)}</h3>
          <p>${escapeHtml(`Parada ${selectedStop.stopId}`)}</p>
        </div>
        <div class="list-block">
          <div class="list-head">
            <h3>Próximas llegadas</h3>
            <span class="badge">${departures.length} eventos</span>
          </div>
          <div class="departure-list">
            ${renderDepartureList(departures, 'No hay llegadas de información en tiempo real para esta parada.')}
          </div>
        </div>
        ` : '<p class="empty-state">Selecciona una parada para ver sus próximas llegadas.</p>'}
      </section>

      <div class="button-row centered wrap">
        <button id="save-selected-stop" class="button-secondary" type="button" ${selectedStop ? '' : 'disabled'}>
          Registrar parada
        </button>
        <button id="refresh-selected-stop" class="button-primary" type="button" ${!canUseManualRefresh() ? 'disabled' : ''}>
          Actualizar
        </button>
      </div>
      ${renderRefreshTag(state.lastRefreshAt)}
    </section>
  `
}

function renderHubTab(dataset: GtfsDataset | null): string {
  const hubStops = dataset
    ? state.hubStopIds
      .map((stopId) => dataset.stopMap.get(stopId) ?? null)
      .filter((stop): stop is StopOption => stop !== null)
    : []

  return `
    <section class="panel">
      <div class="panel-head">
        <div>
          <h2>Mis líneas</h2>
        </div>
        <p class="panel-copy">Localiza fácilmente tus paradas favoritas; los tiempos se actualizan automáticamente cuando activas una parada.</p>
      </div>

      <section class="hub-grid">
        ${hubStops.map((stop) => renderHubStopCard(stop)).join('') || '<article class="empty-state-card">No hay paradas registradas todavía. Añade una desde Buscar parada.</article>'}
      </section>

      ${renderRefreshTag(state.hubLastUpdatedAt)}
    </section>
  `
}

function renderHubStopCard(stop: StopOption): string {
  const customName = state.hubCustomNamesByStopId[stop.stopId]?.trim()
  const displayName = customName || stop.stopName
  const departures = getDeparturesForStop(stop.stopId, 8)
  const uniqueRoutes = Array.from(new Set(departures.map((item) => item.routeShortName))).slice(0, 10)

  const selectedRoute = state.trackingRouteChoiceByStop[stop.stopId] ?? uniqueRoutes[0] ?? ''
  if (selectedRoute && !state.trackingRouteChoiceByStop[stop.stopId]) {
    state.trackingRouteChoiceByStop[stop.stopId] = selectedRoute
  }

  const monitoringRoute = state.monitoringRouteChoiceByStop[stop.stopId] ?? uniqueRoutes[0] ?? ''
  if (monitoringRoute && !state.monitoringRouteChoiceByStop[stop.stopId]) {
    state.monitoringRouteChoiceByStop[stop.stopId] = monitoringRoute
  }

  const locatorRoute = state.locatorRouteChoiceByStop[stop.stopId] ?? uniqueRoutes[0] ?? ''
  if (locatorRoute && !state.locatorRouteChoiceByStop[stop.stopId]) {
    state.locatorRouteChoiceByStop[stop.stopId] = locatorRoute
  }

  const monitoringRange = state.monitoringRangeByStop[stop.stopId] ?? { startMinutes: 7 * 60, endMinutes: 8 * 60 }
  if (!state.monitoringRangeByStop[stop.stopId]) {
    state.monitoringRangeByStop[stop.stopId] = monitoringRange
  }

  const currentTracker = getTrackerByStop(stop.stopId)
  const hubCardExpanded = Boolean(state.expandedHubCardByStop[stop.stopId])

  return `
    <article class="hub-card">
      <div class="list-head">
        <div class="list-head clickable-head" role="button" tabindex="0" data-toggle-hub-card-stop-id="${stop.stopId}" aria-expanded="${hubCardExpanded ? 'true' : 'false'}" aria-label="${hubCardExpanded ? 'Plegar' : 'Desplegar'} detalles de parada">
          <h3>${escapeHtml(displayName)}</h3>
          ${hubCardExpanded
            ? `<p>${escapeHtml(`Parada ${stop.stopId}`)}</p>${customName ? `<p class="hub-original-name">${escapeHtml(stop.stopName)}</p>` : ''}`
            : `<p class="hub-card-routes">${uniqueRoutes.slice(0, 6).map((r) => renderRouteShortNameBadgeCompact(r)).join('') || escapeHtml(stop.stopId)}</p>${customName ? `<p class="hub-original-name">${escapeHtml(stop.stopName)}</p>` : ''}`
          }
        </div>
        <div class="list-head-end">
          <button class="button-ghost delete-btn delete-icon-btn" type="button" data-edit-stop-id="${stop.stopId}" aria-label="Editar nombre de parada">
            <span aria-hidden="true">✎</span>
          </button>
          <button class="button-ghost delete-btn delete-icon-btn" type="button" data-remove-stop-id="${stop.stopId}" aria-label="Eliminar parada">
            <span aria-hidden="true">🗑</span>
          </button>
        </div>
      </div>

      ${hubCardExpanded ? `
        <div class="button-row compact wrap">
          <button class="icon-circle small-icon auto-refresh-toggle ${state.hubAutoRefreshStopId === stop.stopId ? 'auto-enabled' : 'auto-disabled'}" type="button" data-toggle-hub-auto-refresh-stop-id="${stop.stopId}" aria-label="Actualizar automáticamente">
            ⏲
          </button>
          <button class="icon-circle solid small-icon" type="button" data-refresh-hub-stop-id="${stop.stopId}" aria-label="Actualizar parada" ${!canUseManualRefresh() ? 'disabled' : ''}>↻</button>
        </div>

        <p class="slider-help">Intervalo monitorización: ${escapeHtml(formatMinutesToClock(monitoringRange.startMinutes))} - ${escapeHtml(formatMinutesToClock(monitoringRange.endMinutes))}.</p>

        ${currentTracker ? `
          <p class="tracking-state">Seguimiento activo · ${renderRouteShortNameBadge(currentTracker.routeShortName)} — ${escapeHtml(buildTrackerStateText(currentTracker))}</p>
        ` : ''}

        <div class="departure-list">
          ${renderDepartureList(departures, 'Sin llegadas de información en tiempo real para esta parada.')}
        </div>

        <div class="button-row wrap compact action-row-below-events">
          <button class="button-primary action-unified" type="button" data-toggle-tracking-stop-id="${stop.stopId}">Próximo bus</button>
          <button class="button-primary action-unified" type="button" data-toggle-monitoring-stop-id="${stop.stopId}">Monitorizar línea</button>
          <button class="button-primary action-unified" type="button" data-toggle-locator-stop-id="${stop.stopId}">Localizar bus</button>
          ${currentTracker ? `<button class="button-secondary" type="button" data-stop-tracking-key="${currentTracker.key}">Detener</button>` : ''}
        </div>
      ` : ''}
    </article>
  `
}

function renderLocalizadorTab(dataset: GtfsDataset | null): string {
  const cards = state.locators.map((locator) => {
    const windowStops = getLocatorWindowStops(dataset, locator)
    const statusByStopId = getSeguimientoStatusByStop(locator, windowStops)

    return `
      <article class="hub-card monitoring-card">
        <div class="list-head">
          <div>
            <p class="kicker">Seguimiento activo</p>
            <h3>${escapeHtml(locator.stopName)}</h3>
            <p>${renderRouteShortNameBadge(locator.routeShortName)}</p>
          </div>
          <button class="button-ghost delete-btn delete-icon-btn" type="button" data-remove-locator-id="${locator.id}" aria-label="Eliminar seguimiento">
            <span aria-hidden="true">🗑</span>
          </button>
        </div>

        <p class="tracking-state">Se muestran 10 paradas alrededor de la registrada con su tiempo de llegada para esta línea. Verde = parada detectada de llegada inminente (<=1 min).</p>

        <div class="monitoring-table-wrap">
          <table class="monitoring-table locator-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Parada</th>
                <th>Llegada</th>
              </tr>
            </thead>
            <tbody>
              ${windowStops.map((stop, index) => `
                <tr class="${statusByStopId[stop.stopId]?.detected ? 'locator-arriving-row' : ''} ${stop.stopId === locator.stopId ? 'locator-registered-row' : ''}">
                  <td>${index + 1}</td>
                  <td>${escapeHtml(stop.stopName)}</td>
                  <td>${escapeHtml(renderSeguimientoMinutes(locator.id, stop.stopId, statusByStopId[stop.stopId]?.minutes ?? null))}</td>
                </tr>
              `).join('') || `
                <tr>
                  <td colspan="3">No se pudo construir la ruta para esta línea.</td>
                </tr>
              `}
            </tbody>
          </table>
        </div>
      </article>
    `
  })

  return `
    <section class="panel">
      <div class="panel-head">
        <div>
          <h2>Seguimiento</h2>
        </div>
        <p class="panel-copy">Para cada línea registrada se estima la zona de paso observando paradas cercanas y tiempos en tiempo real.</p>
      </div>
      <section class="hub-grid">
        ${cards.join('') || '<article class="empty-state-card">No hay líneas en seguimiento. Registra alguna desde Mis líneas.</article>'}
      </section>
      ${renderRefreshTag(state.locatorLastUpdatedAt)}
    </section>
  `
}

function renderEstadoTab(_dataset: GtfsDataset | null): string {
  const permissionCards = buildPermissionCards()

  return `
    <section class="panel">
      <div class="panel-head compact-title">
        <h2>Ajustes y permisos</h2>
        <p class="panel-copy">Configura la fuente de datos y verifica permisos para un seguimiento estable.</p>
      </div>

      <section class="status-actual-card settings-status-card">
        <div class="panel-head compact-title">
          <h3>Fuente de información</h3>
          <p class="panel-copy">La app usa exclusivamente datos de tiempo real y fallback desde el proxy.</p>
        </div>
        <p class="tracking-state">Modo activo: TIEMPO REAL / FALLBACK.</p>
      </section>

      <section class="status-actual-card settings-status-card">
        <div class="panel-head compact-title">
          <h3>Permisos necesarios</h3>
          <p class="panel-copy">Verifica permisos para asegurar seguimiento y monitorización estables.</p>
        </div>
        <div class="permission-grid permission-grid-tiles">
          ${permissionCards.map((permission) => `
            <section class="permission-item metric-tile">
              <div class="permission-head">
                <strong>${escapeHtml(permission.title)}</strong>
                <span class="permission-state permission-${permission.state}">${escapeHtml(formatPermissionState(permission.state))}</span>
              </div>
              <p>${escapeHtml(permission.description)}</p>
            </section>
          `).join('')}
        </div>
      </section>
    </section>
  `
}

function renderRegistrosTab(): string {
  const updates = state.settingsUpdates.slice().reverse()
  const errors = updates.filter((e) => e.status === 'error')
  const realtimeFailures = state.realtimeFailures.slice().reverse()
  const monitoringAvgFailures = state.monitoringAverageFailures.slice().reverse()

  return `
    <section class="panel">
      <div class="panel-head">
        <div>
          <h2>Registros</h2>
        </div>
        <p class="panel-copy">Historial de actualizaciones y causas por las que puede faltar tiempo real o medias en monitorización.</p>
      </div>

      <div class="log-grid">
        <div class="log-panel">
          <h3>Actualizaciones</h3>
          <div class="log-list">
            ${updates.map((entry) => `
              <div class="log-entry">
                <div class="log-meta"><strong>${escapeHtml(formatTimeOnly(new Date(entry.at)))}</strong> · <span class="pill">${escapeHtml(formatSettingsUpdateSource(entry.source))}</span> · <span class="pill">${escapeHtml(formatTabLabel(entry.tab))}</span></div>
                <div class="log-detail">${escapeHtml(entry.action)} — ${escapeHtml(entry.detail)}</div>
              </div>
            `).join('') || '<p class="empty-state">Sin registros todavía.</p>'}
          </div>
        </div>

        <div class="log-panel">
          <h3>Errores</h3>
          <div class="log-list">
            ${errors.map((entry) => `
              <div class="log-entry error">
                <div class="log-meta"><strong>${escapeHtml(formatTimeOnly(new Date(entry.at)))}</strong> · <span class="pill">${escapeHtml(formatTabLabel(entry.tab))}</span></div>
                <div class="log-detail">${escapeHtml(entry.detail)}</div>
              </div>
            `).join('') || '<p class="empty-state">Sin errores registrados.</p>'}
          </div>
        </div>

        <div class="log-panel">
          <h3>Fallos de tiempo real</h3>
          <div class="log-list">
            ${realtimeFailures.map((entry) => `
              <div class="log-entry error">
                <div class="log-meta"><strong>${escapeHtml(formatTimeOnly(new Date(entry.at)))}</strong> · <span class="pill">${escapeHtml(formatTabLabel(entry.tab))}</span></div>
                <div class="log-detail"><strong>${escapeHtml(entry.reason)}</strong> — ${escapeHtml(entry.detail)}</div>
              </div>
            `).join('') || '<p class="empty-state">Sin fallos realtime registrados.</p>'}
          </div>
        </div>

        <div class="log-panel">
          <h3>Fallos de media en monitorización</h3>
          <div class="log-list">
            ${monitoringAvgFailures.map((entry) => `
              <div class="log-entry error">
                <div class="log-meta"><strong>${escapeHtml(formatTimeOnly(new Date(entry.at)))}</strong> · <span class="pill">${escapeHtml(formatTabLabel(entry.tab))}</span></div>
                <div class="log-detail"><strong>${escapeHtml(entry.reason)}</strong> — ${escapeHtml(entry.detail)}</div>
              </div>
            `).join('') || '<p class="empty-state">Sin fallos de media registrados.</p>'}
          </div>
        </div>
      </div>
    </section>
  `
}

function renderMonitorizacionTab(dataset: GtfsDataset | null): string {
  const cards = state.monitorings.map((monitoring) => {
    const selectedDayType = state.monitoringDayTypeViewById[monitoring.id] ?? getDayTypeFromDate(new Date())
    const scheduledTimes = getMonitoringScheduledTimes(dataset, monitoring, selectedDayType)
    const averagesByDay = state.monitoringStatsById[monitoring.id] ?? buildEmptyMonitoringStatsByDay()
    const averages = averagesByDay[selectedDayType] ?? {}

    const monCardExpanded = Boolean(state.expandedMonitoringCardById[monitoring.id])
    return `
      <article class="hub-card monitoring-card">
        <div class="list-head">
          <div class="list-head clickable-head" role="button" tabindex="0" data-toggle-monitoring-card-id="${monitoring.id}" aria-expanded="${monCardExpanded ? 'true' : 'false'}" aria-label="${monCardExpanded ? 'Plegar' : 'Desplegar'} monitorizacion">
            <h3>${escapeHtml(monitoring.stopName)}</h3>
            <p>${renderRouteShortNameBadge(monitoring.routeShortName)} · ${escapeHtml(`${formatMinutesToClock(monitoring.startMinutes)}-${formatMinutesToClock(monitoring.endMinutes)}`)}</p>
          </div>
          <div class="list-head-end">
            <button class="button-ghost delete-btn delete-icon-btn" type="button" data-remove-monitoring-id="${monitoring.id}" aria-label="Eliminar monitorizacion">
              <span aria-hidden="true">🗑</span>
            </button>
          </div>
        </div>

        ${monCardExpanded ? `
        <p class="tracking-state">Actualización fija: cada 30 s</p>

        <label class="field slim" for="monitoring-day-${monitoring.id}">
          <span>Tipo de día</span>
          <select id="monitoring-day-${monitoring.id}" data-monitoring-day-type-id="${monitoring.id}">
            <option value="weekday" ${selectedDayType === 'weekday' ? 'selected' : ''}>Diario (L-V)</option>
            <option value="saturday" ${selectedDayType === 'saturday' ? 'selected' : ''}>Sábado</option>
            <option value="sunday" ${selectedDayType === 'sunday' ? 'selected' : ''}>Domingo</option>
          </select>
        </label>

        <div class="monitoring-table-wrap">
          <table class="monitoring-table">
            <thead>
              <tr>
                <th>Hora prevista (GTFS)</th>
                <th>Hora real media</th>
              </tr>
            </thead>
            <tbody>
              ${scheduledTimes.map((slot) => {
                const row = averages[slot]
                const averageClock = row && row.count > 0
                  ? formatMinutesToClock(Math.round(row.sumMinutes / row.count))
                  : 'sin datos'
                const rangeText = row && row.count > 1
                  ? `${formatMinutesToClock(row.minMinutes)} - ${formatMinutesToClock(row.maxMinutes)}`
                  : ''

                return `
                  <tr>
                    <td>${escapeHtml(slot)}</td>
                    <td>
                      <span class="sample-cell">
                        <span>${escapeHtml(averageClock)}</span>
                        ${row && row.count > 1 ? `
                          <button
                            type="button"
                            class="sample-sup ${state.openSampleTooltipId === `${monitoring.id}|${slot}` ? 'tooltip-open' : ''}"
                            data-range="Rango ${escapeHtml(rangeText)}"
                            data-sample-tooltip-id="${monitoring.id}|${slot}"
                            aria-label="${escapeHtml(`Rango de llegadas ${rangeText}`)}"
                          >${row.count}</button>
                        ` : ''}
                      </span>
                    </td>
                  </tr>
                `
              }).join('') || `
                <tr>
                  <td colspan="2">Sin pasos programados para esta línea en el intervalo elegido.</td>
                </tr>
              `}
            </tbody>
          </table>
        </div>
        ` : ''}
      </article>
    `
  })

  return `
    <section class="panel">
      <div class="panel-head">
        <div>
          <h2>Monitorización de líneas</h2>
        </div>
        <p class="panel-copy">Las líneas registradas se evalúan para detectar paso real y calcular medias históricas.</p>
      </div>
      <section class="hub-grid">
        ${cards.join('') || '<article class="empty-state-card">No hay líneas monitorizadas todavía. Registra alguna desde Mis líneas.</article>'}
      </section>
      ${renderRefreshTag(state.monitoringLastUpdatedAt)}
      <p class="tab-footnote">Nota: en Android, la ejecución real en segundo plano depende del sistema y de sus políticas de ahorro de batería.</p>
    </section>
  `
}

function bindEvents(): void {
  document.querySelector<HTMLButtonElement>('#menu-toggle')?.addEventListener('click', () => {
    state.menuOpen = !state.menuOpen
    render()
  })

  document.querySelector<HTMLButtonElement>('#menu-backdrop')?.addEventListener('click', () => {
    state.menuOpen = false
    render()
  })

  document.querySelector<HTMLButtonElement>('#menu-close')?.addEventListener('click', () => {
    state.menuOpen = false
    render()
  })

  document.querySelectorAll<HTMLButtonElement>('[data-tab-id]').forEach((button) => {
    button.addEventListener('click', () => {
      state.activeTab = (button.dataset.tabId as TabId | undefined) ?? 'home'
      if (state.activeTab === 'hub') {
        state.expandedHubCardByStop = {}
      }
      if (state.activeTab === 'monitorizacion') {
        state.expandedMonitoringCardById = {}
      }
      state.menuOpen = false
      setupAutoRefresh()
      if (state.activeTab === 'localizador') {
        void refreshArrivals('auto', true)
      }
      render()
    })
  })

  document.querySelector<HTMLButtonElement>('#search-mode-stop')?.addEventListener('click', () => {
    state.inicioSearchMode = 'stop'
    render()
  })

  document.querySelector<HTMLButtonElement>('#search-mode-route')?.addEventListener('click', () => {
    state.inicioSearchMode = 'route'
    if (!state.inicioRouteDirectionKey) {
      state.inicioRouteDirectionKey = getRouteDirectionOptions()[0]?.key ?? ''
    }
    // Do not auto-select a stop when switching to route search; user must pick manually.
    render()
  })

  document.querySelector<HTMLButtonElement>('#search-mode-map')?.addEventListener('click', () => {
    state.inicioSearchMode = 'map'
    if (!state.inicioMapRouteShortName) {
      state.inicioMapRouteShortName = getRouteDirectionOptions()[0]?.key ?? ''
    }
    render()
  })

  document.querySelector<HTMLInputElement>('#stop-search')?.addEventListener('input', (event) => {
    const target = event.target as HTMLInputElement
    state.stopSearchDraft = target.value
  })

  document.querySelector<HTMLInputElement>('#stop-search')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      void applyStopSearch()
    }
  })

  document.querySelector<HTMLButtonElement>('#apply-stop-search')?.addEventListener('click', () => {
    void applyStopSearch()
  })

  document.querySelector<HTMLSelectElement>('#route-direction-select')?.addEventListener('change', (event) => {
    const target = event.target as HTMLSelectElement
    state.inicioRouteDirectionKey = target.value
    const selected = getRouteDirectionOptions().find((option) => option.key === target.value)
    state.inicioRouteShortName = selected?.routeShortName ?? ''
    // Keep the selection manual: do not auto-pick a stop when route changes.
    if (state.selectedStopId) {
      void triggerManualRefresh()
      return
    }
    render()
  })

  document.querySelector<HTMLSelectElement>('#map-route-select')?.addEventListener('change', (event) => {
    const target = event.target as HTMLSelectElement
    state.inicioMapRouteShortName = target.value
    render()
  })

  document.querySelector<HTMLSelectElement>('#stop-select')?.addEventListener('change', (event) => {
    const target = event.target as HTMLSelectElement
    state.selectedStopId = target.value || null

    if (!state.selectedStopId) {
      render()
      return
    }

    if (state.activeTab === 'inicio') {
      void triggerManualRefresh()
      return
    }

    void triggerManualRefresh()
    return
  })

  document.querySelector<HTMLButtonElement>('#refresh-selected-stop')?.addEventListener('click', () => {
    void triggerManualRefresh()
  })

  document.querySelector<HTMLButtonElement>('#save-selected-stop')?.addEventListener('click', () => {
    registerSelectedStop()
  })

  document.querySelectorAll<HTMLButtonElement>('[data-refresh-hub-stop-id]').forEach((button) => {
    button.addEventListener('click', () => {
      const stopId = button.dataset.refreshHubStopId
      if (!stopId) {
        return
      }

      state.selectedStopId = stopId
      void triggerManualRefresh()
    })
  })

  document.querySelectorAll<HTMLButtonElement>('[data-toggle-hub-auto-refresh-stop-id]').forEach((button) => {
    button.addEventListener('click', () => {
      const stopId = button.dataset.toggleHubAutoRefreshStopId
      if (!stopId) {
        return
      }

      state.hubAutoRefreshStopId = state.hubAutoRefreshStopId === stopId ? null : stopId
      setupAutoRefresh()
      render()
    })
  })

  document.querySelectorAll<HTMLSelectElement>('[data-tracking-route-stop-id]').forEach((select) => {
    select.addEventListener('change', () => {
      const stopId = select.dataset.trackingRouteStopId
      if (!stopId) {
        return
      }

      state.trackingRouteChoiceByStop[stopId] = select.value
    })
  })

  document.querySelectorAll<HTMLButtonElement>('[data-start-tracking-stop-id]').forEach((button) => {
    button.addEventListener('click', () => {
      const stopId = button.dataset.startTrackingStopId
      if (!stopId || !state.dataset) {
        return
      }

      const selectedRoute = state.trackingRouteChoiceByStop[stopId]
      const stopName = state.dataset.stopMap.get(stopId)?.stopName ?? stopId
      if (!selectedRoute) {
        return
      }

      void startTracking(stopId, stopName, selectedRoute)
    })
  })

  document.querySelectorAll<HTMLButtonElement>('[data-toggle-tracking-stop-id]').forEach((button) => {
    button.addEventListener('click', () => {
      const stopId = button.dataset.toggleTrackingStopId
      if (!stopId) {
        return
      }

      state.actionModal = { stopId, mode: 'tracking' }
      render()
    })
  })

  document.querySelectorAll<HTMLButtonElement>('[data-toggle-monitoring-stop-id]').forEach((button) => {
    button.addEventListener('click', () => {
      const stopId = button.dataset.toggleMonitoringStopId
      if (!stopId) {
        return
      }

      state.actionModal = { stopId, mode: 'monitoring' }
      if (!state.monitoringRangeByStop[stopId]) {
        state.monitoringRangeByStop[stopId] = { startMinutes: 7 * 60, endMinutes: 8 * 60 }
      }
      render()
    })
  })

  document.querySelectorAll<HTMLButtonElement>('[data-toggle-locator-stop-id]').forEach((button) => {
    button.addEventListener('click', () => {
      const stopId = button.dataset.toggleLocatorStopId
      if (!stopId) {
        return
      }

      state.actionModal = { stopId, mode: 'locator' }
      render()
    })
  })

  document.querySelector<HTMLButtonElement>('#action-modal-backdrop')?.addEventListener('click', () => {
    state.actionModal = null
    render()
  })

  document.querySelector<HTMLButtonElement>('#action-modal-close')?.addEventListener('click', () => {
    state.actionModal = null
    render()
  })

  document.querySelector<HTMLSelectElement>('#action-modal-route-select')?.addEventListener('change', (event) => {
    const modal = state.actionModal
    if (!modal) {
      return
    }

    const target = event.target as HTMLSelectElement
    if (modal.mode === 'tracking') {
      state.trackingRouteChoiceByStop[modal.stopId] = target.value
    } else if (modal.mode === 'monitoring') {
      state.monitoringRouteChoiceByStop[modal.stopId] = target.value
    } else {
      state.locatorRouteChoiceByStop[modal.stopId] = target.value
    }
    render()
  })

  document.querySelector<HTMLButtonElement>('#action-modal-open-interval')?.addEventListener('click', () => {
    const modal = state.actionModal
    if (!modal || modal.mode !== 'monitoring') {
      return
    }

    state.monitoringIntervalEditorStopId = modal.stopId
    render()
  })

  document.querySelector<HTMLButtonElement>('#action-modal-confirm')?.addEventListener('click', () => {
    const modal = state.actionModal
    if (!modal || !state.dataset) {
      return
    }

    const stop = state.dataset.stopMap.get(modal.stopId)
    if (!stop) {
      return
    }

    if (modal.mode === 'tracking') {
      const selectedRoute = state.trackingRouteChoiceByStop[modal.stopId]
      if (!selectedRoute) {
        return
      }

      state.actionModal = null
      void startTracking(stop.stopId, stop.stopName, selectedRoute)
      render()
      return
    }

    if (modal.mode === 'locator') {
      const selectedRoute = state.locatorRouteChoiceByStop[modal.stopId]
      if (!selectedRoute) {
        return
      }

      registerLocator(stop, selectedRoute)
      state.actionModal = null
      state.activeTab = 'localizador'
      setupAutoRefresh()
      render()
      return
    }

    const selectedRoute = state.monitoringRouteChoiceByStop[modal.stopId]
    const range = state.monitoringRangeByStop[modal.stopId] ?? { startMinutes: 7 * 60, endMinutes: 8 * 60 }
    if (!selectedRoute) {
      return
    }

    registerMonitoring(stop, selectedRoute, range.startMinutes, range.endMinutes)
    if (state.error) {
      render()
      return
    }

    state.actionModal = null
    state.activeTab = 'monitorizacion'
    state.expandedMonitoringCardById = {}
    render()
  })

  document.querySelectorAll<HTMLElement>('[data-toggle-hub-card-stop-id]').forEach((toggleTarget) => {
    const toggleAction = () => {
      const stopId = toggleTarget.dataset.toggleHubCardStopId
      if (!stopId) {
        return
      }

      state.expandedHubCardByStop[stopId] = !state.expandedHubCardByStop[stopId]
      render()
    }

    toggleTarget.addEventListener('click', (event) => {
      const target = event.target as Element
      if (target.closest('[data-remove-stop-id]')) {
        return
      }
      toggleAction()
    })

    toggleTarget.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') {
        return
      }
      event.preventDefault()
      toggleAction()
    })
  })

  document.querySelectorAll<HTMLElement>('[data-toggle-monitoring-card-id]').forEach((toggleTarget) => {
    const toggleAction = () => {
      const id = toggleTarget.dataset.toggleMonitoringCardId
      if (!id) {
        return
      }

      state.expandedMonitoringCardById[id] = !state.expandedMonitoringCardById[id]
      render()
    }

    toggleTarget.addEventListener('click', (event) => {
      const target = event.target as Element
      if (target.closest('[data-remove-monitoring-id]')) {
        return
      }
      toggleAction()
    })

    toggleTarget.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') {
        return
      }
      event.preventDefault()
      toggleAction()
    })
  })

  document.querySelectorAll<HTMLSelectElement>('[data-locator-route-stop-id]').forEach((select) => {
    select.addEventListener('change', () => {
      const stopId = select.dataset.locatorRouteStopId
      if (!stopId) {
        return
      }

      state.locatorRouteChoiceByStop[stopId] = select.value
    })
  })

  document.querySelectorAll<HTMLButtonElement>('[data-register-locator-stop-id]').forEach((button) => {
    button.addEventListener('click', () => {
      const stopId = button.dataset.registerLocatorStopId
      if (!stopId || !state.dataset) {
        return
      }

      const stop = state.dataset.stopMap.get(stopId)
      const routeShortName = state.locatorRouteChoiceByStop[stopId]
      if (!stop || !routeShortName) {
        return
      }

      registerLocator(stop, routeShortName)
      state.expandedLocatorByStop[stopId] = false
      state.activeTab = 'localizador'
      setupAutoRefresh()
      render()
    })
  })

  document.querySelectorAll<HTMLSelectElement>('[data-monitoring-route-stop-id]').forEach((select) => {
    select.addEventListener('change', () => {
      const stopId = select.dataset.monitoringRouteStopId
      if (!stopId) {
        return
      }

      state.monitoringRouteChoiceByStop[stopId] = select.value
    })
  })

  document.querySelectorAll<HTMLButtonElement>('[data-open-monitoring-interval-stop-id]').forEach((button) => {
    button.addEventListener('click', () => {
      const stopId = button.dataset.openMonitoringIntervalStopId
      if (!stopId) {
        return
      }

      state.monitoringIntervalEditorStopId = stopId
      if (!state.monitoringRangeByStop[stopId]) {
        state.monitoringRangeByStop[stopId] = { startMinutes: 7 * 60, endMinutes: 8 * 60 }
      }
      render()
    })
  })

  document.querySelector<HTMLButtonElement>('#monitoring-interval-modal-close')?.addEventListener('click', () => {
    state.monitoringIntervalEditorStopId = null
    render()
  })

  document.querySelector<HTMLButtonElement>('#monitoring-interval-modal-apply')?.addEventListener('click', () => {
    state.monitoringIntervalEditorStopId = null
    render()
  })

  document.querySelector<HTMLButtonElement>('#monitoring-interval-modal-backdrop')?.addEventListener('click', () => {
    state.monitoringIntervalEditorStopId = null
    render()
  })

  document.querySelector<HTMLInputElement>('#monitoring-start-slider')?.addEventListener('input', (event) => {
    const stopId = state.monitoringIntervalEditorStopId
    if (!stopId) {
      return
    }

    const target = event.target as HTMLInputElement
    const current = state.monitoringRangeByStop[stopId] ?? { startMinutes: 7 * 60, endMinutes: 8 * 60 }
    state.monitoringRangeByStop[stopId] = normalizeMonitoringRange(parseQuarterMinutes(target.value), current.endMinutes)
    render()
  })

  document.querySelector<HTMLInputElement>('#monitoring-end-slider')?.addEventListener('input', (event) => {
    const stopId = state.monitoringIntervalEditorStopId
    if (!stopId) {
      return
    }

    const target = event.target as HTMLInputElement
    const current = state.monitoringRangeByStop[stopId] ?? { startMinutes: 7 * 60, endMinutes: 8 * 60 }
    state.monitoringRangeByStop[stopId] = normalizeMonitoringRange(current.startMinutes, parseQuarterMinutes(target.value))
    render()
  })

  document.querySelector<HTMLInputElement>('#monitoring-start-time')?.addEventListener('change', (event) => {
    const stopId = state.monitoringIntervalEditorStopId
    if (!stopId) {
      return
    }

    const target = event.target as HTMLInputElement
    const current = state.monitoringRangeByStop[stopId] ?? { startMinutes: 7 * 60, endMinutes: 8 * 60 }
    state.monitoringRangeByStop[stopId] = normalizeMonitoringRange(parseTimeInputToQuarterMinutes(target.value), current.endMinutes)
    render()
  })

  document.querySelector<HTMLInputElement>('#monitoring-end-time')?.addEventListener('change', (event) => {
    const stopId = state.monitoringIntervalEditorStopId
    if (!stopId) {
      return
    }

    const target = event.target as HTMLInputElement
    const current = state.monitoringRangeByStop[stopId] ?? { startMinutes: 7 * 60, endMinutes: 8 * 60 }
    state.monitoringRangeByStop[stopId] = normalizeMonitoringRange(current.startMinutes, parseTimeInputToQuarterMinutes(target.value))
    render()
  })

  document.querySelectorAll<HTMLButtonElement>('[data-register-monitoring-stop-id]').forEach((button) => {
    button.addEventListener('click', () => {
      const stopId = button.dataset.registerMonitoringStopId
      if (!stopId || !state.dataset) {
        return
      }

      const stop = state.dataset.stopMap.get(stopId)
      const routeShortName = state.monitoringRouteChoiceByStop[stopId]
      const range = state.monitoringRangeByStop[stopId] ?? { startMinutes: 7 * 60, endMinutes: 8 * 60 }
      if (!stop || !routeShortName) {
        return
      }

      registerMonitoring(stop, routeShortName, range.startMinutes, range.endMinutes)
      if (state.error) {
        render()
        return
      }

      state.error = null
      state.expandedMonitoringByStop[stopId] = false
      state.activeTab = 'monitorizacion'
      state.expandedMonitoringCardById = {}
      render()
    })
  })

  document.querySelectorAll<HTMLButtonElement>('[data-stop-tracking-key]').forEach((button) => {
    button.addEventListener('click', () => {
      const key = button.dataset.stopTrackingKey
      if (!key) {
        return
      }

      void stopTracking(key)
    })
  })

  document.querySelectorAll<HTMLButtonElement>('[data-remove-stop-id]').forEach((button) => {
    button.addEventListener('click', () => {
      const stopId = button.dataset.removeStopId
      if (!stopId) {
        return
      }

      state.hubStopIds = state.hubStopIds.filter((candidate) => candidate !== stopId)
      state.locators = state.locators.filter((item) => item.stopId !== stopId)
      delete state.hubCustomNamesByStopId[stopId]
      persistStopIds(state.hubStopIds)
      persistLocators(state.locators)
      persistHubCustomNames(state.hubCustomNamesByStopId)
      render()
    })
  })

  document.querySelectorAll<HTMLButtonElement>('[data-edit-stop-id]').forEach((button) => {
    button.addEventListener('click', () => {
      const stopId = button.dataset.editStopId
      if (!stopId || !state.dataset) {
        return
      }

      const current = state.hubCustomNamesByStopId[stopId] ?? state.dataset.stopMap.get(stopId)?.stopName ?? ''
      const value = window.prompt('Nombre personalizado para la parada:', current)
      if (value === null) {
        return
      }

      const trimmed = value.trim()
      if (!trimmed) {
        delete state.hubCustomNamesByStopId[stopId]
      } else {
        state.hubCustomNamesByStopId[stopId] = trimmed
      }

      persistHubCustomNames(state.hubCustomNamesByStopId)
      render()
    })
  })

  document.querySelectorAll<HTMLButtonElement>('[data-remove-monitoring-id]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.dataset.removeMonitoringId
      if (!id) {
        return
      }

      state.monitorings = state.monitorings.filter((item) => item.id !== id)
      delete state.monitoringRuntimeById[id]
      delete state.monitoringStatsById[id]
      delete state.monitoringDayTypeViewById[id]
      persistMonitorings(state.monitorings)
      persistMonitoringStats(state.monitoringStatsById)
      render()
    })
  })

  document.querySelectorAll<HTMLSelectElement>('[data-monitoring-day-type-id]').forEach((select) => {
    select.addEventListener('change', () => {
      const id = select.dataset.monitoringDayTypeId
      if (!id) {
        return
      }

      state.monitoringDayTypeViewById[id] = parseServiceDayType(select.value)
      render()
    })
  })

  document.querySelectorAll<HTMLButtonElement>('[data-remove-locator-id]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.dataset.removeLocatorId
      if (!id) {
        return
      }

      state.locators = state.locators.filter((item) => item.id !== id)
      // Clean up sticky cache for removed locator
      for (const key of Object.keys(state.locatorStickyMinutes)) {
        if (key.startsWith(`${id}:`)) {
          delete state.locatorStickyMinutes[key]
        }
      }
      persistLocators(state.locators)
      setupAutoRefresh()
      render()
    })
  })

  document.querySelectorAll<HTMLButtonElement>('[data-sample-tooltip-id]').forEach((button) => {
    const tooltipId = button.dataset.sampleTooltipId
    if (!tooltipId) {
      return
    }

    let holdTimer: number | null = null
    const clearHoldTimer = () => {
      if (holdTimer !== null) {
        window.clearTimeout(holdTimer)
        holdTimer = null
      }
    }

    button.addEventListener('pointerdown', () => {
      clearHoldTimer()
      holdTimer = window.setTimeout(() => {
        state.openSampleTooltipId = tooltipId
        render()
      }, 500)
    })

    button.addEventListener('pointerup', clearHoldTimer)
    button.addEventListener('pointercancel', clearHoldTimer)
    button.addEventListener('pointerleave', clearHoldTimer)

    button.addEventListener('click', (event) => {
      event.stopPropagation()
      state.openSampleTooltipId = tooltipId
      render()
    })
  })

  appRoot.querySelector('.content-column')?.addEventListener('click', (event) => {
    const target = event.target as Element
    if (target.closest('[data-sample-tooltip-id]')) {
      return
    }

    if (state.openSampleTooltipId !== null) {
      state.openSampleTooltipId = null
      render()
    }
  })

  initInicioMapIfNeeded()
}

async function startTracking(stopId: string, stopName: string, routeShortName: string): Promise<void> {
  const existingKeys = Object.keys(state.trackingByKey)
  for (const existingKey of existingKeys) {
    await stopTracking(existingKey)
  }

  const key = `${stopId}|${routeShortName}`
  state.trackingByKey[key] = {
    key,
    stopId,
    stopName,
    routeShortName,
    armed: false,
    nearStreak: 0,
    missingStreak: 0,
    lastMinutes: null,
    lastUpdateAt: Date.now(),
    lastNotificationMinutes: null,
  }

  await pushLocalNotification(
    buildNotificationId(key),
    `🚌 SALBUS · Seguimiento activo · ${stopName}`,
    `Línea ${routeShortName} · ${getDirectionLabelForRoute(routeShortName)} · iniciando seguimiento · actualizado ${formatTimeOnly(new Date())}`,
  )

  await refreshArrivals('manual')
  render()
}

async function stopTracking(key: string): Promise<void> {
  if (!state.trackingByKey[key]) {
    return
  }

  delete state.trackingByKey[key]
  await cancelLocalNotification(buildNotificationId(key))
  render()
}

async function pushLocalNotification(id: number, title: string, body: string): Promise<void> {
  try {
    if (Capacitor.getPlatform() === 'web') {
      return
    }

    await LocalNotifications.schedule({
      notifications: [
        {
          id,
          title,
          body,
          ongoing: true,
          autoCancel: false,
        },
      ],
    })
  } catch {
    // Notifications are optional when plugin cannot post updates.
  }
}

async function cancelLocalNotification(id: number, delayMs = 0): Promise<void> {
  const cancelNow = async () => {
    try {
      if (Capacitor.getPlatform() === 'web') {
        return
      }

      await LocalNotifications.cancel({
        notifications: [{ id }],
      })
    } catch {
      // Ignore cancellation errors.
    }
  }

  if (delayMs <= 0) {
    await cancelNow()
    return
  }

  window.setTimeout(() => {
    void cancelNow()
  }, delayMs)
}

function buildNotificationId(value: string): number {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0
  }

  return Math.abs(hash % 2147480000) + 1
}

function getTrackerByStop(stopId: string): TrackingState | null {
  return Object.values(state.trackingByKey).find((tracker) => tracker.stopId === stopId) ?? null
}

function buildTrackerStateText(tracker: TrackingState): string {
  if (tracker.armed) {
    if (tracker.lastMinutes === null) {
      return 'esperando confirmación de paso'
    }

    return tracker.lastMinutes <= PASS_NEAR_THRESHOLD_MIN
      ? 'bus muy cercano'
      : `último valor ${tracker.lastMinutes} min`
  }

  if (tracker.lastMinutes === null) {
    return 'esperando llegada cercana'
  }

  return `último valor ${tracker.lastMinutes} min`
}

function registerMonitoring(stop: StopOption, routeShortName: string, startMinutes: number, endMinutes: number): void {
  const range = normalizeMonitoringRange(startMinutes, endMinutes)
  const duration = range.endMinutes - range.startMinutes

  if (duration < 15) {
    setTransientError('Cada monitorización debe tener al menos 15 minutos.')
    return
  }

  if (duration > 60) {
    setTransientError('El rango máximo de monitorización es de 1 hora.')
    return
  }

  if (state.monitorings.some((item) => item.startMinutes === range.startMinutes && item.endMinutes === range.endMinutes)) {
    setTransientError('No puede haber dos monitorizaciones en el mismo rango horario.')
    return
  }

  const id = `${stop.stopId}|${routeShortName}|${range.startMinutes}|${range.endMinutes}`
  const existing = state.monitorings.find((item) => item.id === id)
  if (existing) {
    setTransientError('Esa monitorización ya existe.')
    return
  }

  if (state.monitorings.length >= 2) {
    const replacementId = chooseMonitoringToReplace()
    if (!replacementId) {
      setTransientError('Debes elegir una monitorización previa para reemplazar.')
      return
    }

    state.monitorings = state.monitorings.filter((item) => item.id !== replacementId)
    delete state.monitoringRuntimeById[replacementId]
    delete state.monitoringStatsById[replacementId]
    delete state.monitoringDayTypeViewById[replacementId]
  }

  state.monitorings = [
    ...state.monitorings,
    {
      id,
      stopId: stop.stopId,
      stopName: stop.stopName,
      routeShortName,
      startMinutes: range.startMinutes,
      endMinutes: range.endMinutes,
    },
  ]

  state.monitoringDayTypeViewById[id] = getDayTypeFromDate(new Date())

  persistMonitorings(state.monitorings)
  persistMonitoringStats(state.monitoringStatsById)
}

function registerLocator(stop: StopOption, routeShortName: string): void {
  const id = `${stop.stopId}|${routeShortName}`
  if (state.locators.some((item) => item.id === id)) {
    return
  }

  state.locators = [
    {
      id,
      stopId: stop.stopId,
      stopName: stop.stopName,
      routeShortName,
    },
  ]
  state.locatorStickyMinutes = {}

  persistLocators(state.locators)
}

function registerMonitoringPass(monitoring: MonitoringRegistration, detectedAt: Date): void {
  const dayType = getDayTypeFromDate(detectedAt)
  const scheduledTimes = getMonitoringScheduledTimes(state.dataset, monitoring, dayType)
  if (scheduledTimes.length === 0) {
    recordMonitoringAverageFailure(
      'Sin horarios GTFS en la ventana',
      `${monitoring.stopName} · línea ${monitoring.routeShortName} · día ${dayType}.`,
      'monitorizacion',
    )
    return
  }

  const slot = pickNearestSlot(scheduledTimes, detectedAt)
  if (!slot) {
    recordMonitoringAverageFailure(
      'Paso detectado sin slot asociable',
      `${monitoring.stopName} · línea ${monitoring.routeShortName}: no se encontró hora programada dentro de ±30 min.`,
      'monitorizacion',
    )
    return
  }

  const dayMinutes = detectedAt.getHours() * 60 + detectedAt.getMinutes()
  const dayKey = detectedAt.toISOString().slice(0, 10)
  const byDay = state.monitoringStatsById[monitoring.id] ?? buildEmptyMonitoringStatsByDay()
  const bySlot = byDay[dayType] ?? {}
  const current = bySlot[slot] ?? {
    count: 0,
    sumMinutes: 0,
    minMinutes: dayMinutes,
    maxMinutes: dayMinutes,
    perDayLatest: {},
  }

  const perDayLatest = {
    ...current.perDayLatest,
    [dayKey]: dayMinutes,
  }
  const perDayValues = Object.values(perDayLatest)
  const count = perDayValues.length
  const sumMinutes = perDayValues.reduce((sum, value) => sum + value, 0)

  bySlot[slot] = {
    count,
    sumMinutes,
    minMinutes: count > 0 ? Math.min(...perDayValues) : dayMinutes,
    maxMinutes: count > 0 ? Math.max(...perDayValues) : dayMinutes,
    perDayLatest,
  }

  byDay[dayType] = bySlot
  state.monitoringStatsById[monitoring.id] = byDay
  persistMonitoringStats(state.monitoringStatsById)
}

function getMonitoringScheduledTimes(
  dataset: GtfsDataset | null,
  monitoring: MonitoringRegistration,
  dayType: ServiceDayType,
): string[] {
  if (!dataset) {
    return []
  }

  const [startHour, endHour] = buildHourWindowFromMinuteRange(monitoring.startMinutes, monitoring.endMinutes)
  const candidateTimes = dataset.getScheduledTimesByDayType(
    monitoring.stopId,
    monitoring.routeShortName,
    dayType,
    startHour,
    endHour,
  )

  return candidateTimes.filter((clock) => {
    const slotMinutes = parseClockToMinutes(clock)
    return isMinuteInRange(slotMinutes, monitoring.startMinutes, monitoring.endMinutes)
  })
}

function pickNearestSlot(slots: string[], detectedAt: Date): string | null {
  if (slots.length === 0) {
    return null
  }

  const target = detectedAt.getHours() * 60 + detectedAt.getMinutes()
  return pickNearestSlotByMinutes(slots, target)
}

function pickNearestSlotByMinutes(slots: string[], target: number): string | null {
  if (slots.length === 0) {
    return null
  }

  let winner: string | null = null
  let minDelta = Number.POSITIVE_INFINITY

  for (const slot of slots) {
    const slotMinutes = parseClockToMinutes(slot)
    const delta = Math.abs(target - slotMinutes)
    if (delta < minDelta) {
      minDelta = delta
      winner = slot
    }
  }

  return minDelta <= 30 ? winner : null
}

function getObservedAverageForDeparture(departure: DepartureInsight): { averageClock: string, count: number, rangeText: string } | null {
  if (!departure.isRealtime || !departure.stopId) {
    return null
  }

  const dayType = getDayTypeFromDate(new Date())
  const targetMinutes = parseClockToMinutes(formatClock(departure.estimatedTime ?? departure.arrivalTime))

  let bestMatch: MonitoringAverageStats | null = null
  let bestDelta = Number.POSITIVE_INFINITY

  for (const monitoring of state.monitorings) {
    if (monitoring.stopId !== departure.stopId || monitoring.routeShortName !== departure.routeShortName) {
      continue
    }

    const slots = getMonitoringScheduledTimes(state.dataset, monitoring, dayType)
    const nearestSlot = pickNearestSlotByMinutes(slots, targetMinutes)
    if (!nearestSlot) {
      continue
    }

    const slotStats = state.monitoringStatsById[monitoring.id]?.[dayType]?.[nearestSlot]
    if (!slotStats || slotStats.count < 3) {
      continue
    }

    const delta = Math.abs(parseClockToMinutes(nearestSlot) - targetMinutes)
    if (delta < bestDelta) {
      bestDelta = delta
      bestMatch = slotStats
    }
  }

  if (!bestMatch) {
    return null
  }

  return {
    averageClock: formatMinutesToClock(Math.round(bestMatch.sumMinutes / bestMatch.count)),
    count: bestMatch.count,
    rangeText: `${formatMinutesToClock(bestMatch.minMinutes)} - ${formatMinutesToClock(bestMatch.maxMinutes)}`,
  }
}

function getLocatorWindowStops(dataset: GtfsDataset | null, locator: LocatorRegistration): Array<{ stopId: string, stopName: string }> {
  if (!dataset) {
    return []
  }

  const fullRoute = dataset.getRouteStops(locator.routeShortName, locator.stopId)
  if (fullRoute.length === 0) {
    return []
  }

  const pivotIndex = Math.max(0, fullRoute.findIndex((item) => item.stopId === locator.stopId))
  const maxCount = 10
  const left = 5
  const right = maxCount - left - 1
  let start = Math.max(0, pivotIndex - left)
  let end = Math.min(fullRoute.length, pivotIndex + right + 1)

  const currentSize = end - start
  if (currentSize < maxCount) {
    const missing = maxCount - currentSize
    start = Math.max(0, start - missing)
    end = Math.min(fullRoute.length, start + maxCount)
    start = Math.max(0, end - maxCount)
  }

  return fullRoute.slice(start, end)
}

function getSeguimientoStatusByStop(
  locator: LocatorRegistration,
  windowStops: Array<{ stopId: string, stopName: string }>,
): Record<string, { minutes: number | null, detected: boolean }> {
  const result: Record<string, { minutes: number | null, detected: boolean }> = {}
  if (windowStops.length === 0) {
    return result
  }

  const detectedIndexesByVehicle = new Map<string, number[]>()

  for (let index = 0; index < windowStops.length; index += 1) {
    const stop = windowStops[index]
    const departures = getDeparturesForStop(stop.stopId, 8)
      .filter((item) => item.isRealtime)
      .filter((item) => item.routeShortName === locator.routeShortName)
      .filter((item): item is DepartureInsight & { minutesUntil: number } => typeof item.minutesUntil === 'number')
      .sort((left, right) => left.minutesUntil - right.minutesUntil)

    const first = departures[0]
    result[stop.stopId] = {
      minutes: first?.minutesUntil ?? null,
      detected: false,
    }

    for (const departure of departures) {
      if (departure.minutesUntil > 1) {
        continue
      }

      const signature = buildLocatorVehicleSignature(departure)
      const existing = detectedIndexesByVehicle.get(signature) ?? []
      if (!existing.includes(index)) {
        existing.push(index)
        detectedIndexesByVehicle.set(signature, existing)
      }
    }
  }

  const detectedIndexes = new Set<number>()
  for (const indexes of detectedIndexesByVehicle.values()) {
    const sorted = [...indexes].sort((left, right) => left - right)
    let previousAccepted = Number.NEGATIVE_INFINITY
    for (const index of sorted) {
      if (index - previousAccepted <= 1) {
        continue
      }
      detectedIndexes.add(index)
      previousAccepted = index
    }
  }

  const filteredIndexes = [...detectedIndexes].sort((left, right) => left - right)
  const nonConsecutiveIndexes: number[] = []
  for (const index of filteredIndexes) {
    const previous = nonConsecutiveIndexes[nonConsecutiveIndexes.length - 1]
    if (typeof previous !== 'number' || index - previous > 1) {
      nonConsecutiveIndexes.push(index)
      continue
    }

    const previousStop = windowStops[previous]
    const currentStop = windowStops[index]
    const previousMinutes = previousStop ? (result[previousStop.stopId]?.minutes ?? Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY
    const currentMinutes = currentStop ? (result[currentStop.stopId]?.minutes ?? Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY
    if (currentMinutes < previousMinutes) {
      nonConsecutiveIndexes[nonConsecutiveIndexes.length - 1] = index
    }
  }

  for (const index of nonConsecutiveIndexes) {
    const stop = windowStops[index]
    if (!stop) {
      continue
    }

    result[stop.stopId] = {
      minutes: result[stop.stopId]?.minutes ?? null,
      detected: true,
    }
  }

  return result
}

function updateLocatorStickyCache(): void {
  if (!state.dataset) {
    return
  }

  for (const locator of state.locators) {
    const windowStops = getLocatorWindowStops(state.dataset, locator)
    const statusByStop = getSeguimientoStatusByStop(locator, windowStops)

    for (const stop of windowStops) {
      const cacheKey = `${locator.id}:${stop.stopId}`
      const liveMinutes = statusByStop[stop.stopId]?.minutes ?? null

      if (liveMinutes !== null) {
        state.locatorStickyMinutes[cacheKey] = { minutes: liveMinutes, missCount: 0 }
      } else {
        const cached = state.locatorStickyMinutes[cacheKey]
        if (cached) {
          cached.missCount += 1
          if (cached.missCount >= SEGUIMIENTO_STICKY_MAX_MISSES) {
            delete state.locatorStickyMinutes[cacheKey]
          }
        }
      }
    }
  }
}

function renderSeguimientoMinutes(locatorId: string, stopId: string, liveMinutes: number | null): string {
  if (liveMinutes !== null) {
    return formatCountdown(liveMinutes)
  }

  const cacheKey = `${locatorId}:${stopId}`
  const cached = state.locatorStickyMinutes[cacheKey]
  if (cached && cached.missCount >= 1 && cached.missCount < SEGUIMIENTO_STICKY_MAX_MISSES) {
    return `${formatCountdown(cached.minutes)}*`
  }

  return formatCountdown(null)
}

function buildLocatorVehicleSignature(departure: DepartureInsight): string {
  const estimated = formatClock(departure.estimatedTime ?? departure.arrivalTime)
  const minuteBucket = typeof departure.minutesUntil === 'number' ? Math.max(0, Math.min(2, departure.minutesUntil)) : 'x'
  return [
    departure.tripId || 'no-trip',
    departure.routeShortName,
    departure.headsign,
    estimated,
    String(minuteBucket),
  ].join('|')
}

function getLocatorRealtimeStopIds(): string[] {
  if (!state.dataset || state.locators.length === 0) {
    return []
  }

  const result = new Set<string>()
  for (const locator of state.locators) {
    const stops = getLocatorWindowStops(state.dataset, locator)
    for (const stop of stops) {
      result.add(stop.stopId)
    }
  }

  return Array.from(result)
}

function hasMonitoringInActiveWindow(reference = new Date()): boolean {
  if (state.monitorings.length === 0) {
    return false
  }

  const nowMinutes = reference.getHours() * 60 + reference.getMinutes()
  return state.monitorings.some((monitoring) => isMinuteInRange(nowMinutes, monitoring.startMinutes, monitoring.endMinutes))
}

function getMonitoringRealtimeStopIds(reference = new Date()): string[] {
  if (state.monitorings.length === 0) {
    return []
  }

  const nowMinutes = reference.getHours() * 60 + reference.getMinutes()
  const stopIds = new Set<string>()
  for (const monitoring of state.monitorings) {
    if (isMinuteInRange(nowMinutes, monitoring.startMinutes, monitoring.endMinutes)) {
      stopIds.add(monitoring.stopId)
    }
  }

  return Array.from(stopIds)
}

function parseClockToMinutes(clock: string): number {
  const [hhRaw = '0', mmRaw = '0'] = clock.split(':')
  const hh = Number.parseInt(hhRaw, 10)
  const mm = Number.parseInt(mmRaw, 10)
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) {
    return 0
  }

  return hh * 60 + mm
}

function formatMinutesToClock(dayMinutes: number): string {
  const normalized = ((dayMinutes % (24 * 60)) + (24 * 60)) % (24 * 60)
  const hh = Math.floor(normalized / 60)
  const mm = normalized % 60
  return `${padHour(hh)}:${String(mm).padStart(2, '0')}`
}

function parseQuarterMinutes(value: string): number {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) {
    return 0
  }

  return clampQuarterMinutes(parsed)
}

function parseTimeInputToQuarterMinutes(value: string): number {
  const [hhRaw = '00', mmRaw = '00'] = value.split(':')
  const hh = Number.parseInt(hhRaw, 10)
  const mm = Number.parseInt(mmRaw, 10)
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) {
    return 0
  }

  return clampQuarterMinutes(hh * 60 + mm)
}

function clampQuarterMinutes(value: number): number {
  const quarter = Math.round(value / 15) * 15
  return Math.max(0, Math.min(1425, quarter))
}

function normalizeMonitoringRange(startMinutes: number, endMinutes: number): { startMinutes: number, endMinutes: number } {
  let start = clampQuarterMinutes(startMinutes)
  let end = clampQuarterMinutes(endMinutes)

  if (end <= start) {
    end = Math.min(1425, start + 15)
  }

  if (end <= start) {
    start = Math.max(0, end - 15)
  }

  if (end - start > 60) {
    end = start + 60
  }

  return { startMinutes: start, endMinutes: end }
}

function isMinuteInRange(valueMinutes: number, startMinutes: number, endMinutes: number): boolean {
  return valueMinutes >= startMinutes && valueMinutes < endMinutes
}

function buildHourWindowFromMinuteRange(startMinutes: number, endMinutes: number): [number, number] {
  const startHour = Math.floor(startMinutes / 60)
  const endHour = Math.max(startHour + 1, Math.ceil(endMinutes / 60))
  return [startHour, Math.min(24, endHour)]
}

function padHour(hour: number): string {
  return String(Math.max(0, Math.min(23, hour))).padStart(2, '0')
}

async function applyStopSearch(): Promise<void> {
  state.stopSearchApplied = state.stopSearchDraft.trim()
  const hasSelectedStop = Boolean(state.selectedStopId)

  if (state.dataMode !== 'gtfs' && hasSelectedStop) {
    await triggerManualRefresh()
    return
  }

  render()
}

function registerSelectedStop(): void {
  if (!state.selectedStopId || !state.dataset) {
    return
  }

  const selectedStop = state.dataset.stopMap.get(state.selectedStopId)
  if (!selectedStop) {
    return
  }

  if (state.hubStopIds.includes(selectedStop.stopId)) {
    state.activeTab = 'hub'
    state.expandedHubCardByStop = {}
    render()
    return
  }

  state.hubStopIds = [...state.hubStopIds, selectedStop.stopId]
  persistStopIds(state.hubStopIds)
  state.activeTab = 'hub'
  state.expandedHubCardByStop = {}
  render()
}

function setupAutoRefresh(): void {
  if (autoRefreshTimer !== null) {
    window.clearInterval(autoRefreshTimer)
  }

  autoRefreshTimer = window.setInterval(() => {
    if (state.refreshing) {
      return
    }

    const hasTracking = Object.keys(state.trackingByKey).length > 0
    const hasMonitoring = state.monitorings.length > 0
    const monitoringWindowActive = hasMonitoringInActiveWindow()
    const appVisible = document.visibilityState === 'visible'

    let shouldRefresh = false
    let targetIntervalSeconds = TRACKING_REFRESH_SECONDS

    if (!appVisible) {
      if (hasTracking) {
        shouldRefresh = true
        targetIntervalSeconds = TRACKING_REFRESH_SECONDS
      } else if (hasMonitoring && monitoringWindowActive) {
        shouldRefresh = true
        targetIntervalSeconds = MONITORING_REFRESH_SECONDS
      }
    } else if (hasTracking) {
      shouldRefresh = true
      targetIntervalSeconds = TRACKING_REFRESH_SECONDS
    } else if (state.activeTab === 'localizador' && state.locators.length > 0 && !hasTracking) {
      shouldRefresh = true
      targetIntervalSeconds = LOCATOR_REFRESH_SECONDS
    } else if (state.activeTab === 'monitorizacion' && hasMonitoring && monitoringWindowActive) {
      shouldRefresh = true
      targetIntervalSeconds = MONITORING_REFRESH_SECONDS
    } else if (state.activeTab === 'hub' && state.hubAutoRefreshStopId) {
      shouldRefresh = true
      targetIntervalSeconds = 1
      if (state.selectedStopId !== state.hubAutoRefreshStopId) {
        state.selectedStopId = state.hubAutoRefreshStopId
      }
    }

    if (!shouldRefresh) {
      return
    }

    const now = Date.now()
    if (state.activeTab === 'hub' && state.hubAutoRefreshStopId && now < getNextAllowedRefreshAt()) {
      return
    }

    const elapsedMs = now - lastAutoRefreshRunAt
    if (elapsedMs < targetIntervalSeconds * 1000) {
      return
    }

    lastAutoRefreshRunAt = now
    void refreshArrivals('auto')
  }, 1000)
}

function setupTopbarClockRefresh(): void {
  if (topbarClockTimer !== null) {
    window.clearInterval(topbarClockTimer)
  }

  topbarClockTimer = window.setInterval(() => {
    const clockElement = document.querySelector<HTMLElement>('.topbar-clock')
    if (clockElement) {
      clockElement.textContent = formatTimeOnly(new Date())
    }

    const cooldownElement = document.querySelector<HTMLElement>('.cooldown-badge')
    if (cooldownElement) {
      const remainingSeconds = getDisplayedCooldownSeconds()
      cooldownElement.textContent = remainingSeconds <= 0 ? '✔' : String(remainingSeconds)
    }

    const allowRefresh = canUseManualRefresh()
    document.querySelectorAll<HTMLButtonElement>('#refresh-selected-stop, [data-refresh-hub-stop-id]').forEach((button) => {
      button.disabled = !allowRefresh
    })
  }, TOPBAR_CLOCK_REFRESH_SECONDS * 1000)
}

function syncStoredStopsWithDataset(): void {
  if (!state.dataset) {
    return
  }

  state.hubStopIds = state.hubStopIds.filter((stopId) => state.dataset?.stopMap.has(stopId))
  state.locators = state.locators.filter((item) => state.dataset?.stopMap.has(item.stopId))
  for (const stopId of Object.keys(state.hubCustomNamesByStopId)) {
    if (!state.dataset.stopMap.has(stopId)) {
      delete state.hubCustomNamesByStopId[stopId]
    }
  }
  persistStopIds(state.hubStopIds)
  persistLocators(state.locators)
  persistHubCustomNames(state.hubCustomNamesByStopId)
}

function renderTabButton(tabId: TabId, label: string): string {
  return `
    <button
      class="nav-button ${state.activeTab === tabId ? 'active' : ''}"
      type="button"
      data-tab-id="${tabId}"
    >
      ${escapeHtml(label)}
    </button>
  `
}

function formatTabLabel(tabId: TabId): string {
  if (tabId === 'home') {
    return 'Inicio'
  }
  if (tabId === 'inicio') {
    return 'Buscar parada'
  }
  if (tabId === 'hub') {
    return 'Mis líneas'
  }
  if (tabId === 'monitorizacion') {
    return 'Monitorización de líneas'
  }
  if (tabId === 'localizador') {
    return 'Seguimiento'
  }
  if (tabId === 'registros') {
    return 'Registros'
  }
  return 'Ajustes y permisos'
}

function renderRefreshTag(value: Date | null): string {
  const refreshClock = value ? formatTimeOnly(value) : '--:--:--'
  return `<div class="refresh-wrap"><span class="refresh-tag">Última actualización: ${escapeHtml(refreshClock)}</span></div>`
}

function getGlobalUpdateCooldownSeconds(): number {
  return DEFAULT_GLOBAL_UPDATE_COOLDOWN_SECONDS
}

function getNextAllowedRefreshAt(): number {
  if (state.activeTab === 'inicio') {
    return state.manualRefreshCooldownUntil
  }

  const globalNext = lastUpdateEventAt + getGlobalUpdateCooldownSeconds() * 1000
  return Math.max(state.manualRefreshCooldownUntil, globalNext)
}

function getDisplayedCooldownSeconds(): number {
  const nextAllowedAt = getNextAllowedRefreshAt()
  const remainingMs = Math.max(0, nextAllowedAt - Date.now())
  return Math.ceil(remainingMs / 1000)
}

function canUseManualRefresh(): boolean {
  return Date.now() >= getNextAllowedRefreshAt()
}

function getManualRefreshCooldownSeconds(): number {
  if (state.activeTab === 'inicio') {
    return state.inicioSearchMode === 'stop'
      ? INICIO_STOP_REFRESH_COOLDOWN_SECONDS
      : 20
  }

  return MANUAL_REFRESH_COOLDOWN_SECONDS
}

async function triggerManualRefresh(): Promise<void> {
  // If there is an active tracking notification, warn and block incompatible manual updates
  if (Object.keys(state.trackingByKey).length > 0) {
    const msg = 'Hay una notificación de seguimiento activa; deténla antes de actualizar manualmente.'
    setTransientError(msg)
    pushSettingsUpdate('Actualizacion manual bloqueada por seguimiento', 'manual', 'error', state.activeTab, msg)
    return
  }

  if (!canUseManualRefresh()) {
    const remainingSeconds = Math.max(1, Math.ceil((getNextAllowedRefreshAt() - Date.now()) / 1000))
    setTransientError(`Debes esperar ${remainingSeconds} s antes de volver a actualizar.`)
    pushSettingsUpdate('Actualizacion manual bloqueada', 'manual', 'error', state.activeTab, `Debes esperar ${remainingSeconds} s antes de volver a actualizar.`)
    return
  }

  const manualSeconds = getManualRefreshCooldownSeconds()
  state.manualRefreshCooldownUntil = Date.now() + manualSeconds * 1000
  await refreshArrivals('manual', state.activeTab === 'inicio')
  render()
}

function getRouteDirectionOptions(): RouteDirectionOption[] {
  if (!state.dataset) {
    return []
  }

  return state.dataset.getRouteDirectionOptions()
}

function getStopsForRouteDirection(option: RouteDirectionOption): StopOption[] {
  if (!state.dataset || !option.routeShortName) {
    return []
  }

  const routeStops = state.dataset.getRouteStops(option.routeShortName, undefined, option.headsign)
  const uniqueById = new Map<string, StopOption>()
  for (const routeStop of routeStops) {
    const stop = state.dataset.stopMap.get(routeStop.stopId)
    if (stop && !uniqueById.has(stop.stopId)) {
      uniqueById.set(stop.stopId, stop)
    }
  }

  return Array.from(uniqueById.values())
}

function initInicioMapIfNeeded(): void {
  if (state.activeTab !== 'inicio' || state.inicioSearchMode !== 'map' || !state.dataset) {
    if (inicioMap) {
      inicioMap.remove()
      inicioMap = null
      inicioMapMarkerLayer = null
    }
    return
  }

  const container = document.querySelector<HTMLDivElement>('#inicio-map')
  if (!container) {
    return
  }

  const routeDirectionOptions = getRouteDirectionOptions()
  const selectedDirection = routeDirectionOptions.find((option) => option.key === state.inicioMapRouteShortName)
    ?? routeDirectionOptions[0]
    ?? null
  if (!selectedDirection) {
    return
  }

  const stops = getStopsForRouteDirection(selectedDirection)

  if (inicioMap && inicioMap.getContainer() !== container) {
    inicioMap.remove()
    inicioMap = null
    inicioMapMarkerLayer = null
  }

  if (!inicioMap) {
    inicioMap = L.map(container, {
      zoomControl: true,
      attributionControl: true,
    })
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(inicioMap)
    inicioMapMarkerLayer = L.layerGroup().addTo(inicioMap)
  }

  if (!inicioMapMarkerLayer) {
    inicioMapMarkerLayer = L.layerGroup().addTo(inicioMap)
  }
  inicioMapMarkerLayer.clearLayers()

  const latLngs: Array<[number, number]> = []
  for (const stop of stops) {
    if (!Number.isFinite(stop.lat) || !Number.isFinite(stop.lon)) {
      continue
    }

    const isSelected = state.selectedStopId === stop.stopId
    const marker = L.circleMarker([stop.lat, stop.lon], {
      radius: isSelected ? 8 : 6,
      color: '#12325f',
      weight: 1.5,
      fillColor: isSelected ? '#f7bc3e' : '#3f81f8',
      fillOpacity: 0.95,
    })
    marker.bindPopup(`${escapeHtml(stop.stopName)} · ${escapeHtml(stop.stopId)}`)
    marker.on('click', () => {
      state.selectedStopId = stop.stopId
      void refreshArrivals('manual', true).then(() => {
        const manualSeconds = getManualRefreshCooldownSeconds()
        state.manualRefreshCooldownUntil = Date.now() + manualSeconds * 1000
        render()
      })
    })
    marker.addTo(inicioMapMarkerLayer)
    latLngs.push([stop.lat, stop.lon])
  }

  if (latLngs.length > 0) {
    inicioMap.fitBounds(latLngs, { padding: [24, 24], maxZoom: 16 })
  } else {
    inicioMap.setView([40.9701, -5.6635], 13)
  }

  window.setTimeout(() => inicioMap?.invalidateSize(), 0)
}

function getAvailableRoutesForStop(stopId: string): string[] {
  const realtimeRoutes = getDeparturesForStop(stopId, 20).map((item) => item.routeShortName)
  return Array.from(new Set(realtimeRoutes)).sort((left, right) => left.localeCompare(right, 'es'))
}

function renderActionModal(): string {
  if (!state.actionModal || !state.dataset) {
    return ''
  }

  const stop = state.dataset.stopMap.get(state.actionModal.stopId)
  if (!stop) {
    return ''
  }

  const routes = getAvailableRoutesForStop(stop.stopId)
  const mode = state.actionModal.mode
  const selectedRoute = mode === 'tracking'
    ? (state.trackingRouteChoiceByStop[stop.stopId] ?? routes[0] ?? '')
    : mode === 'monitoring'
      ? (state.monitoringRouteChoiceByStop[stop.stopId] ?? routes[0] ?? '')
      : (state.locatorRouteChoiceByStop[stop.stopId] ?? routes[0] ?? '')

  if (selectedRoute) {
    if (mode === 'tracking' && !state.trackingRouteChoiceByStop[stop.stopId]) {
      state.trackingRouteChoiceByStop[stop.stopId] = selectedRoute
    }
    if (mode === 'monitoring' && !state.monitoringRouteChoiceByStop[stop.stopId]) {
      state.monitoringRouteChoiceByStop[stop.stopId] = selectedRoute
    }
    if (mode === 'locator' && !state.locatorRouteChoiceByStop[stop.stopId]) {
      state.locatorRouteChoiceByStop[stop.stopId] = selectedRoute
    }
  }
  const range = state.monitoringRangeByStop[stop.stopId] ?? { startMinutes: 7 * 60, endMinutes: 8 * 60 }

  const title = mode === 'tracking'
    ? 'Configurar próximo bus'
    : mode === 'monitoring'
      ? 'Configurar monitorización'
      : 'Configurar localizador'

  const confirmLabel = mode === 'tracking'
    ? 'Iniciar seguimiento'
    : mode === 'monitoring'
      ? 'Registrar monitorización'
      : 'Registrar seguimiento'

  return `
    <button id="action-modal-backdrop" class="time-modal-backdrop" type="button" aria-label="Cerrar configuración"></button>
    <section class="time-modal action-modal" role="dialog" aria-modal="true" aria-labelledby="action-modal-title">
      <div class="time-modal-head">
        <h3 id="action-modal-title">${escapeHtml(title)}</h3>
        <button id="action-modal-close" class="button-ghost" type="button">Cerrar</button>
      </div>

      <p class="panel-copy">${escapeHtml(stop.stopName)} · ${escapeHtml(stop.stopId)}</p>

      <label class="field slim" for="action-modal-route-select">
        <span>Selecciona la línea</span>
        <select id="action-modal-route-select" data-action-modal-route-stop-id="${stop.stopId}" ${routes.length === 0 ? 'disabled' : ''}>
          ${routes.map((route) => `<option value="${escapeHtml(route)}" ${route === selectedRoute ? 'selected' : ''}>${escapeHtml(route)}</option>`).join('')}
        </select>
      </label>

      ${mode === 'monitoring' ? `
        <p class="slider-help">Intervalo: ${escapeHtml(formatMinutesToClock(range.startMinutes))} - ${escapeHtml(formatMinutesToClock(range.endMinutes))}</p>
        <div class="button-row wrap compact">
          <button id="action-modal-open-interval" class="button-secondary" type="button">Configurar intervalo</button>
        </div>
      ` : ''}

      <div class="button-row wrap">
        <button id="action-modal-confirm" class="button-primary" type="button" ${selectedRoute ? '' : 'disabled'}>${escapeHtml(confirmLabel)}</button>
      </div>
    </section>
  `
}

function renderMonitoringIntervalModal(): string {
  const stopId = state.monitoringIntervalEditorStopId
  if (!stopId) {
    return ''
  }

  const range = state.monitoringRangeByStop[stopId] ?? { startMinutes: 7 * 60, endMinutes: 8 * 60 }
  const durationMinutes = Math.max(15, range.endMinutes - range.startMinutes)

  return `
    <button id="monitoring-interval-modal-backdrop" class="time-modal-backdrop" type="button" aria-label="Cerrar editor de intervalo"></button>
    <section class="time-modal" role="dialog" aria-modal="true" aria-labelledby="monitoring-interval-modal-title">
      <div class="time-modal-head">
        <h3 id="monitoring-interval-modal-title">Intervalo horario</h3>
        <button id="monitoring-interval-modal-close" class="button-ghost" type="button">Cerrar</button>
      </div>
      <p class="panel-copy">Configura inicio y fin en tramos de 15 minutos con control deslizante o entrada manual.</p>

      <div class="time-modal-grid">
        <label class="field slim" for="monitoring-start-slider">
          <span>Desde</span>
          <input id="monitoring-start-slider" type="range" min="0" max="1425" step="15" value="${range.startMinutes}" />
          <input id="monitoring-start-time" type="time" step="900" value="${formatMinutesToClock(range.startMinutes)}" />
        </label>

        <label class="field slim" for="monitoring-end-slider">
          <span>Hasta</span>
          <input id="monitoring-end-slider" type="range" min="0" max="1425" step="15" value="${range.endMinutes}" />
          <input id="monitoring-end-time" type="time" step="900" value="${formatMinutesToClock(range.endMinutes)}" />
        </label>
      </div>

      <p class="tracking-state">Rango: ${escapeHtml(formatMinutesToClock(range.startMinutes))} - ${escapeHtml(formatMinutesToClock(range.endMinutes))} · Duración: ${durationMinutes} min</p>

      <div class="button-row wrap">
        <button id="monitoring-interval-modal-apply" class="button-primary" type="button">Aplicar</button>
      </div>
    </section>
  `
}

function chooseMonitoringToReplace(): string | null {
  if (state.monitorings.length < 2) {
    return null
  }

  const options = state.monitorings
    .map((item, index) => `${index + 1}. ${item.stopName} · ${item.routeShortName} · ${formatMinutesToClock(item.startMinutes)}-${formatMinutesToClock(item.endMinutes)}`)
    .join('\n')
  const answer = window.prompt(`Ya hay 2 monitorizaciones activas. Indica cuál deseas reemplazar:\n${options}`, '1')
  if (!answer) {
    return null
  }

  const index = Number.parseInt(answer.trim(), 10) - 1
  if (!Number.isFinite(index) || index < 0 || index >= state.monitorings.length) {
    return null
  }

  return state.monitorings[index].id
}

function renderDepartureList(departures: DepartureInsight[], emptyMessage: string): string {
  if (departures.length === 0) {
    return `<p class="empty-state">${escapeHtml(emptyMessage)}</p>`
  }

  return departures.map((departure) => {
    const sourceLabel = departure.isRealtime ? 'TIEMPO REAL' : 'PREDETERMINADO'
    const sourceClass = departure.isRealtime ? 'rt-pill' : 'gtfs-pill'
    const arrivalClock = formatClock(departure.estimatedTime ?? departure.arrivalTime)
    const observedAverage = getObservedAverageForDeparture(departure)

    return `
      <article class="departure-row">
        <div>
          <div class="route-row">
            <p class="route-chip" style="${buildRouteChipStyle(departure.routeColor, departure.routeTextColor)}">${escapeHtml(`${departure.routeShortName} · ${departure.headsign || 'sentido no definido'}`)}</p>
            <span class="source-pill ${sourceClass}">${sourceLabel}</span>
          </div>
          <h4>${escapeHtml(departure.headsign)}</h4>
        </div>
        <div class="departure-meta">
          <strong>${escapeHtml(arrivalClock)}</strong>
          <span>${escapeHtml(formatCountdown(departure.minutesUntil))}</span>
          ${observedAverage ? `
            <span class="observed-average" title="${escapeHtml(`Rango observado ${observedAverage.rangeText}`)}">
              Media observada: ${escapeHtml(observedAverage.averageClock)}<sup>${observedAverage.count}</sup>
            </span>
          ` : ''}
        </div>
      </article>
    `
  }).join('')
}

function renderRouteShortNameBadge(routeShortName: string): string {
  const route = state.dataset?.routes.find((item) => (
    item.shortName === routeShortName || item.routeId === routeShortName
  ))

  const routeColor = route?.routeColor ?? '173764'
  const routeTextColor = route?.routeTextColor ?? 'FFFFFF'
  const direction = getDirectionLabelForRoute(routeShortName)
  return `<span class="route-chip line-chip-inline" style="${buildRouteChipStyle(routeColor, routeTextColor)}">${escapeHtml(`${routeShortName} · ${direction}`)}</span>`
}

function renderRouteShortNameBadgeCompact(routeShortName: string): string {
  const route = state.dataset?.routes.find((item) => (
    item.shortName === routeShortName || item.routeId === routeShortName
  ))

  const routeColor = route?.routeColor ?? '173764'
  const routeTextColor = route?.routeTextColor ?? 'FFFFFF'
  return `<span class="route-chip line-chip-inline" style="${buildRouteChipStyle(routeColor, routeTextColor)}">${escapeHtml(routeShortName)}</span>`
}

function getDirectionLabelForRoute(routeShortName: string): string {
  const route = state.dataset?.routes.find((item) => (
    item.shortName === routeShortName || item.routeId === routeShortName
  ))
  return route?.headsigns[0] ?? route?.longName ?? 'sentido no definido'
}

function getDeparturesForStop(stopId: string, limit: number): DepartureInsight[] {
  if (state.dataMode === 'realtime') {
    const realtimeRows = (state.realtimeArrivalsByStop[stopId] ?? []).map((row) => ({
      ...row,
      stopId,
      // If the row was returned by realtime endpoints, its provenance is realtime.
      isRealtime: true,
    }))
    if (realtimeRows.length > 0) {
      return normalizeDepartures(realtimeRows, limit, true)
    }

    if (!state.dataset) {
      return []
    }

    const staticFallbackRows = state.dataset.getUpcomingDepartures(stopId, new Date(), limit * 2)
      .map((departure) => ({
        ...departure,
        stopId,
        isRealtime: false,
        scheduledTime: departure.arrivalTime,
        estimatedTime: departure.arrivalTime,
      }))

    return normalizeDepartures(staticFallbackRows, limit, false)
  }

  if (state.dataMode === 'mixed') {
    const realtimeRows = (state.realtimeArrivalsByStop[stopId] ?? []).map((row) => ({
      ...row,
      stopId,
      // If the row was returned by realtime endpoints, its provenance is realtime.
      isRealtime: true,
    }))
    if (realtimeRows.length > 0) {
      return normalizeDepartures(realtimeRows, limit, true)
    }
  }

  if (!state.dataset) {
    return []
  }

  const staticRows = state.dataset.getUpcomingDepartures(stopId, new Date(), limit * 2)
    .map((departure) => ({
      ...departure,
      stopId,
      isRealtime: false,
      scheduledTime: departure.arrivalTime,
      estimatedTime: departure.arrivalTime,
    }))

  return normalizeDepartures(staticRows, limit, false)
}

function normalizeDepartures(rows: DepartureInsight[], limit: number, realtimeOnly: boolean): DepartureInsight[] {
  const unique = new Map<string, DepartureInsight>()

  for (const row of rows) {
    if (realtimeOnly && row.isRealtime !== true) {
      continue
    }

    const styled = applyRouteStyleFromGtfs(row)
    const key = `${styled.routeShortName}|${formatClock(styled.estimatedTime ?? styled.arrivalTime)}|${styled.headsign}`

    if (!unique.has(key)) {
      unique.set(key, styled)
    }
  }

  return Array.from(unique.values())
    .sort(compareDepartures)
    .slice(0, limit)
}

function applyRouteStyleFromGtfs(departure: DepartureInsight): DepartureInsight {
  if (!state.dataset) {
    return departure
  }

  const route = findRouteInsight(departure)
  if (!route) {
    return departure
  }

  return {
    ...departure,
    routeColor: route.routeColor,
    routeTextColor: route.routeTextColor,
  }
}

function findRouteInsight(departure: DepartureInsight): RouteInsight | null {
  if (!state.dataset) {
    return null
  }

  return state.dataset.routes.find((route) => (
    route.routeId === departure.routeId
    || route.shortName === departure.routeShortName
    || route.routeId === departure.routeShortName
  )) ?? null
}

function compareDepartures(left: DepartureInsight, right: DepartureInsight): number {
  const leftValue = buildComparableMinutes(left)
  const rightValue = buildComparableMinutes(right)

  if (leftValue !== rightValue) {
    return leftValue - rightValue
  }

  return left.routeShortName.localeCompare(right.routeShortName, 'es')
}

function buildComparableMinutes(item: DepartureInsight): number {
  if (typeof item.minutesUntil === 'number') {
    return item.minutesUntil
  }

  const hhmm = formatClock(item.estimatedTime ?? item.arrivalTime)
  const [hhRaw, mmRaw] = hhmm.split(':')
  const hh = Number.parseInt(hhRaw, 10)
  const mm = Number.parseInt(mmRaw, 10)

  if (!Number.isFinite(hh) || !Number.isFinite(mm)) {
    return Number.POSITIVE_INFINITY
  }

  const now = new Date()
  const current = now.getHours() * 60 + now.getMinutes()
  const target = hh * 60 + mm

  return target >= current ? target - current : target + 24 * 60 - current
}

function loadStoredStopIds(): string[] {
  const raw = window.localStorage.getItem(HUB_STORAGE_KEY)
  if (!raw) {
    return []
  }

  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function persistStopIds(stopIds: string[]): void {
  window.localStorage.setItem(HUB_STORAGE_KEY, JSON.stringify(stopIds))
}

function loadHubCustomNames(): Record<string, string> {
  const raw = window.localStorage.getItem(HUB_CUSTOM_NAMES_STORAGE_KEY)
  if (!raw) {
    return {}
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const result: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string' && value.trim()) {
        result[key] = value.trim()
      }
    }
    return result
  } catch {
    return {}
  }
}

function persistHubCustomNames(values: Record<string, string>): void {
  window.localStorage.setItem(HUB_CUSTOM_NAMES_STORAGE_KEY, JSON.stringify(values))
}

function loadMonitorings(): MonitoringRegistration[] {
  const raw = window.localStorage.getItem(MONITORING_STORAGE_KEY)
  if (!raw) {
    return []
  }

  try {
    const parsed = JSON.parse(raw) as Array<MonitoringRegistration & { startHour?: number, endHour?: number }>
    return Array.isArray(parsed) ? parsed.filter((item) => (
      typeof item?.id === 'string'
      && typeof item?.stopId === 'string'
      && typeof item?.stopName === 'string'
      && typeof item?.routeShortName === 'string'
      && (Number.isFinite(item?.startMinutes) || Number.isFinite(item?.startHour))
      && (Number.isFinite(item?.endMinutes) || Number.isFinite(item?.endHour))
    )).map((item) => {
      const startMinutes = Number.isFinite(item.startMinutes)
        ? Number(item.startMinutes)
        : Number(item.startHour) * 60
      const endMinutes = Number.isFinite(item.endMinutes)
        ? Number(item.endMinutes)
        : Number(item.endHour) * 60
      const normalized = normalizeMonitoringRange(startMinutes, endMinutes)

      return {
        id: item.id,
        stopId: item.stopId,
        stopName: item.stopName,
        routeShortName: item.routeShortName,
        startMinutes: normalized.startMinutes,
        endMinutes: normalized.endMinutes,
      }
    }) : []
  } catch {
    return []
  }
}

function loadLocators(): LocatorRegistration[] {
  const raw = window.localStorage.getItem(LOCATOR_STORAGE_KEY)
  if (!raw) {
    return []
  }

  try {
    const parsed = JSON.parse(raw) as LocatorRegistration[]
    return Array.isArray(parsed) ? parsed.filter((item) => (
      typeof item?.id === 'string'
      && typeof item?.stopId === 'string'
      && typeof item?.stopName === 'string'
      && typeof item?.routeShortName === 'string'
    )) : []
  } catch {
    return []
  }
}

function persistLocators(locators: LocatorRegistration[]): void {
  window.localStorage.setItem(LOCATOR_STORAGE_KEY, JSON.stringify(locators))
}

function persistMonitorings(monitorings: MonitoringRegistration[]): void {
  window.localStorage.setItem(MONITORING_STORAGE_KEY, JSON.stringify(monitorings))
}

function loadMonitoringStats(): Record<string, Record<ServiceDayType, Record<string, MonitoringAverageStats>>> {
  const raw = window.localStorage.getItem(MONITORING_STATS_STORAGE_KEY)
  if (!raw) {
    return {}
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return normalizeMonitoringStats(parsed)
  } catch {
    return {}
  }
}

function persistMonitoringStats(stats: Record<string, Record<ServiceDayType, Record<string, MonitoringAverageStats>>>): void {
  window.localStorage.setItem(MONITORING_STATS_STORAGE_KEY, JSON.stringify(stats))
}

function normalizeMonitoringStats(raw: Record<string, unknown>): Record<string, Record<ServiceDayType, Record<string, MonitoringAverageStats>>> {
  const result: Record<string, Record<ServiceDayType, Record<string, MonitoringAverageStats>>> = {}

  for (const [monitoringId, rawByDay] of Object.entries(raw)) {
    if (!rawByDay || typeof rawByDay !== 'object') {
      continue
    }

    const byDay = buildEmptyMonitoringStatsByDay()
    const asRecord = rawByDay as Record<string, unknown>

    const hasDayBuckets = ['weekday', 'saturday', 'sunday'].every((key) => Object.prototype.hasOwnProperty.call(asRecord, key))

    if (hasDayBuckets) {
      byDay.weekday = normalizeMonitoringSlotStats(asRecord.weekday)
      byDay.saturday = normalizeMonitoringSlotStats(asRecord.saturday)
      byDay.sunday = normalizeMonitoringSlotStats(asRecord.sunday)
    } else {
      byDay.weekday = normalizeMonitoringSlotStats(rawByDay)
    }

    result[monitoringId] = byDay
  }

  return result
}

function normalizeMonitoringSlotStats(raw: unknown): Record<string, MonitoringAverageStats> {
  const result: Record<string, MonitoringAverageStats> = {}
  if (!raw || typeof raw !== 'object') {
    return result
  }

  for (const [slot, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') {
      continue
    }

    const item = value as Partial<MonitoringAverageStats>
    const perDayLatestRaw = item.perDayLatest && typeof item.perDayLatest === 'object'
      ? item.perDayLatest as Record<string, unknown>
      : {}
    const perDayLatest: Record<string, number> = {}
    for (const [dayKey, rawMinutes] of Object.entries(perDayLatestRaw)) {
      if (Number.isFinite(rawMinutes)) {
        perDayLatest[dayKey] = Number(rawMinutes)
      }
    }
    const values = Object.values(perDayLatest)
    const count = values.length > 0 ? values.length : (Number.isFinite(item.count) ? Number(item.count) : 0)
    const sumMinutes = values.length > 0
      ? values.reduce((sum, value) => sum + value, 0)
      : (Number.isFinite(item.sumMinutes) ? Number(item.sumMinutes) : 0)
    const inferredAverage = count > 0 ? Math.round(sumMinutes / count) : 0

    result[slot] = {
      count,
      sumMinutes,
      minMinutes: values.length > 0
        ? Math.min(...values)
        : (Number.isFinite(item.minMinutes) ? Number(item.minMinutes) : inferredAverage),
      maxMinutes: values.length > 0
        ? Math.max(...values)
        : (Number.isFinite(item.maxMinutes) ? Number(item.maxMinutes) : inferredAverage),
      perDayLatest,
    }
  }

  return result
}

function buildEmptyMonitoringStatsByDay(): Record<ServiceDayType, Record<string, MonitoringAverageStats>> {
  return {
    weekday: {},
    saturday: {},
    sunday: {},
  }
}

function getDayTypeFromDate(value: Date): ServiceDayType {
  const day = value.getDay()
  if (day === 0) {
    return 'sunday'
  }
  if (day === 6) {
    return 'saturday'
  }
  return 'weekday'
}

function parseServiceDayType(value: string): ServiceDayType {
  if (value === 'saturday') {
    return 'saturday'
  }
  if (value === 'sunday') {
    return 'sunday'
  }
  return 'weekday'
}

function buildPermissionCards(): PermissionStatusItem[] {
  return [
    {
      title: 'Notificaciones locales',
      description: 'Necesarias para mantener avisos persistentes durante el seguimiento de línea.',
      state: state.permissions.notifications,
    },
    {
      title: 'Optimización de batería',
      description: 'Debe permitirse en Android para mejorar la monitorización continua en segundo plano.',
      state: state.permissions.batteryOptimization,
    },
  ]
}

function formatPermissionState(value: PermissionState): string {
  if (value === 'granted') {
    return 'Concedido'
  }
  if (value === 'denied') {
    return 'No concedido'
  }
  return 'Pendiente'
}

function mapNotificationPermission(value: string): PermissionState {
  if (value === 'granted') {
    return 'granted'
  }
  if (value === 'denied') {
    return 'denied'
  }
  return 'unknown'
}

function loadDataMode(): DataMode {
  const raw = window.localStorage.getItem(DATA_MODE_STORAGE_KEY)
  return parseDataMode(raw ?? '')
}

function parseDataMode(value: string): DataMode {
  if (value === 'realtime') {
    return 'realtime'
  }

  if (value === 'mixed') {
    return 'mixed'
  }

  if (value === 'gtfs') {
    return 'gtfs'
  }

  return 'mixed'
}



function loadSettingsUpdates(): SettingsUpdateEntry[] {
  const raw = window.localStorage.getItem(SETTINGS_UPDATES_STORAGE_KEY)
  if (!raw) {
    return []
  }

  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) {
      return []
    }

    return parsed.filter((item): item is SettingsUpdateEntry => {
      if (!item || typeof item !== 'object') {
        return false
      }

      const candidate = item as Partial<SettingsUpdateEntry>
      return (
        typeof candidate.id === 'string'
        && typeof candidate.at === 'string'
        && typeof candidate.action === 'string'
        && typeof candidate.detail === 'string'
        && isTabId(candidate.tab)
        && isSettingsUpdateSource(candidate.source)
        && isSettingsUpdateStatus(candidate.status)
      )
    })
  } catch {
    return []
  }
}

function persistSettingsUpdates(entries: SettingsUpdateEntry[]): void {
  window.localStorage.setItem(SETTINGS_UPDATES_STORAGE_KEY, JSON.stringify(entries))
}

function loadFailureLogs(storageKey: string): FailureLogEntry[] {
  const raw = window.localStorage.getItem(storageKey)
  if (!raw) {
    return []
  }

  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) {
      return []
    }

    return parsed.filter((item): item is FailureLogEntry => {
      if (!item || typeof item !== 'object') {
        return false
      }

      const candidate = item as Partial<FailureLogEntry>
      return (
        typeof candidate.id === 'string'
        && typeof candidate.at === 'string'
        && typeof candidate.reason === 'string'
        && typeof candidate.detail === 'string'
        && isTabId(candidate.tab)
      )
    })
  } catch {
    return []
  }
}

function persistFailureLogs(storageKey: string, entries: FailureLogEntry[]): void {
  window.localStorage.setItem(storageKey, JSON.stringify(entries))
}

function pushFailureLog(storageKey: string, listKey: 'realtimeFailures' | 'monitoringAverageFailures', reason: string, detail: string, tab: TabId): void {
  const lastEntry = state[listKey][0]
  if (lastEntry && lastEntry.reason === reason && lastEntry.detail === detail) {
    const elapsedMs = Date.now() - new Date(lastEntry.at).getTime()
    if (elapsedMs < 30000) {
      return
    }
  }

  const entry: FailureLogEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    at: new Date().toISOString(),
    reason,
    detail,
    tab,
  }

  state[listKey] = [entry, ...state[listKey]].slice(0, 160)
  persistFailureLogs(storageKey, state[listKey])
}

function recordRealtimeFailure(reason: string, detail: string, tab: TabId): void {
  pushFailureLog(REALTIME_FAILURES_STORAGE_KEY, 'realtimeFailures', reason, detail, tab)
}

function recordMonitoringAverageFailure(reason: string, detail: string, tab: TabId): void {
  pushFailureLog(MONITORING_AVG_FAILURES_STORAGE_KEY, 'monitoringAverageFailures', reason, detail, tab)
}

function pushSettingsUpdate(
  action: string,
  source: SettingsUpdateSource,
  status: SettingsUpdateStatus,
  tab: TabId,
  detail: string,
): void {
  const entry: SettingsUpdateEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    at: new Date().toISOString(),
    tab,
    source,
    status,
    action,
    detail,
  }

  state.settingsUpdates = [entry, ...state.settingsUpdates].slice(0, 120)
  persistSettingsUpdates(state.settingsUpdates)
}

function isTabId(value: unknown): value is TabId {
  return value === 'home' || value === 'inicio' || value === 'hub' || value === 'monitorizacion' || value === 'localizador' || value === 'estado' || value === 'registros'
}

function isSettingsUpdateSource(value: unknown): value is SettingsUpdateSource {
  return value === 'manual' || value === 'auto' || value === 'system'
}

function isSettingsUpdateStatus(value: unknown): value is SettingsUpdateStatus {
  return value === 'ok' || value === 'error' || value === 'info'
}

function formatSettingsUpdateSource(value: SettingsUpdateSource): string {
  if (value === 'manual') {
    return 'Manual'
  }
  if (value === 'auto') {
    return 'Auto'
  }
  return 'Sistema'
}

function buildRouteChipStyle(routeColor: string, routeTextColor: string): string {
  const normalizedBg = routeColor.replace('#', '')
  const normalizedFg = routeTextColor.replace('#', '')
  return `background:#${normalizedBg}; color:#${normalizedFg};`
}

function formatCountdown(value: number | null): string {
  if (value === null) {
    return 'sin estimación'
  }

  if (value <= 0) {
    return 'ahora'
  }

  return `${value} min`
}

function formatClock(value: string): string {
  const [hours = '00', minutes = '00'] = String(value).split(':')
  return `${hours.padStart(2, '0')}:${minutes.padStart(2, '0')}`
}

function formatTimeOnly(value: Date | null): string {
  if (!value) {
    return 'sin datos'
  }

  return value.toLocaleTimeString('es-ES', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function setTransientError(message: string): void {
  state.error = message
  render()

  if (transientErrorTimer !== null) {
    window.clearTimeout(transientErrorTimer)
  }

  transientErrorTimer = window.setTimeout(() => {
    if (state.error === message) {
      state.error = null
      render()
    }
    transientErrorTimer = null
  }, 3000)
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
  }
