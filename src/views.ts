import { getClientHealth, MIN_REQUEST_SPACING_MS } from './services/arrivals'
import { currentDayType } from './services/schedule'
import {
  activeJobCount,
  APP_VERSION,
  ARRIVALS_PREVIEW,
  favouriteLabel,
  formatMinutesClock,
  isFavourite,
  isWithinWindow,
  MAX_ACTIVE_JOBS,
  MAX_FOLLOW_JOBS,
  MAX_TRACKING_JOBS,
  state,
  summariseMonitor,
  trackingBusTarget,
  TRACKING_BUS_TARGET_MAX,
  TRACKING_WARN_MINUTES,
  type MonitorJob,
  type MonitorRow,
  type TabId,
  type TrackingJob,
} from './state'
import type { Arrival, LineDirection, NetworkStop, StopFeed, TransitLine } from './types'
import {
  arrivalTone,
  emptyState,
  esc,
  feedPill,
  formatAge,
  formatClock,
  formatLongDate,
  icon,
  lineChip,
  liveMinutes,
  notice,
  renderEta,
  syncDot,
} from './ui'

/* ------------------------------------------------------------------ *
 * Ayudantes de dominio                                                 *
 * ------------------------------------------------------------------ */

export function stopName(stopId: string): string {
  return state.network?.stopById.get(stopId)?.stopName ?? `Parada ${stopId}`
}

export function lineColor(lineId: string): string {
  return state.network?.getLineColor(lineId) ?? '#173764'
}

export function lineOf(lineId: string): TransitLine | null {
  return state.network?.lineById.get(lineId) ?? null
}

/**
 * La fuente de llegadas solo dice "Línea N", no el sentido. Se resuelve con la
 * red oficial: si por esa parada solo pasa un sentido de la linea, se muestra su
 * destino; si pasan varios, se muestra el nombre de la linea para no inventar.
 */
export function describeArrival(stopId: string, lineId: string): string {
  const network = state.network
  if (!network) {
    return `Línea ${lineId}`
  }

  const directions = network
    .getDirectionsThroughStop(stopId, lineId)
    .filter((direction) => !direction.partial)

  if (directions.length === 1) {
    return `Hacia ${directions[0].destination}`
  }

  const line = network.lineById.get(lineId)
  if (line) {
    return line.title
  }

  return `Línea ${lineId}`
}

function feedOf(stopId: string): StopFeed | undefined {
  return state.feeds[stopId]
}

/* ------------------------------------------------------------------ *
 * Cascarón                                                             *
 * ------------------------------------------------------------------ */

interface TabDefinition {
  id: TabId
  label: string
  iconName: string
}

/**
 * Barra inferior. "Mis paradas" ya no es una pestaña propia —vive dentro de
 * Inicio— y Ajustes se abre desde el icono de la barra superior, junto al de
 * actualizar: son dos destinos menos que elegir cada vez que se mira abajo.
 */
const TABS: TabDefinition[] = [
  { id: 'inicio', label: 'Inicio', iconName: 'home' },
  { id: 'buscar', label: 'Buscar', iconName: 'search' },
  { id: 'seguimiento', label: 'Seguir', iconName: 'route' },
  { id: 'monitor', label: 'Puntualidad', iconName: 'chart' },
]

/** Ajustes no esta en la barra, pero su pantalla tambien necesita titulo. */
const TAB_TITLES: Record<TabId, string> = {
  inicio: 'Inicio',
  buscar: 'Buscar',
  seguimiento: 'Seguir',
  monitor: 'Puntualidad',
  ajustes: 'Ajustes',
}

export function renderApp(): string {
  return `
    <div class="app-shell">
      ${renderTopbar()}
      <main class="screen" id="screen">${renderScreen()}</main>
      ${renderTabbar()}
    </div>
    ${renderSheet()}
    ${renderTour()}
    ${renderStopDialog()}
    ${renderUpdateDialog()}
    ${renderToast()}
  `
}

function renderTopbar(): string {
  const health = getClientHealth()
  const busy = state.refreshing || health.queued > 0

  const subtitle = state.refreshQueueLabel
    ?? (state.lastRefreshAt ? `Actualizado ${formatAge(state.lastRefreshAt)}` : 'Sin datos todavía')

  return `
    <header class="topbar">
      <div class="topbar-mark"><img src="/favicon.svg" alt="" /></div>
      <div class="topbar-copy">
        <h1 class="topbar-title">${esc(TAB_TITLES[state.tab] ?? 'SALBUS')}</h1>
        <p class="topbar-sub">${esc(subtitle)}</p>
      </div>
      <div class="topbar-actions">
        <button
          class="icon-btn${busy ? ' is-spinning' : ''}"
          type="button"
          data-action="refresh"
          aria-label="Actualizar ahora"
          ${busy ? 'disabled' : ''}
        >${icon('refresh')}</button>
        <button
          class="icon-btn${state.tab === 'ajustes' ? ' is-current' : ''}"
          type="button"
          data-action="tab"
          data-tab="ajustes"
          aria-label="Ajustes"
          ${state.tab === 'ajustes' ? 'aria-current="page"' : ''}
        >${icon('settings')}</button>
      </div>
    </header>
  `
}

function renderTabbar(): string {
  const trackingActive = state.trackings.some((job) => job.active)

  return `
    <nav class="tabbar" aria-label="Secciones">
      ${TABS.map((tab) => {
        const isCurrent = tab.id === state.tab
        const dot = tab.id === 'seguimiento' && trackingActive ? '<span class="tab-dot"></span>' : ''
        return `
          <button
            class="tabbar-item"
            type="button"
            data-action="tab"
            data-tab="${tab.id}"
            ${isCurrent ? 'aria-current="page"' : ''}
          >${icon(tab.iconName)}${dot}<span>${esc(tab.label)}</span></button>
        `
      }).join('')}
    </nav>
  `
}

function renderToast(): string {
  if (!state.toast) {
    return ''
  }

  const toneClass = state.toast.tone === 'error' ? ' is-error' : state.toast.tone === 'success' ? ' is-success' : ''
  return `<div class="toast${toneClass}" role="status">${esc(state.toast.message)}</div>`
}

function renderScreen(): string {
  if (!state.ready) {
    return renderBooting()
  }

  switch (state.tab) {
    case 'inicio':
      return renderInicio()
    case 'buscar':
      return renderBuscar()
    case 'seguimiento':
      return renderSeguimiento()
    case 'monitor':
      return renderMonitor()
    case 'ajustes':
      return renderAjustes()
    default:
      return renderInicio()
  }
}

/**
 * Aviso de version nueva. Ventana centrada, por encima de todo: es lo primero
 * que hay que decidir al abrir la app. Ensena lo minimo: que la hay, cual es,
 * que va a pasar y los botones. Nada de notas de la version ni tamano del
 * descargable: son datos que nadie lee en un aviso y que solo alargan la
 * decision.
 *
 * «Ahora no» solo vale para esta sesion (`dismissed` no se guarda en disco):
 * mientras la actualizacion siga pendiente, la ventana vuelve en cada arranque.
 */
function renderUpdateDialog(): string {
  const update = state.update
  const active = update.phase === 'available'
    || update.phase === 'downloading'
    || update.phase === 'ready'
    || update.phase === 'installing'
    || (update.phase === 'error' && update.release !== null)

  // El tour manda mientras esta abierto: dos ventanas apiladas no se leen.
  if (!active || update.dismissed || !update.release || !state.ready || state.tour.open) {
    return ''
  }

  const needsPermission = update.phase === 'ready' && !update.canInstall
  /** Una descarga o una instalacion en curso no se dejan cerrar a medias. */
  const busy = update.phase === 'downloading' || update.phase === 'installing'

  return `
    <div class="modal-backdrop"></div>
    <section class="modal" role="dialog" aria-modal="true" aria-label="Hay una versión nueva">
      <div class="update-head">
        ${icon('refresh')}
        <div class="update-copy">
          <strong>Hay una versión nueva</strong>
          <span>SALBUS v${esc(update.release.versionName)} · compilación ${update.release.versionCode}</span>
          <span>Tienes la v${esc(state.installed.versionName)} · compilación ${state.installed.versionCode}</span>
        </div>
        <button class="mini-btn" type="button" data-action="dismiss-update" aria-label="Ahora no" ${
          busy ? 'disabled' : ''
        }>${icon('close')}</button>
      </div>

      ${
        needsPermission
          ? `<p class="update-hint">Android pide tu permiso para instalar aplicaciones fuera de Play Store.
             Se concede una sola vez, desde los ajustes del sistema.</p>`
          : `<p class="update-hint">Al instalar, Android enseña una pantalla de advertencia: pulsa
             <strong>Instalar de todos modos</strong>. Es segura, va firmada con la misma clave.
             Tus paradas, avisos e historial se conservan.</p>`
      }

      ${update.error ? notice('error', update.error) : ''}

      <div class="update-actions">
        ${
          needsPermission
            ? `<button class="btn btn-primary btn-block" type="button" data-action="open-install-settings">
                 Conceder permiso
               </button>`
            : `<button class="btn btn-primary btn-block" type="button" data-action="run-update" ${
                busy ? 'disabled' : ''
              }>${esc(updateButtonLabel())}</button>`
        }
      </div>

      ${
        busy
          ? ''
          : `<button class="btn btn-secondary btn-block" type="button" data-action="dismiss-update">
               Ahora no
             </button>`
      }

      ${
        update.phase === 'downloading'
          ? `<div class="update-bar"><span style="width:${
              update.percent >= 0 ? update.percent : 100
            }%" class="${update.percent < 0 ? 'is-indeterminate' : ''}"></span></div>`
          : ''
      }
    </section>
  `
}

/** El boton principal absorbe el estado en su etiqueta, sin anadir elementos. */
function updateButtonLabel(): string {
  const update = state.update

  switch (update.phase) {
    case 'downloading':
      return update.percent >= 0 ? `Descargando… ${update.percent} %` : 'Descargando…'
    case 'ready':
      return 'Instalar'
    case 'installing':
      return 'Abriendo el instalador…'
    case 'error':
      return 'Reintentar'
    default:
      return 'Actualizar'
  }
}

function renderBooting(): string {
  if (state.bootError) {
    return `
      ${notice('error', state.bootError)}
      <button class="btn btn-primary btn-block" type="button" data-action="retry-boot">Reintentar</button>
    `
  }

  return `
    <p class="text-muted">${esc(state.bootPhase)}</p>
    <div class="skeleton skeleton-row"></div>
    <div class="skeleton skeleton-row"></div>
    <div class="skeleton skeleton-row"></div>
  `
}

/* ================================================================== *
 * 1 · INICIO                                                          *
 * ================================================================== */

/**
 * Inicio absorbe "Mis paradas".
 *
 * Antes la pantalla abria con "Proximos autobuses" —una mezcla de llegadas de
 * todas las paradas guardadas— y las paradas en si vivian en otra pestaña. Eran
 * los mismos datos contados dos veces, y la lista mezclada no dejaba ver a que
 * parada pertenecia cada autobus. Ahora manda la parada: cada una con lo suyo,
 * en el mismo sitio donde se administran.
 */
function renderInicio(): string {
  const now = new Date()
  const favourites = state.favourites

  return `
    <section class="hero">
      <div class="hero-top">
        <div>
          <p class="hero-clock" data-live-clock>${esc(formatClock(now))}</p>
          <p class="hero-date">${esc(formatLongDate(now))}</p>
        </div>
        ${icon('bus')}
      </div>
      <div class="hero-stats">
        <div class="hero-stat"><strong>${favourites.length}</strong><span>Paradas</span></div>
        <div class="hero-stat"><strong>${state.follows.length}</strong><span>Seguimientos</span></div>
        <div class="hero-stat"><strong>${state.monitors.length}</strong><span>Controles</span></div>
      </div>
    </section>

    ${state.trackings
      .filter((job) => job.active)
      .map((job) => renderTrackingBanner(job))
      .join('')}

    ${renderFavourites()}
  `
}

function renderFavourites(): string {
  if (state.favourites.length === 0) {
    return `
      <section class="card"><div class="card-body">
        ${emptyState(
          'star',
          'Todavía no tienes paradas',
          'Guarda las paradas que más uses y las verás aquí con sus tiempos.',
          '<button class="btn btn-primary" type="button" data-action="tab" data-tab="buscar">Buscar una parada</button>',
        )}
      </div></section>
    `
  }

  return `
    <div class="section-head">
      <h2>Mis paradas</h2>
      <button class="btn btn-secondary btn-sm" type="button" data-action="tab" data-tab="buscar">
        ${icon('plus')} Añadir
      </button>
    </div>
    ${state.favourites.map((favourite) => renderFavouriteCard(favourite.stopId)).join('')}
  `
}

/**
 * Un aviso de proximo bus.
 *
 * No lleva interruptor de activar/pausar: un aviso creado esta siempre en
 * marcha. Pausarlo no significaba nada distinto de quitarlo —la notificacion
 * desaparecia igual— y era un boton mas que decidir en la tarjeta.
 */
function renderTrackingBanner(tracking: TrackingJob): string {
  const feed = feedOf(tracking.stopId)
  const arrival = feed?.arrivals.find((item) => item.lineId === tracking.lineId) ?? null
  const target = trackingBusTarget()

  // Con un solo autobus por aviso el contador no dice nada: sobra.
  const progress = target > 1
    ? `Autobús ${Math.min(tracking.busesSeen + 1, target)} de ${target} · `
    : ''

  return `
    <section class="card" data-key="tracking-${esc(tracking.id)}">
      <div class="card-head">
        ${lineChip(tracking.lineId, lineColor(tracking.lineId), 'lg')}
        <div class="card-head-copy">
          <h2 class="card-title">${esc(tracking.stopName)}</h2>
          <p class="card-sub">${esc(progress + describeArrival(tracking.stopId, tracking.lineId))}</p>
        </div>
        <div class="card-actions">
          <div class="arrival-eta">${
            arrival ? renderEta(arrival) : '<span class="eta-unit">buscando…</span>'
          }</div>
          <button class="mini-btn is-danger" type="button" data-action="stop-tracking" data-tracking="${esc(
            tracking.id,
          )}" aria-label="Detener el aviso">${icon('bellOff')}</button>
        </div>
      </div>
    </section>
  `
}

/**
 * Interruptor de una función de seguimiento.
 *
 * Una función en reposo no se borra: sigue creada y con su configuración, pero
 * no consulta ni publica notificación. Es lo que permite alternar entre las
 * cuatro que se pueden crear sin volver a montarlas cada vez.
 */
function renderJobToggle(kind: 'tracking' | 'follow', id: string, active: boolean): string {
  const full = !active && activeJobCount() >= MAX_ACTIVE_JOBS

  return `
    <button
      class="mini-btn${active ? ' is-on' : ''}"
      type="button"
      data-action="toggle-job"
      data-kind="${kind}"
      data-job="${esc(id)}"
      aria-label="${active ? 'Pausar' : 'Activar'}"
      title="${full ? `Se pausará la más antigua: solo ${MAX_ACTIVE_JOBS} pueden estar activas` : ''}"
    >${icon(active ? 'pause' : 'play')}</button>
  `
}

/* ================================================================== *
 * 2 · BUSCAR                                                          *
 * ================================================================== */

function renderBuscar(): string {
  const network = state.network
  if (!network) {
    return notice('error', 'La red oficial no está disponible.')
  }

  return `
    <div class="screen-intro">
      <h2>Buscar parada</h2>
      <p>Encuentra una parada por su nombre, recorriendo una línea o desde el mapa.</p>
    </div>

    <div class="segmented" role="tablist">
      ${renderSegment('nombre', 'Nombre')}
      ${renderSegment('linea', 'Línea')}
      ${renderSegment('mapa', 'Mapa')}
    </div>

    ${state.search.mode === 'nombre' ? renderSearchByName() : ''}
    ${state.search.mode === 'linea' ? renderSearchByLine() : ''}
    ${state.search.mode === 'mapa' ? renderSearchByMap() : ''}
  `
}

function renderSegment(mode: string, label: string): string {
  return `
    <button
      class="segmented-item"
      type="button"
      role="tab"
      data-action="search-mode"
      data-mode="${mode}"
      aria-selected="${state.search.mode === mode}"
    >${esc(label)}</button>
  `
}

function renderSearchByName(): string {
  const network = state.network
  if (!network) {
    return ''
  }

  const results = network.findStops(state.search.query, 40)

  return `
    <label class="field">
      <span class="sr-only">Nombre o código de parada</span>
      <input
        class="input"
        id="stop-query"
        type="search"
        inputmode="search"
        placeholder="Ej. Gran Vía, Canalejas, 103…"
        value="${esc(state.search.query)}"
        autocomplete="off"
      />
    </label>

    <div class="result-list">
      ${
        results.length === 0
          ? emptyState('search', 'Sin resultados', 'Prueba con otro nombre o con el número de parada.')
          : results.map((stop) => renderStopResult(stop)).join('')
      }
    </div>
  `
}

function renderSearchByLine(): string {
  const network = state.network
  if (!network) {
    return ''
  }

  const selectedLine = network.lineById.get(state.search.lineId) ?? null
  const direction = selectedLine?.directions.find((item) => item.key === state.search.directionKey) ?? null

  return `
    ${renderLineSelect()}
    ${renderDirectionSelect()}

    ${
      direction
        ? `<div class="result-list">
            ${direction.stops.map((stop, index) => renderStopResult(stop, index + 1)).join('')}
          </div>`
        : emptyState(
            'route',
            'Elige línea y sentido',
            'Los dos campos empiezan en “Seleccionar”: al completarlos aparecerán aquí las paradas en el orden del recorrido.',
          )
    }
  `
}

/**
 * Desplegable de línea. Arranca SIEMPRE en "Seleccionar": preseleccionar la
 * primera línea del listado hacía creer que ya se había elegido algo, y en el
 * mapa disparaba la pantalla completa sin que nadie la hubiera pedido.
 */
function renderLineSelect(): string {
  const network = state.network
  if (!network) {
    return ''
  }

  return `
    <label class="field">
      <span>Línea</span>
      <select class="select" data-action="pick-search-line">
        <option value="" ${state.search.lineId ? '' : 'selected'}>Seleccionar</option>
        ${network.lines
          .map(
            (line) =>
              `<option value="${esc(line.lineId)}" ${
                line.lineId === state.search.lineId ? 'selected' : ''
              }>${esc(line.name)}</option>`,
          )
          .join('')}
      </select>
    </label>
  `
}

function renderDirectionSelect(): string {
  const line = state.network?.lineById.get(state.search.lineId) ?? null

  return `
    <label class="field">
      <span>Sentido</span>
      <select class="select" data-action="pick-search-direction" ${line ? '' : 'disabled'}>
        <option value="" ${state.search.directionKey ? '' : 'selected'}>Seleccionar</option>
        ${(line?.directions ?? [])
          .map(
            (item) =>
              `<option value="${esc(item.key)}" ${
                item.key === state.search.directionKey ? 'selected' : ''
              }>${esc(directionLabel(item))}</option>`,
          )
          .join('')}
      </select>
    </label>
  `
}

function renderSearchByMap(): string {
  const network = state.network
  if (!network) {
    return ''
  }

  const direction = network.directionByKey.get(state.search.directionKey) ?? null
  const ready = Boolean(state.search.lineId && state.search.directionKey && direction)
  const expanded = state.search.mapExpanded

  return `
    ${renderLineSelect()}
    ${renderDirectionSelect()}

    ${renderMapShell(direction ? directionLabel(direction) : '')}
    <p class="text-tiny">
      ${
        !ready
          ? 'Elige la línea y después el sentido: al completar los dos campos el mapa se abre a pantalla completa con el recorrido.'
          : expanded
            ? 'Toca una parada para ver su ficha; cierra el mapa con la ✕ para volver al buscador.'
            : 'Toca una parada del mapa para ver su ficha, o pulsa “Ampliar” para verlo a pantalla completa.'
      }
    </p>
  `
}

/**
 * El contenedor del mapa es SIEMPRE el mismo nodo, tanto encajado como a
 * pantalla completa: Leaflet vive dentro (`data-morph="skip"`) y moverlo de
 * sitio obligaria a reconstruir el mapa entero en cada cambio.
 */
function renderMapShell(caption: string): string {
  const expanded = state.search.mapExpanded

  return `
    <div class="map-shell${expanded ? ' is-expanded' : ''}">
      <div id="stop-map" data-morph="skip"></div>
      ${
        expanded
          ? `
        <div class="map-caption">${esc(caption)}</div>
        <button class="map-close" type="button" data-action="collapse-map" aria-label="Cerrar el mapa">
          ${icon('close')}
        </button>
      `
          : `<button class="map-expand" type="button" data-action="expand-map" ${
              state.search.lineId && state.search.directionKey ? '' : 'disabled'
            }>${icon('map')} Ampliar</button>`
      }
    </div>
  `
}

export function directionLabel(direction: LineDirection): string {
  if (direction.circular) {
    return `${direction.origin} · circular`
  }

  const suffix = direction.partial ? ' · recorrido parcial' : ''
  return `${direction.origin} → ${direction.destination}${suffix}`
}

function renderStopResult(stop: NetworkStop, order?: number): string {
  const lines = state.network?.getLinesForStop(stop.stopId) ?? []

  return `
    <button
      class="result-item"
      type="button"
      data-action="select-stop"
      data-stop="${esc(stop.stopId)}"
      aria-selected="${state.search.selectedStopId === stop.stopId}"
    >
      <span class="stop-code">${esc(order ? String(order) : stop.stopId)}</span>
      <span class="result-copy">
        <span class="result-name">${esc(stop.stopName)}</span>
        <span class="chip-row">
          ${order ? `<span class="result-meta">Parada ${esc(stop.stopId)}</span>` : ''}
          ${lines
            .slice(0, 7)
            .map((line) => lineChip(line.lineId, line.color, 'sm'))
            .join('')}
          ${lines.length > 7 ? `<span class="result-meta">+${lines.length - 7}</span>` : ''}
        </span>
      </span>
      ${icon('chevron')}
    </button>
  `
}

/**
 * Ficha de la parada tocada en el buscador.
 *
 * Es una ventana y no un bloque al final de la pantalla: encajada abajo quedaba
 * por debajo del listado (y del mapa, que ocupa la pantalla entera), asi que
 * tocar una parada parecia no hacer nada hasta que se bajaba a buscarla.
 */
function renderStopDialog(): string {
  const stopId = state.search.selectedStopId
  if (!stopId || !state.ready) {
    return ''
  }

  const feed = feedOf(stopId)
  const saved = isFavourite(stopId)

  return `
    <button class="modal-backdrop" type="button" data-action="close-stop" aria-label="Cerrar"></button>
    <section class="modal stop-modal" role="dialog" aria-modal="true" aria-label="${esc(stopName(stopId))}">
      <div class="modal-head">
        <span class="stop-code">${esc(stopId)}</span>
        <div class="card-head-copy">
          <h2 class="card-title">${esc(stopName(stopId))}</h2>
          <p class="card-sub">${feedPill(feed)}</p>
        </div>
        <button class="mini-btn" type="button" data-action="close-stop" aria-label="Cerrar">${icon(
          'close',
        )}</button>
      </div>

      ${renderArrivals(stopId, feed)}

      <div class="btn-row">
        <button class="btn ${saved ? 'btn-secondary' : 'btn-primary'}" type="button" data-action="toggle-favourite" data-stop="${esc(
          stopId,
        )}">
          ${icon('star')} ${saved ? 'Quitar' : 'Guardar'}
        </button>
        <button class="btn btn-secondary" type="button" data-action="stop-actions" data-stop="${esc(stopId)}">
          ${icon('bell')} Avisos
        </button>
      </div>
    </section>
  `
}

/* ------------------------------------------------------------------ *
 * Tarjeta de parada guardada (dentro de Inicio)                        *
 * ------------------------------------------------------------------ */

/**
 * Una parada guardada.
 *
 * La cabecera lleva a la derecha actualizar / renombrar / quitar, no el tiempo
 * del proximo autobus: ese tiempo ya sale en la lista de llegadas al desplegar,
 * y ocupando la esquina obligaba a abrir la parada solo para poder gestionarla.
 */
function renderFavouriteCard(stopId: string): string {
  const feed = feedOf(stopId)
  const expanded = state.expandedStopId === stopId
  const label = favouriteLabel(stopId, stopName(stopId))
  const lines = state.network?.getLinesForStop(stopId) ?? []
  const syncing = state.stopSync[stopId] !== undefined
  // El nombre oficial solo aporta algo si la parada se ha renombrado.
  const official = label === stopName(stopId) ? '' : stopName(stopId)

  return `
    <section class="card">
      <div class="card-head">
        <button class="card-head-main" type="button" data-action="expand-stop" data-stop="${esc(
          stopId,
        )}" aria-expanded="${expanded}">
          <span class="stop-code">${esc(stopId)}</span>
          <span class="card-head-copy">
            <span class="card-title">${esc(label)}</span>
            <span class="card-sub${expanded ? '' : ' is-chips'}">${
              expanded
                ? esc(official)
                : lines
                    .slice(0, 8)
                    .map((line) => lineChip(line.lineId, line.color, 'sm'))
                    .join('')
            }</span>
          </span>
          ${icon(expanded ? 'chevronDown' : 'chevron')}
        </button>
        <span class="card-actions">
          <button class="mini-btn${syncing ? ' is-spinning' : ''}" type="button" data-action="refresh-stop" data-stop="${esc(
            stopId,
          )}" aria-label="Actualizar esta parada">${icon('refresh')}</button>
          <button class="mini-btn" type="button" data-action="rename-stop" data-stop="${esc(
            stopId,
          )}" aria-label="Cambiar nombre">${icon('pencil')}</button>
          <button class="mini-btn is-danger" type="button" data-action="remove-favourite" data-stop="${esc(
            stopId,
          )}" aria-label="Quitar parada">${icon('trash')}</button>
        </span>
      </div>

      ${
        expanded
          ? `
        <div class="card-divider"></div>
        <div class="card-body">
          ${feedPill(feed)}

          ${renderArrivals(stopId, feed)}

          <button class="btn btn-secondary btn-block" type="button" data-action="stop-actions" data-stop="${esc(stopId)}">
            ${icon('bell')} Avisos y seguimiento
          </button>
        </div>
      `
          : ''
      }
    </section>
  `
}

/* ------------------------------------------------------------------ *
 * Lista de llegadas reutilizable                                       *
 * ------------------------------------------------------------------ */

function renderArrivals(stopId: string, feed: StopFeed | undefined): string {
  if (!feed) {
    return `<div class="skeleton skeleton-row"></div><div class="skeleton skeleton-row"></div>`
  }

  if (feed.status === 'error') {
    return notice('error', feed.message ?? 'No se pudo consultar la fuente oficial.')
  }

  if (feed.arrivals.length === 0) {
    return emptyState(
      'clock',
      'Sin autobuses ahora',
      feed.message ?? 'La fuente oficial no devuelve llegadas para esta parada en este momento.',
    )
  }

  const staleClass = feed.status === 'throttled' ? ' stale' : ''

  // Solo las primeras ARRIVALS_PREVIEW. Una parada con doce líneas llenaba la
  // pantalla entera y empujaba fuera de la vista los botones de la tarjeta.
  const expanded = state.arrivalsExpanded[stopId] === true
  const hidden = feed.arrivals.length - ARRIVALS_PREVIEW
  const visible = expanded ? feed.arrivals : feed.arrivals.slice(0, ARRIVALS_PREVIEW)

  return `
    <div class="arrivals${staleClass}">
      ${visible.map((arrival) => renderArrivalRow(arrival, stopId, false)).join('')}
    </div>
    ${
      hidden > 0
        ? `<button class="btn btn-secondary btn-block btn-sm" type="button" data-action="${
            expanded ? 'collapse-arrivals' : 'expand-arrivals'
          }" data-stop="${esc(stopId)}">
             ${icon(expanded ? 'up' : 'down')} ${
              expanded ? 'Ver menos' : `Ver más (${hidden})`
            }
           </button>`
        : ''
    }
  `
}

function renderArrivalRow(arrival: Arrival, stopId: string, showStop: boolean): string {
  const meta = showStop
    ? `${stopName(stopId)} · ${arrival.estimatedClock}`
    : `${describeArrival(stopId, arrival.lineId)} · ${arrival.estimatedClock}`

  return `
    <article class="arrival${arrivalTone(arrival)}">
      ${lineChip(arrival.lineId, lineColor(arrival.lineId))}
      <div class="arrival-copy">
        <p class="arrival-dest">${esc(
          showStop ? describeArrival(stopId, arrival.lineId) : lineOf(arrival.lineId)?.title ?? `Línea ${arrival.lineId}`,
        )}</p>
        <p class="arrival-meta">${esc(meta)}</p>
      </div>
      <div class="arrival-eta">${renderEta(arrival)}</div>
    </article>
  `
}

/* ================================================================== *
 * 4 · SEGUIMIENTO                                                     *
 * ================================================================== */

/**
 * Seguir un autobus.
 *
 * La pantalla se ha vaciado de explicaciones a proposito: antes abria con un
 * parrafo, seguia con un aviso de cuantas funciones estaban activas y cada
 * tarjeta cerraba con otro parrafo sobre el ritmo de consulta. Con cuatro
 * tarjetas en pantalla era mas texto que datos. Lo que habia que saber (los
 * limites, como funciona) esta en Ajustes; aqui solo estan las funciones.
 */
function renderSeguimiento(): string {
  if (state.follows.length === 0 && state.trackings.length === 0) {
    return `
      <section class="card"><div class="card-body">
        ${emptyState(
          'route',
          'Sin seguimientos',
          'Abre una parada guardada y elige “Avisos y seguimiento”.',
          '<button class="btn btn-primary" type="button" data-action="tab" data-tab="inicio">Ir a mis paradas</button>',
        )}
      </div></section>
    `
  }

  return `
    ${renderJobGroup(
      'Avisos de próximo bus',
      `${state.trackings.length} de ${MAX_TRACKING_JOBS}`,
      'bell',
      state.trackings.map((job) => renderTrackingBanner(job)).join(''),
      state.trackings.length === 0 ? 'Sin avisos creados.' : '',
    )}

    ${renderJobGroup(
      'Ver por dónde viene',
      `${state.follows.length} de ${MAX_FOLLOW_JOBS}`,
      'route',
      state.follows.map((follow) => renderFollowCard(follow.id)).join(''),
      state.follows.length === 0 ? 'Sin seguimientos creados.' : '',
    )}
  `
}

/** Agrupa las funciones por modalidad, con el margen que queda en el titulo. */
function renderJobGroup(
  title: string,
  subtitle: string,
  iconName: string,
  body: string,
  emptyMessage: string,
): string {
  return `
    <section class="job-group">
      <header class="job-group-head">
        ${icon(iconName)}
        <div class="job-group-copy">
          <h3>${esc(title)}</h3>
        </div>
        <span class="job-group-count">${esc(subtitle)}</span>
      </header>
      ${emptyMessage ? `<p class="job-group-empty">${esc(emptyMessage)}</p>` : body}
    </section>
  `
}

function renderFollowCard(followId: string): string {
  const follow = state.follows.find((item) => item.id === followId)
  const network = state.network
  if (!follow || !network) {
    return ''
  }

  const windowStops = network.getDirectionWindow(follow.directionKey, follow.stopId, 8)
  const direction = network.directionByKey.get(follow.directionKey)

  // Se marca como "bus aquí" la parada mas cercana al final de la ventana que
  // tenga una llegada inminente de esta linea.
  let busIndex = -1
  const etas = windowStops.map((stop, index) => {
    const feed = feedOf(stop.stopId)
    const arrival = feed?.arrivals
      .filter((item) => item.lineId === follow.lineId)
      .sort((left, right) => liveMinutes(left) - liveMinutes(right))[0]

    if (arrival && liveMinutes(arrival) <= 1 && index > busIndex) {
      busIndex = index
    }

    return { stop, arrival, feed }
  })

  return `
    <section class="card${follow.active ? '' : ' is-paused'}" data-key="follow-${esc(follow.id)}">
      <div class="card-head">
        ${lineChip(follow.lineId, lineColor(follow.lineId), 'lg')}
        <div class="card-head-copy">
          <h2 class="card-title">${esc(follow.stopName)}</h2>
          <p class="card-sub">${esc(direction ? directionLabel(direction) : `Línea ${follow.lineId}`)}</p>
        </div>
        <div class="card-actions">
          ${renderJobToggle('follow', follow.id, follow.active)}
          <button class="mini-btn is-danger" type="button" data-action="remove-follow" data-follow="${esc(
            follow.id,
          )}" aria-label="Quitar seguimiento">${icon('trash')}</button>
        </div>
      </div>
      <div class="card-body">
        ${
          follow.active
            ? ''
            : '<p class="text-tiny">En pausa. Se detiene sola al salir de esta pestaña.</p>'
        }
        ${
          windowStops.length === 0
            ? notice('warn', 'No se pudo reconstruir el recorrido de esta línea.')
            : `<div class="timeline">${etas
                .map(({ stop, arrival, feed }, index) => {
                  const isTarget = stop.stopId === follow.stopId
                  const isBus = index === busIndex
                  const classes = [isTarget ? 'is-target' : '', isBus ? 'is-bus' : ''].filter(Boolean).join(' ')
                  const eta = arrival
                    ? liveMinutes(arrival) <= 0
                      ? 'aquí'
                      : `${liveMinutes(arrival)} min`
                    : '—'

                  return `
                    <div class="timeline-stop ${classes}">
                      <div class="timeline-rail"><span class="timeline-dot"></span></div>
                      <span class="timeline-name">${esc(stop.stopName)}</span>
                      <span class="timeline-eta">${esc(eta)}</span>
                      ${syncDot(feed, state.stopSync[stop.stopId])}
                    </div>
                  `
                })
                .join('')}</div>
              ${renderSyncLegend()}`
        }
      </div>
    </section>
  `
}

/**
 * Los tiempos de una parada y de la siguiente pueden llevar medio minuto de
 * diferencia porque se piden en serie. La leyenda explica el codigo de color
 * para que esa diferencia no se lea como un error.
 */
function renderSyncLegend(): string {
  const items: Array<[string, string]> = [
    ['loading', 'Consultando'],
    ['queued', 'En cola'],
    ['fresh', 'Al día'],
    ['aged', 'Dato antiguo'],
    ['error', 'Sin datos'],
  ]

  return `
    <div class="sync-legend">
      ${items
        .map(([tone, label]) => `<span class="sync-legend-item"><span class="sync-dot is-${tone}"></span>${esc(
          label,
        )}</span>`)
        .join('')}
    </div>
  `
}

/* ================================================================== *
 * 5 · PUNTUALIDAD (monitorización)                                    *
 * ================================================================== */

function renderMonitor(): string {
  if (state.monitors.length === 0) {
    return `
      <div class="screen-intro">
        <h2>Puntualidad</h2>
        <p>Compara el horario oficial con la hora real a la que pasa tu autobús.</p>
      </div>
      <section class="card"><div class="card-body">
        ${emptyState(
          'chart',
          'Sin controles de puntualidad',
          'Elige una parada guardada, una línea y una franja horaria; la app irá anotando a qué hora pasa realmente.',
          '<button class="btn btn-primary" type="button" data-action="tab" data-tab="inicio">Ir a mis paradas</button>',
        )}
      </div></section>
    `
  }

  return `
    <div class="screen-intro">
      <h2>Puntualidad</h2>
      <p>Media de paso real observada frente al horario programado.</p>
    </div>
    ${state.schedule?.stale ? notice('warn', scheduleStaleMessage()) : ''}
    ${state.monitors.map((monitor) => renderMonitorCard(monitor)).join('')}
  `
}

function scheduleStaleMessage(): string {
  const validTo = state.schedule?.validTo
  return validTo
    ? `El horario oficial incluido caduca el ${validTo}. Las horas programadas son orientativas hasta actualizar el GTFS.`
    : 'El horario oficial incluido no declara fechas de validez; las horas programadas son orientativas.'
}

function renderMonitorCard(monitor: MonitorJob): string {
  const dayType = state.monitorDayView[monitor.id] ?? currentDayType()
  const summary = summariseMonitor(monitor, dayType)
  const active = isWithinWindow(monitor)
  const seenAt = state.monitorSeenAt[monitor.id] ?? null
  const runtime = state.monitorRuntime[monitor.id]
  const directions = state.network?.getDirectionsThroughStop(monitor.stopId, monitor.lineId) ?? []
  const direction = monitor.directionKey
    ? state.network?.directionByKey.get(monitor.directionKey) ?? null
    : null

  const statusPill = active
    ? runtime?.armed
      ? '<span class="pill is-warn is-live">Autobús entrando</span>'
      : `<span class="pill is-ok is-live">Observando · ${esc(formatAge(seenAt))}</span>`
    : `<span class="pill">Empieza a las ${esc(formatMinutesClock(monitor.startMinutes))}</span>`

  return `
    <section class="card" data-key="monitor-${esc(monitor.id)}">
      <div class="card-head">
        ${lineChip(monitor.lineId, lineColor(monitor.lineId), 'lg')}
        <div class="card-head-copy">
          <h2 class="card-title">${esc(monitor.stopName)}</h2>
          <p class="card-sub is-wrap">${esc(formatMinutesClock(monitor.startMinutes))} – ${esc(
            formatMinutesClock(monitor.endMinutes),
          )} · ${esc(direction ? `hacia ${direction.destination}` : 'todos los sentidos')}</p>
        </div>
        <div class="card-actions">
          ${statusPill}
          <button class="mini-btn is-danger" type="button" data-action="remove-monitor" data-monitor="${esc(
            monitor.id,
          )}" aria-label="Quitar control">${icon('trash')}</button>
        </div>
      </div>
      <div class="card-body">
        <label class="field">
          <span>Tipo de día</span>
          <select class="select" data-action="monitor-day" data-monitor="${esc(monitor.id)}">
            <option value="weekday" ${dayType === 'weekday' ? 'selected' : ''}>Laborable (L–V)</option>
            <option value="saturday" ${dayType === 'saturday' ? 'selected' : ''}>Sábado</option>
            <option value="sunday" ${dayType === 'sunday' ? 'selected' : ''}>Domingo y festivos</option>
          </select>
        </label>

        ${
          !monitor.directionKey && directions.filter((item) => !item.partial).length > 1
            ? notice(
                'warn',
                'Por esta parada pasan varios sentidos de la línea y este control no fijó ninguno: el horario programado los mezcla. Crea otro control eligiendo el sentido para una medición fiable.',
              )
            : ''
        }

        ${
          summary.rows.length === 0
            ? emptyState(
                'clock',
                'Sin pasos programados',
                'El horario oficial no recoge salidas de esta línea por esta parada en la franja elegida. Los pasos que se detecten se guardarán igualmente más abajo.',
              )
            : `
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr><th>Programado</th><th>Real medio</th><th>Desvío</th></tr>
              </thead>
              <tbody>
                ${summary.rows.map((row) => renderMonitorRow(row)).join('')}
              </tbody>
            </table>
          </div>
        `
        }

        ${renderMonitorPasses(summary.unmatched)}

        <p class="text-tiny">
          ${esc(monitorFootnote(monitor, summary.passes.length, summary.days, active))}
        </p>
      </div>
    </section>
  `
}

/** Explica en una línea qué se ha recogido y qué falta para que la tabla se llene. */
function monitorFootnote(monitor: MonitorJob, passes: number, days: number, active: boolean): string {
  if (passes === 0) {
    return active
      ? 'Todavía sin pasos registrados. La app está consultando esta parada; cada autobús detectado aparecerá aquí.'
      : `Todavía sin pasos registrados. La medición solo funciona con la app abierta entre las ${formatMinutesClock(
          monitor.startMinutes,
        )} y las ${formatMinutesClock(monitor.endMinutes)}.`
  }

  return `${passes} paso${passes === 1 ? '' : 's'} registrado${passes === 1 ? '' : 's'} en ${days} día${
    days === 1 ? '' : 's'
  }. Cada día cuenta una sola vez por salida programada.`
}

function renderMonitorRow(row: MonitorRow): string {
  if (row.average === null || row.delta === null) {
    return `<tr data-key="slot-${esc(row.slot)}"><td class="is-num">${esc(
      row.slot,
    )}</td><td class="text-muted">sin datos</td><td>—</td></tr>`
  }

  const deltaClass = row.delta > 1 ? 'is-late' : row.delta < -1 ? 'is-early' : 'is-ontime'
  const deltaText = row.delta === 0 ? 'en hora' : `${row.delta > 0 ? '+' : ''}${row.delta} min`

  return `
    <tr data-key="slot-${esc(row.slot)}">
      <td class="is-num">${esc(row.slot)}</td>
      <td class="is-num">${esc(formatMinutesClock(row.average))}<span class="sample-count">${
        row.samples
      }</span></td>
      <td><span class="delta ${deltaClass}">${esc(deltaText)}</span></td>
    </tr>
  `
}

/**
 * Pasos detectados que no encajan con ninguna salida programada de la franja.
 * Se enseñan en vez de descartarlos: son la prueba de que la app está midiendo y
 * la señal más clara de que el horario oficial se ha quedado atrás.
 */
function renderMonitorPasses(passes: Array<{ at: number, minutes: number }>): string {
  if (passes.length === 0) {
    return ''
  }

  return `
    <div class="stack-sm">
      <h4 class="section-title">Pasos sin horario programado</h4>
      <ul class="chip-list">
        ${passes
          .map(
            (pass) =>
              `<li class="chip" data-key="pass-${pass.at}">${esc(
                formatMinutesClock(pass.minutes),
              )}<span class="chip-note">${esc(
                new Date(pass.at).toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit' }),
              )}</span></li>`,
          )
          .join('')}
      </ul>
    </div>
  `
}

/* ================================================================== *
 * Tour de bienvenida                                                  *
 * ================================================================== */

interface TourStep {
  iconName: string
  title: string
  body: string
}

/**
 * Recorrido mínimo por las pestañas inferiores.
 *
 * Se abre solo la primera vez que se arranca cada versión: es el único momento
 * en que hay algo nuevo que contar, y termina en los permisos porque sin ellos
 * los avisos no funcionan y nada en la pantalla principal lo delata.
 */
const TOUR: TourStep[] = [
  {
    iconName: 'home',
    title: 'Inicio',
    body: 'El reloj, tus avisos en marcha y tus paradas guardadas. Toca una parada para ver sus llegadas; los botones de la derecha la actualizan, la renombran o la quitan.',
  },
  {
    iconName: 'search',
    title: 'Buscar',
    body: 'Encuentra una parada por su nombre, recorriendo una línea o tocándola en el mapa.',
  },
  {
    iconName: 'route',
    title: 'Seguir',
    body: 'Avisos de próximo bus, que llegan aunque cierres la app, y el recorrido parada a parada de la línea que elijas.',
  },
  {
    iconName: 'chart',
    title: 'Puntualidad',
    body: 'Elige una parada, una línea y una franja: la app anota a qué hora pasa de verdad y la compara con el horario.',
  },
  {
    iconName: 'settings',
    title: 'Ajustes',
    body: 'Desde el engranaje de arriba: permisos, cuántos autobuses sigue cada aviso, actualizaciones y el registro.',
  },
  {
    iconName: 'bell',
    title: 'Permisos que hay que conceder',
    body: 'Notificaciones, para que el aviso pueda mostrarse; y sin optimización de batería, para que siga actualizándose con la pantalla apagada.',
  },
]

/** Pasos del tour; `main.ts` lo necesita para saber cuándo se ha acabado. */
export const TOUR_STEPS = TOUR.length

function renderTour(): string {
  if (!state.tour.open || !state.ready) {
    return ''
  }

  const index = Math.min(state.tour.step, TOUR.length - 1)
  const step = TOUR[index]
  const last = index === TOUR.length - 1

  return `
    <div class="tour-backdrop"></div>
    <section class="tour" role="dialog" aria-modal="true" aria-label="Novedades de SALBUS">
      <header class="tour-head">
        <span class="tour-badge">${esc(APP_VERSION)}</span>
        <button class="mini-btn" type="button" data-action="tour-close" aria-label="Cerrar el tour">
          ${icon('close')}
        </button>
      </header>

      <div class="tour-body">
        <div class="tour-icon">${icon(step.iconName)}</div>
        <h3>${esc(step.title)}</h3>
        <p>${esc(step.body)}</p>
      </div>

      ${
        last
          ? `<div class="tour-perms">
              ${renderPermissionRow(
                'Notificaciones',
                'Permite mostrar el aviso con los minutos que faltan.',
                state.permissions.notifications,
                'request-notifications',
              )}
              ${renderPermissionRow(
                'Sin optimización de batería',
                'Evita que Android detenga las actualizaciones.',
                state.permissions.battery,
                'request-battery',
              )}
            </div>`
          : ''
      }

      <div class="tour-dots">
        ${TOUR.map(
          (_, position) =>
            `<span class="tour-dot${position === index ? ' is-current' : ''}"></span>`,
        ).join('')}
      </div>

      <div class="btn-row">
        <button class="btn btn-secondary" type="button" data-action="tour-back" ${
          index === 0 ? 'disabled' : ''
        }>Atrás</button>
        <button class="btn btn-primary" type="button" data-action="tour-next">
          ${last ? 'Empezar' : 'Siguiente'}
        </button>
      </div>
    </section>
  `
}

/* ================================================================== *
 * 6 · AJUSTES                                                         *
 * ================================================================== */

function renderAjustes(): string {
  const health = getClientHealth()
  const network = state.network

  return `
    <div class="screen-intro">
      <h2>Ajustes</h2>
      <p>Permisos, origen de los datos y diagnóstico.</p>
    </div>

    <section class="card">
      <div class="card-head"><div class="card-head-copy">
        <h3 class="card-title">Permisos</h3>
        <p class="card-sub">Necesarios para los avisos en segundo plano</p>
      </div></div>
      <div class="card-body">
        ${renderPermissionRow(
          'Notificaciones',
          'Permite mostrar el aviso persistente con los minutos que faltan.',
          state.permissions.notifications,
          'request-notifications',
        )}
        ${renderPermissionRow(
          'Sin optimización de batería',
          'Evita que Android detenga las actualizaciones con la pantalla apagada.',
          state.permissions.battery,
          'request-battery',
        )}
      </div>
    </section>

    ${renderTrackingRulesCard()}

    ${renderUpdateCard()}

    <section class="card">
      <div class="card-head"><div class="card-head-copy">
        <h3 class="card-title">Origen de los datos</h3>
        <p class="card-sub">Todo procede de Salamanca de Transportes</p>
      </div></div>
      <div class="card-body">
        <dl class="kv">
          <dt>Llegadas en tiempo real</dt><dd>Web oficial</dd>
          <dt>Líneas y recorridos</dt><dd>${network?.lineCount ?? 0} líneas · ${network?.directionCount ?? 0} sentidos</dd>
          <dt>Red descargada</dt><dd>${esc(network ? new Date(network.generatedAt).toLocaleDateString('es-ES') : '—')}</dd>
          <dt>Horario programado</dt><dd>${esc(
            state.schedule?.validFrom && state.schedule?.validTo
              ? `${state.schedule.validFrom} → ${state.schedule.validTo}`
              : 'no disponible',
          )}</dd>
        </dl>
        ${state.scheduleError ? notice('warn', state.scheduleError) : ''}
        ${state.schedule?.stale ? notice('warn', scheduleStaleMessage()) : ''}
      </div>
    </section>

    <section class="card">
      <div class="card-head"><div class="card-head-copy">
        <h3 class="card-title">Consultas a la fuente</h3>
        <p class="card-sub">La app espacia las peticiones para no ser bloqueada</p>
      </div></div>
      <div class="card-body">
        <dl class="kv">
          <dt>Espaciado actual</dt><dd>${(health.spacingMs / 1000).toFixed(1)} s</dd>
          <dt>En cola</dt><dd>${health.queued}</dd>
          <dt>Consultas realizadas</dt><dd>${health.requestCount}</dd>
          <dt>Bloqueos recibidos</dt><dd>${health.throttleEvents}</dd>
          <dt>Errores de red</dt><dd>${health.errorCount}</dd>
        </dl>
        <p class="text-tiny">
          La web oficial limita las consultas por IP (unas 6–8 seguidas y después bloquea unos segundos).
          SALBUS las envía de una en una cada ${(MIN_REQUEST_SPACING_MS / 1000).toFixed(0)} s, que es el ritmo
          máximo sostenible medido, y reutiliza la respuesta durante unos segundos.
        </p>
      </div>
    </section>

    <section class="card">
      <div class="card-head">
        <div class="card-head-copy">
          <h3 class="card-title">Registro</h3>
          <p class="card-sub">Últimos eventos de la aplicación</p>
        </div>
        <div class="card-actions">
          <button class="mini-btn" type="button" data-action="clear-logs" aria-label="Vaciar registro">${icon(
            'trash',
          )}</button>
        </div>
      </div>
      <div class="card-body">
        ${
          state.logs.length === 0
            ? '<p class="text-muted">Sin eventos registrados.</p>'
            : `<div class="log-list">${state.logs
                .slice(0, 60)
                .map(
                  (entry) => `
                    <div class="log-item is-${entry.level}">
                      <span class="log-time">${esc(formatClock(new Date(entry.at)))}</span>
                      <span><span class="log-scope">${esc(entry.scope)}</span> · ${esc(entry.message)}</span>
                    </div>
                  `,
                )
                .join('')}</div>`
        }
      </div>
    </section>

    <p class="text-tiny" style="text-align:center">SALBUS ${esc(APP_VERSION)}</p>
  `
}

/**
 * Comprobacion MANUAL. La automatica del arranque se calla los errores para no
 * molestar, y el precio de ese diseno es que un fallo real (repositorio
 * privado, sin cobertura, GitHub limitando) se ve exactamente igual que «no hay
 * novedades». Esta es la unica forma de distinguir «no hay nada» de «está roto».
 */
function renderUpdateCard(): string {
  const update = state.update
  const message = update.manualMessage

  return `
    <section class="card">
      <div class="card-head"><div class="card-head-copy">
        <h3 class="card-title">Actualizaciones</h3>
        <p class="card-sub">Se publican solas en cada cambio del proyecto</p>
      </div></div>
      <div class="card-body">
        <dl class="kv">
          <dt>Versión instalada</dt><dd>v${esc(state.installed.versionName)} · compilación ${state.installed.versionCode}</dd>
          <dt>Instalar apps desconocidas</dt><dd>${update.canInstall ? 'concedido' : 'sin conceder'}</dd>
        </dl>
        ${message ? notice(message.tone, message.text) : ''}
        <div class="btn-row">
          <button class="btn btn-secondary" type="button" data-action="check-update" ${
            update.manualChecking ? 'disabled' : ''
          }>
            ${icon('refresh')} ${update.manualChecking ? 'Comprobando…' : 'Buscar actualización'}
          </button>
          ${
            update.canInstall
              ? ''
              : `<button class="btn btn-secondary" type="button" data-action="open-install-settings">
                   ${icon('settings')} Permiso de instalación
                 </button>`
          }
        </div>
        <p class="text-tiny">
          Android no permite que una aplicación se instale sola: SALBUS comprueba, descarga y prepara
          la versión nueva, y el último paso lo confirmas tú en el diálogo del sistema.
        </p>
      </div>
    </section>
  `
}

/**
 * Cómo funcionan las funciones de seguimiento, en esquema.
 *
 * Los límites (dos por modalidad, dos activas) se notan al chocar con ellos, y
 * sin explicarlos en alguna parte la ventana que pide sustituir una función
 * parece un fallo en vez de una regla.
 */
function renderTrackingRulesCard(): string {
  return `
    <section class="card">
      <div class="card-head"><div class="card-head-copy">
        <h3 class="card-title">Seguimiento</h3>
        <p class="card-sub">Cuántas funciones puedes tener y cuántas trabajan a la vez</p>
      </div></div>
      <div class="card-body">
        <label class="field">
          <span>Autobuses por aviso</span>
          <select class="select" data-action="pick-bus-target">
            ${Array.from({ length: TRACKING_BUS_TARGET_MAX }, (_, index) => index + 1)
              .map(
                (value) =>
                  `<option value="${value}" ${value === trackingBusTarget() ? 'selected' : ''}>${
                    value === 1 ? 'Solo el próximo' : `${value} autobuses seguidos`
                  }</option>`,
              )
              .join('')}
          </select>
        </label>
        <p class="text-tiny">
          El aviso termina solo cuando ha visto pasar esa cantidad. Los avisos ya creados
          siguen con el número que haya elegido aquí.
        </p>

        <dl class="kv">
          <dt>Avisos de próximo bus</dt><dd>máximo ${MAX_TRACKING_JOBS} creados</dd>
          <dt>Ver por dónde viene</dt><dd>máximo ${MAX_FOLLOW_JOBS} creados</dd>
          <dt>Activas a la vez</dt><dd>${MAX_ACTIVE_JOBS} en total, de cualquier tipo</dd>
          <dt>Al crear una de más</dt><dd>se pide sustituir una de esa modalidad</dd>
          <dt>Al salir de la pestaña Seguir</dt><dd>los recorridos se pausan solos</dd>
        </dl>

        ${renderSettingRow(
          'vibrate',
          'Vibración al acercarse',
          `Un toque corto cuando faltan ${TRACKING_WARN_MINUTES} minutos, una sola vez por autobús.`,
          state.settings.vibrateOnApproach,
          'toggle-vibration',
        )}

        <button class="btn btn-secondary btn-block" type="button" data-action="tour-open">
          ${icon('info')} Ver el tour de la aplicación
        </button>
      </div>
    </section>
  `
}

function renderSettingRow(
  iconName: string,
  title: string,
  description: string,
  enabled: boolean,
  action: string,
): string {
  return `
    <div class="perm-row">
      <div class="perm-copy">
        <strong>${esc(title)}</strong>
        <span>${esc(description)}</span>
      </div>
      <button
        class="switch${enabled ? ' is-on' : ''}"
        type="button"
        role="switch"
        aria-checked="${enabled}"
        data-action="${action}"
        aria-label="${esc(title)}"
      ><span class="switch-knob">${icon(iconName, 'switch-icon')}</span></button>
    </div>
  `
}

function renderPermissionRow(title: string, description: string, granted: string, action: string): string {
  const pill =
    granted === 'granted'
      ? '<span class="pill is-ok">Concedido</span>'
      : granted === 'denied'
        ? '<span class="pill is-error">Denegado</span>'
        : '<span class="pill is-warn">Pendiente</span>'

  return `
    <div class="perm-row">
      <div class="perm-copy">
        <strong>${esc(title)}</strong>
        <span>${esc(description)}</span>
      </div>
      ${
        granted === 'granted'
          ? pill
          : `<button class="btn btn-secondary btn-sm" type="button" data-action="${action}">Permitir</button>`
      }
    </div>
  `
}

/* ================================================================== *
 * Hojas inferiores                                                    *
 * ================================================================== */

function renderSheet(): string {
  const sheet = state.sheet
  if (!sheet) {
    return ''
  }

  const body =
    sheet.kind === 'stop-actions'
      ? renderStopActionsSheet(sheet.stopId)
      : sheet.kind === 'pick-line'
        ? renderPickLineSheet(sheet.stopId, sheet.purpose)
        : sheet.kind === 'replace-job'
          ? renderReplaceJobSheet(sheet.stopId, sheet.purpose)
          : renderRenameSheet(sheet.stopId)

  return `
    <button class="sheet-backdrop" type="button" data-action="close-sheet" aria-label="Cerrar"></button>
    <section class="sheet" role="dialog" aria-modal="true">
      <div class="sheet-grip"></div>
      ${body}
    </section>
  `
}

function renderStopActionsSheet(stopId: string): string {
  return `
    <div class="sheet-head">
      <h3>${esc(stopName(stopId))}</h3>
      <p>Parada ${esc(stopId)}</p>
    </div>
    <div class="sheet-options">
      <button class="sheet-option" type="button" data-action="pick-line" data-stop="${esc(
        stopId,
      )}" data-purpose="tracking">
        ${icon('bell')}
        <span class="sheet-option-copy">
          <strong>Avisarme del próximo bus</strong>
          <span>Notificación fija con los minutos que faltan · ${state.trackings.length} de ${MAX_TRACKING_JOBS} creados.</span>
        </span>
      </button>
      <button class="sheet-option" type="button" data-action="pick-line" data-stop="${esc(
        stopId,
      )}" data-purpose="follow">
        ${icon('route')}
        <span class="sheet-option-copy">
          <strong>Ver por dónde viene</strong>
          <span>Las paradas anteriores y en cuál está el autobús · ${state.follows.length} de ${MAX_FOLLOW_JOBS} creados.</span>
        </span>
      </button>
      <button class="sheet-option" type="button" data-action="pick-line" data-stop="${esc(
        stopId,
      )}" data-purpose="monitor">
        ${icon('chart')}
        <span class="sheet-option-copy">
          <strong>Medir puntualidad</strong>
          <span>Anota a qué hora pasa realmente en una franja horaria.</span>
        </span>
      </button>
    </div>
  `
}

/**
 * Se ha alcanzado el tope de esa modalidad.
 *
 * En vez de rechazar la acción con un error, se enseña lo que ya hay y se pide
 * cuál se sustituye: la persona ya ha decidido que quiere esta función nueva, y
 * lo único que falta por saber es a costa de cuál.
 */
function renderReplaceJobSheet(stopId: string, purpose: 'tracking' | 'follow'): string {
  const isTracking = purpose === 'tracking'
  const limit = isTracking ? MAX_TRACKING_JOBS : MAX_FOLLOW_JOBS
  const title = isTracking ? 'Avisarme del próximo bus' : 'Ver por dónde viene'

  const jobs: Array<{ id: string, lineId: string, stopName: string, meta: string, active: boolean }> =
    isTracking
      ? state.trackings.map((job) => ({
          id: job.id,
          lineId: job.lineId,
          stopName: job.stopName,
          meta: describeArrival(job.stopId, job.lineId),
          active: job.active,
        }))
      : state.follows.map((job) => ({
          id: job.id,
          lineId: job.lineId,
          stopName: job.stopName,
          meta: (() => {
            const direction = state.network?.directionByKey.get(job.directionKey)
            return direction ? directionLabel(direction) : `Línea ${job.lineId}`
          })(),
          active: job.active,
        }))

  return `
    <div class="sheet-head">
      <h3>${esc(title)}</h3>
      <p>Ya tienes ${limit} de ${limit}. Elige cuál se sustituye por la de ${esc(stopName(stopId))}.</p>
    </div>

    <div class="sheet-options">
      ${jobs
        .map(
          (job) => `
        <button class="sheet-option" type="button" data-action="replace-job" data-stop="${esc(
          stopId,
        )}" data-purpose="${purpose}" data-job="${esc(job.id)}">
          ${lineChip(job.lineId, lineColor(job.lineId))}
          <span class="sheet-option-copy">
            <strong>${esc(job.stopName)}</strong>
            <span>${esc(job.meta)} · ${job.active ? 'activa' : 'en pausa'}</span>
          </span>
          ${icon('chevron')}
        </button>
      `,
        )
        .join('')}
    </div>

    <button class="btn btn-secondary btn-block" type="button" data-action="close-sheet">
      Dejarlo como está
    </button>
  `
}

function renderPickLineSheet(stopId: string, purpose: 'tracking' | 'monitor' | 'follow'): string {
  const network = state.network
  const lines = network?.getLinesForStop(stopId) ?? []
  const selectedLineId = state.draft.lineId || lines[0]?.lineId || ''
  const directions = selectedLineId ? network?.getDirectionsThroughStop(stopId, selectedLineId) ?? [] : []

  const title =
    purpose === 'tracking' ? 'Avisarme del próximo bus' : purpose === 'follow' ? 'Ver por dónde viene' : 'Medir puntualidad'

  if (lines.length === 0) {
    return `
      <div class="sheet-head"><h3>${esc(title)}</h3></div>
      ${notice('warn', 'La red oficial no registra líneas para esta parada.')}
    `
  }

  return `
    <div class="sheet-head">
      <h3>${esc(title)}</h3>
      <p>${esc(stopName(stopId))}</p>
    </div>

    <label class="field">
      <span>Línea</span>
      <select class="select" data-action="draft-line" data-stop="${esc(stopId)}">
        ${lines
          .map(
            (line) =>
              `<option value="${esc(line.lineId)}" ${line.lineId === selectedLineId ? 'selected' : ''}>${esc(
                line.name,
              )}</option>`,
          )
          .join('')}
      </select>
    </label>

    ${
      purpose === 'tracking'
        ? ''
        : `
      <label class="field">
        <span>Sentido</span>
        <select class="select" data-action="draft-direction">
          ${directions
            .map(
              (direction) =>
                `<option value="${esc(direction.key)}" ${
                  direction.key === state.draft.directionKey ? 'selected' : ''
                }>${esc(directionLabel(direction))}</option>`,
            )
            .join('')}
          ${
            purpose === 'monitor'
              ? `<option value="" ${state.draft.directionKey ? '' : 'selected'}>Todos los sentidos</option>`
              : ''
          }
        </select>
      </label>
      ${
        purpose === 'monitor'
          ? '<span class="text-tiny">El horario programado se filtra por el sentido elegido; sin él las salidas de ida y vuelta se mezclan.</span>'
          : ''
      }
    `
    }

    ${
      purpose === 'monitor'
        ? `
      <div class="field">
        <span>Franja horaria</span>
        <div class="input-group">
          <input class="input" type="time" step="900" value="${esc(
            formatMinutesClock(state.draft.startMinutes),
          )}" data-action="draft-start" />
          <input class="input" type="time" step="900" value="${esc(
            formatMinutesClock(state.draft.endMinutes),
          )}" data-action="draft-end" />
        </div>
        <span class="text-tiny">Entre 15 minutos y 2 horas.</span>
      </div>
    `
        : ''
    }

    <button class="btn btn-primary btn-block" type="button" data-action="confirm-sheet" data-stop="${esc(
      stopId,
    )}" data-purpose="${purpose}">
      ${icon('check')} Confirmar
    </button>
  `
}

function renderRenameSheet(stopId: string): string {
  return `
    <div class="sheet-head">
      <h3>Nombre de la parada</h3>
      <p>${esc(stopName(stopId))}</p>
    </div>
    <label class="field">
      <span>Nombre personalizado</span>
      <input class="input" id="alias-input" type="text" maxlength="40" placeholder="${esc(
        stopName(stopId),
      )}" value="${esc(state.draft.alias)}" />
      <span class="text-tiny">Déjalo vacío para usar el nombre oficial.</span>
    </label>
    <button class="btn btn-primary btn-block" type="button" data-action="confirm-rename" data-stop="${esc(stopId)}">
      ${icon('check')} Guardar
    </button>
  `
}

