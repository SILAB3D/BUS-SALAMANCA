import { getClientHealth, MIN_REQUEST_SPACING_MS } from './services/arrivals'
import {
  nearestStops,
  type BusLeg,
  type Itinerary,
  type NearbyStop,
  type RouteLeg,
} from './services/routing'
import {
  describeStopsAway,
  locateBus,
  ROUTE_SCAN_MAX_MINUTES,
  ROUTE_FIX_MAX_AGE_MS,
  ROUTE_WINDOW_STOPS,
  stopsAwayFrom,
} from './services/bus-position'
import { currentDayType } from './services/schedule'
import {
  activeJobCount,
  APP_VERSION,
  AUTO_CYCLE_MS,
  FRESHNESS,
  ARRIVALS_PREVIEW,
  favouriteLabel,
  formatMinutesClock,
  isFavourite,
  isWithinWindow,
  MAX_ACTIVE_JOBS,
  MAX_TRACKING_JOBS,
  state,
  TRACKING_INTERVAL_SECONDS,
  type MonitorTrace,
  summariseMonitor,
  trackingBusTarget,
  TRACKING_BUS_TARGET_MAX,
  TRACKING_WARN_MINUTES,
  type MonitorJob,
  type MonitorRow,
  type RoutePoint,
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

/**
 * Sentidos entre los que puede venir el autobús de un aviso en esa parada.
 *
 * Con uno solo no hay nada que preguntar. Con varios sí, y hay que preguntarlo:
 * la fuente oficial dice "Línea 4, 7 minutos" y nunca hacia dónde va, así que la
 * única forma de saber por qué recorrido viene es que lo diga quien está
 * esperando —que lo sabe, porque es el autobús que quiere coger—.
 *
 * Los trayectos parciales son variantes del mismo sentido, no otro sentido: si
 * al quitarlos queda uno solo, no hay ambigüedad ninguna.
 */
export function trackingDirectionOptions(stopId: string, lineId: string): LineDirection[] {
  const through = state.network?.getDirectionsThroughStop(stopId, lineId) ?? []

  if (through.length <= 1) {
    return through
  }

  const complete = through.filter((direction) => !direction.partial)
  return complete.length > 0 ? complete : through
}

/* ------------------------------------------------------------------ *
 * Por donde viene el autobus                                           *
 * ------------------------------------------------------------------ */

/**
 * En cual de las paradas de la ventana esta el autobus.
 *
 * La fuente oficial NUNCA dice donde esta un autobus: por cada parada solo
 * publica "linea N, M minutos". Lo unico que delata una presencia es que ese
 * contador caiga a cero o uno, o que la fuente diga "LLEGANDO A PARADA". Asi
 * que se mira eso mismo en las paradas anteriores del recorrido —que vienen ya
 * en el orden real del trayecto— y se toma la MAS AVANZADA que lo cumpla.
 *
 * Lo de "la mas avanzada" no es un detalle: las paradas se consultan en serie,
 * una cada dos segundos, de modo que los datos de la ventana NO son del mismo
 * instante. Puede quedar un "llegando" rezagado de hace medio minuto y otro mas
 * adelante recien traido. Como un autobus solo avanza, el indice mayor es
 * siempre la verdad mas nueva.
 *
 * Devuelve el indice dentro de `window`, o -1 si no consta en ninguna.
 *
 * Esta funcion es la que comparten "ver por donde viene" y el aviso de proximo
 * bus. Tenerla una sola vez es lo que impide que las dos pantallas acaben
 * diciendo que el autobus esta en dos sitios distintos.
 */
export function locateBusInWindow(window: NetworkStop[], lineId: string): number {
  return locateBus(
    window.map((stop) => {
      const arrival = feedOf(stop.stopId)
        ?.arrivals.filter((item) => item.lineId === lineId)
        .sort((left, right) => liveMinutes(left) - liveMinutes(right))[0]

      // `liveMinutes` envejece el contador con lo que ha pasado desde que se
      // obtuvo: sin eso, la parada consultada hace catorce segundos seguiria
      // diciendo el numero de hace catorce segundos.
      return arrival ? liveMinutes(arrival) : null
    }),
  )
}

/**
 * A cuantas paradas viene el autobus de un aviso.
 *
 * `null` cuando no se puede afirmar: el aviso no tiene sentido resuelto (por su
 * parada pasa mas de un sentido de la linea), el autobus todavia esta lejos y no
 * se le busca, o simplemente no consta en ninguna de las paradas miradas.
 * Callarse es la respuesta correcta a las tres: un recuento inventado manda a
 * mirar a la calle equivocada.
 */
export function trackingStopsAway(job: TrackingJob): number | null {
  // Con la app cerrada quien mira las paradas anteriores es el servicio nativo,
  // así que al volver a abrirla su recuento es más nuevo que cualquier cosa que
  // se pueda deducir aquí. Se descarta en cuanto envejece: un autobús en marcha
  // deja de estar donde estaba, y repetir "a dos paradas" pasado ese tiempo es
  // afirmar algo que ya no consta.
  const fromService = state.trackingStopsAway[job.id]
  if (fromService && Date.now() - fromService.at <= ROUTE_FIX_MAX_AGE_MS) {
    return fromService.stopsAway
  }

  if (!job.directionKey || !state.network) {
    return null
  }

  const window = state.network.getDirectionWindow(
    job.directionKey,
    job.stopId,
    ROUTE_WINDOW_STOPS + 1,
  )

  if (window.length === 0) {
    return null
  }

  return stopsAwayFrom(window.length, locateBusInWindow(window, job.lineId))
}

export { describeStopsAway } from './services/bus-position'

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

/**
 * Pestañas que se ven ahora mismo.
 *
 * "Mapas" es experimental y solo aparece si se enciende en Ajustes. Apagada no
 * se dibuja, no ocupa sitio en la barra y no puede abrirse: es la garantía de
 * que lo experimental no estorba a quien no lo ha pedido.
 */
function visibleTabs(): TabDefinition[] {
  if (!state.settings.experimentalMaps) {
    return TABS
  }

  return [...TABS, { id: 'mapas', label: 'Mapas', iconName: 'map' }]
}

/** Ajustes no esta en la barra, pero su pantalla tambien necesita titulo. */
const TAB_TITLES: Record<TabId, string> = {
  inicio: 'Inicio',
  buscar: 'Buscar',
  seguimiento: 'Seguir',
  monitor: 'Puntualidad',
  mapas: 'Mapas',
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
      ${visibleTabs().map((tab) => {
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
    case 'mapas':
      // Apagada en Ajustes no hay pantalla que enseñar, ni aunque se llegue
      // aquí por una pestaña guardada de antes.
      return state.settings.experimentalMaps ? renderMapas() : renderInicio()
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
        <div class="hero-stat"><strong>${state.trackings.length}</strong><span>Avisos</span></div>
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
 * Lleva interruptor de pausa. Pausar NO es lo mismo que quitar: el aviso se
 * conserva entero —parada, línea, autobuses ya vistos— y vuelve de un toque,
 * mientras que quitarlo obliga a montarlo otra vez desde la parada. Lo que sí
 * desaparece al pausar es la notificación, y por eso desaparece: una
 * notificación persistente que ya no se actualiza es peor que ninguna, porque
 * se queda enseñando una hora que dejó de ser verdad.
 */
function renderTrackingBanner(tracking: TrackingJob): string {
  const feed = feedOf(tracking.stopId)
  const arrival = feed?.arrivals.find((item) => item.lineId === tracking.lineId) ?? null
  const target = trackingBusTarget()

  // Con un solo autobus por aviso el contador no dice nada: sobra.
  const progress = target > 1
    ? `Autobús ${Math.min(tracking.busesSeen + 1, target)} de ${target} · `
    : ''

  // Dónde viene el autobús, con la misma detección que dibuja el recorrido.
  // Solo mientras el aviso trabaja: en pausa nadie está mirando las paradas
  // anteriores, así que el número que hubiera es de hace rato.
  const stopsAway = tracking.active ? describeStopsAway(trackingStopsAway(tracking)) : ''

  return `
    <section class="card${tracking.active ? '' : ' is-paused'}" data-key="tracking-${esc(tracking.id)}">
      ${renderTrackingHead(tracking, arrival, progress, stopsAway)}
    </section>
  `
}

/**
 * Cabecera de un aviso: parada, sentido, tiempo que falta y los dos botones.
 *
 * La comparten la tarjeta compacta de Inicio y la completa de Seguir. Inicio es
 * un vistazo —cuánto falta— y no dibuja el recorrido; la pestaña Seguir es donde
 * se va a mirar por dónde viene, y ahí sí.
 */
function renderTrackingHead(
  tracking: TrackingJob,
  arrival: Arrival | null,
  progress: string,
  stopsAway: string,
  /**
   * El subtitulo puede ocupar dos lineas.
   *
   * En la tarjeta completa si, porque ahi sobra sitio y el subtitulo lleva tres
   * cosas —el contador de autobuses, el sentido y por donde viene— que juntas no
   * caben en una linea: se quedaba en "Autobus 1 de 3 · Haci…", que es
   * justamente perder el unico dato que dice hacia donde va. En el vistazo de
   * Inicio no, porque alli lo que manda es que cada aviso ocupe poco.
   */
  wrap = false,
): string {
  return `
    <div class="card-head">
      ${lineChip(tracking.lineId, lineColor(tracking.lineId), 'lg')}
      <div class="card-head-copy">
        <h2 class="card-title">${esc(tracking.stopName)}</h2>
        <p class="card-sub${wrap || stopsAway ? ' is-wrap' : ''}">${esc(
          progress + describeArrival(tracking.stopId, tracking.lineId),
        )}${
          stopsAway ? `<span class="stops-away">${icon('bus')}${esc(stopsAway)}</span>` : ''
        }</p>
      </div>
      <div class="card-actions">
        <div class="arrival-eta">${
          !tracking.active
            ? '<span class="eta-unit">en pausa</span>'
            : arrival
              ? renderEta(arrival)
              : '<span class="eta-unit">buscando…</span>'
        }</div>
        ${renderJobToggle(tracking.id, tracking.active)}
        <button class="mini-btn is-danger" type="button" data-action="stop-tracking" data-tracking="${esc(
          tracking.id,
        )}" aria-label="Quitar el aviso">${icon('bellOff')}</button>
      </div>
    </div>
  `
}

/**
 * Un aviso entero, tal y como se ve en la pestaña Seguir.
 *
 * Es la fusión de lo que antes eran dos funciones: el aviso decía cuánto falta y
 * "ver por dónde viene" dibujaba el recorrido. Eran la misma pregunta partida en
 * dos, y encima competían por el único turno disponible en la cola de consultas.
 */
function renderTrackingCard(tracking: TrackingJob): string {
  const feed = feedOf(tracking.stopId)
  const arrival = feed?.arrivals.find((item) => item.lineId === tracking.lineId) ?? null
  const target = trackingBusTarget()
  const progress = target > 1
    ? `Autobús ${Math.min(tracking.busesSeen + 1, target)} de ${target} · `
    : ''
  const stopsAway = tracking.active ? describeStopsAway(trackingStopsAway(tracking)) : ''

  return `
    <section class="card${tracking.active ? '' : ' is-paused'}" data-key="tracking-${esc(tracking.id)}">
      ${renderTrackingHead(tracking, arrival, progress, stopsAway, true)}
      <div class="card-body">
        ${
          // En pausa NO se dibuja el recorrido. Un aviso en reposo no consulta,
          // así que la fila de cada parada solo podría enseñar un guion: ocho
          // renglones vacíos que ocupan media pantalla y no dicen nada. Se
          // sustituyen por la única frase que sí informa, que es por qué está
          // vacío y cómo se llena.
          tracking.active
            ? renderTrackingRoute(tracking)
            : '<p class="text-tiny">En pausa: no consulta ni avisa. Reanúdalo para ver por dónde viene; solo un aviso se mantiene actualizado a la vez.</p>'
        }
      </div>
    </section>
  `
}

/**
 * Las paradas anteriores, con el autobús situado en una de ellas.
 *
 * Solo se puede dibujar sabiendo el sentido, porque las paradas anteriores solo
 * existen dentro de un recorrido concreto. Un aviso creado antes de la fusión en
 * una parada por la que la línea pasa en los dos sentidos puede no tenerlo:
 * entonces se dice, en vez de dejar un hueco que parece un fallo.
 */
function renderTrackingRoute(tracking: TrackingJob): string {
  const network = state.network
  if (!network) {
    return ''
  }

  if (!tracking.directionKey) {
    return notice(
      'info',
      'Por esta parada pasa la línea en los dos sentidos y este aviso no fijó ninguno, así que no se puede saber por dónde viene. Vuelve a crearlo para elegir el sentido.',
    )
  }

  const windowStops = network.getDirectionWindow(
    tracking.directionKey,
    tracking.stopId,
    ROUTE_WINDOW_STOPS,
  )

  if (windowStops.length === 0) {
    return notice('warn', 'No se pudo reconstruir el recorrido de esta línea.')
  }

  // Misma regla que usa la notificación para contar paradas: una sola
  // implementación, o la tarjeta y el aviso situarían el autobús en sitios
  // distintos con los mismos datos delante.
  const busIndex = locateBusInWindow(windowStops, tracking.lineId)

  return `
    <div class="timeline">
      ${windowStops
        .map((stop, index) => {
          const feed = feedOf(stop.stopId)
          const arrival = feed?.arrivals
            .filter((item) => item.lineId === tracking.lineId)
            .sort((left, right) => liveMinutes(left) - liveMinutes(right))[0]

          const isTarget = stop.stopId === tracking.stopId
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
        .join('')}
    </div>
    ${renderSyncLegend()}
  `
}

/**
 * Interruptor de un aviso.
 *
 * Un aviso en reposo no se borra: sigue creado y con su parada, su línea, su
 * sentido y los autobuses ya contados, pero no consulta ni publica
 * notificación. Es lo que permite tener montados el de la ida y el de la vuelta
 * y alternar de un toque sin volver a configurarlos.
 *
 * Solo uno se mantiene actualizado a la vez: reanudar uno pausa automáticamente
 * el otro. No hay nada que elegir ni ningún error que leer, y el botón lo avisa
 * antes de pulsarlo.
 */
function renderJobToggle(id: string, active: boolean): string {
  const swaps = !active && activeJobCount() >= MAX_ACTIVE_JOBS

  return `
    <button
      class="mini-btn${active ? ' is-on' : ''}"
      type="button"
      data-action="toggle-job"
      data-job="${esc(id)}"
      aria-label="${active ? 'Pausar' : 'Reanudar'}"
      title="${swaps ? 'Se pausará el otro aviso: solo uno se mantiene actualizado a la vez' : ''}"
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

    ${renderMapShell(direction ? directionLabel(direction) : 'Todas las paradas de la red')}
    <p class="text-tiny">
      ${
        !ready
          ? 'El mapa enseña las paradas de toda la red: toca cualquiera para ver sus tiempos. Si eliges línea y sentido, se queda solo con ese recorrido y se abre a pantalla completa.'
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
          : `<button class="map-expand" type="button" data-action="expand-map">${icon(
              'map',
            )} Ampliar</button>`
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
 * Plegada tiene que enseñar TODAS las líneas que pasan por ella —son lo que
 * identifica la parada de un vistazo— y todas las tarjetas plegadas tienen que
 * medir lo mismo, o la lista se lee como si estuviera rota. Las dos cosas a la
 * vez no caben en el hueco que dejaba la cabecera: entre el código, el nombre y
 * los tres botones quedaban unos 90 px, y trece distintivos ahí solo podían
 * salir cortados o con barra de desplazamiento.
 *
 * Por eso los distintivos bajan a una FRANJA PROPIA de ancho completo, con
 * hueco fijo para dos filas: entran con sitio de sobra los trece de la parada
 * más concurrida de la red, y una parada de una sola línea ocupa exactamente lo
 * mismo que una de trece.
 *
 * El botón de actualizar solo aparece desplegada: plegada no se enseña ni un
 * tiempo, así que refrescar era pedirle a la fuente —que limita por IP— un dato
 * que nadie iba a ver.
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
    <section class="card stop-card">
      <div class="card-head${expanded ? '' : ' is-tight'}">
        <button class="card-head-main" type="button" data-action="expand-stop" data-stop="${esc(
          stopId,
        )}" aria-expanded="${expanded}">
          <span class="stop-code">${esc(stopId)}</span>
          <span class="card-head-copy">
            <span class="card-title">${esc(label)}</span>
            ${official ? `<span class="card-sub is-wrap">${esc(official)}</span>` : ''}
          </span>
          ${icon(expanded ? 'chevronDown' : 'chevron')}
        </button>
        <span class="card-actions">
          ${
            expanded
              ? `<button class="mini-btn${syncing ? ' is-spinning' : ''}" type="button" data-action="refresh-stop" data-stop="${esc(
                  stopId,
                )}" aria-label="Actualizar esta parada">${icon('refresh')}</button>`
              : ''
          }
          <button class="mini-btn" type="button" data-action="rename-stop" data-stop="${esc(
            stopId,
          )}" aria-label="Cambiar nombre">${icon('pencil')}</button>
          <button class="mini-btn is-danger" type="button" data-action="remove-favourite" data-stop="${esc(
            stopId,
          )}" aria-label="Quitar parada">${icon('trash')}</button>
        </span>
      </div>

      ${expanded ? '' : renderStopLines(stopId, lines)}

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

/**
 * Franja de líneas de una parada plegada.
 *
 * Es un botón, y no un simple bloque, porque ocupa el ancho entero justo debajo
 * del nombre: tocar ahí y que no pase nada se lee como un fallo. Despliega la
 * parada igual que la cabecera, y se queda fuera del recorrido del tabulador
 * (`tabindex="-1"`) para no obligar a pasar dos veces por el mismo destino.
 *
 * El hueco es FIJO —dos filas— aunque sobre sitio. Es lo que hace que todas las
 * tarjetas plegadas midan lo mismo, que era el problema: con la altura pegada al
 * contenido, la lista de paradas guardadas subía y bajaba de escalón en escalón
 * según cuántas líneas tuviera cada una.
 */
function renderStopLines(stopId: string, lines: TransitLine[]): string {
  return `
    <button class="stop-lines" type="button" data-action="expand-stop" data-stop="${esc(
      stopId,
    )}" aria-label="Desplegar la parada" tabindex="-1">
      ${
        lines.length === 0
          ? '<span class="stop-lines-empty">Sin líneas registradas</span>'
          : lines.map((line) => lineChip(line.lineId, line.color, 'sm')).join('')
      }
    </button>
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
  // Mientras hay una franja de puntualidad abierta esta pestaña está apagada.
  // No es una restricción de adorno: medir a qué hora pasa de verdad un autobús
  // obliga a no perderse una sola consulta de ESA parada, y dibujar el recorrido
  // pide ocho paradas por ciclo contra una fuente que admite una cada dos
  // segundos. El aviso NO se pausa —es una notificación que alguien espera— pero
  // sí deja de rastrear el recorrido mientras dura la franja.
  const measuring = state.monitors.filter((monitor) => isWithinWindow(monitor))

  if (state.trackings.length === 0) {
    return `
      <section class="card"><div class="card-body">
        ${emptyState(
          'bell',
          'Sin avisos',
          'Abre una parada guardada y elige “Avisos y seguimiento”: verás los minutos que faltan y por dónde viene el autobús.',
          '<button class="btn btn-primary" type="button" data-action="tab" data-tab="inicio">Ir a mis paradas</button>',
        )}
      </div></section>
    `
  }

  return `
    ${
      measuring.length > 0
        ? notice(
            'warn',
            `Hay ${measuring.length === 1 ? 'un control' : `${measuring.length} controles`} de puntualidad midiendo hasta las ${formatMinutesClock(
              Math.max(...measuring.map((monitor) => monitor.endMinutes)),
            )}. El aviso sigue dando la hora, pero hasta entonces no rastrea por dónde viene: esas consultas van a la parada que se está midiendo.`,
          )
        : ''
    }

    ${renderJobGroup(
      'Avisos de próximo bus',
      `${state.trackings.length} de ${MAX_TRACKING_JOBS}`,
      'bell',
      state.trackings.map((job) => renderTrackingCard(job)).join(''),
      '',
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

        ${renderMonitorTrace(monitor)}

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
      ? 'Todavía sin pasos registrados. La app está consultando esta parada cada 30 s; abre el registro para ver qué está encontrando.'
      : `Todavía sin pasos registrados. La medición ocurre entre las ${formatMinutesClock(
          monitor.startMinutes,
        )} y las ${formatMinutesClock(
          monitor.endMinutes,
        )}; fuera de esa franja no se consulta nada.`
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
 * Registro de un control: qué ha visto y qué ha decidido con ello.
 *
 * Es la respuesta a la única pregunta que se hace mirando una tabla vacía: por
 * qué no se está apuntando ninguna hora. La fuente oficial no publica "el
 * autobús ha pasado" —solo cuántos minutos faltan—, así que el paso se deduce, y
 * una deducción que no llega a producirse no deja rastro por sí sola. Los
 * motivos reales son varios y ninguno se ve desde fuera: la línea no figura en
 * el panel de esa parada, la fuente está limitando por IP, el móvil se durmió
 * entre consulta y consulta, o el paso sí se detectó pero el horario oficial no
 * tenía ninguna salida cerca a la que atribuirlo.
 *
 * Va cerrado de fábrica: quien mira la pantalla quiere ver la tabla, no el
 * registro. Se abre cuando la tabla no cuenta lo que se esperaba.
 */
function renderMonitorTrace(monitor: MonitorJob): string {
  const trace = state.monitorTrace[monitor.id] ?? []
  const open = state.monitorTraceOpen[monitor.id] === true

  if (trace.length === 0 && !open) {
    return ''
  }

  const warnings = trace.filter((entry) => entry.level !== 'info').length

  return `
    <div class="stack-sm">
      <button class="btn btn-secondary btn-block btn-sm" type="button"
        data-action="toggle-monitor-trace" data-monitor="${esc(monitor.id)}">
        ${icon(open ? 'up' : 'down')} Registro de la medición (${trace.length}${
          warnings > 0 ? ` · ${warnings} con aviso` : ''
        })
      </button>
      ${
        open
          ? `<div class="trace-list">${[...trace]
              .reverse()
              .map((entry) => renderMonitorTraceRow(entry))
              .join('')}</div>
             <button class="btn btn-secondary btn-block btn-sm" type="button"
               data-action="clear-monitor-trace" data-monitor="${esc(monitor.id)}">
               ${icon('trash')} Vaciar el registro
             </button>`
          : ''
      }
    </div>
  `
}

function renderMonitorTraceRow(entry: MonitorTrace): string {
  return `
    <div class="trace-item is-${entry.level}" data-key="trace-${entry.at}">
      <span class="trace-time">${esc(formatClock(new Date(entry.at)))}</span>
      <span class="trace-copy">
        <span class="trace-note">${esc(entry.note)}</span>
        <span class="trace-meta">${esc(
          entry.minutes === null ? 'sin dato de esa línea' : `${entry.minutes} min`,
        )}${entry.armed ? ' · autobús entrando' : ''}</span>
      </span>
    </div>
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
    iconName: 'bell',
    title: 'Seguir',
    body: 'El aviso de próximo bus: te dice los minutos que faltan, por cuántas paradas viene y te llega aunque cierres la app.',
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
 * 6 · MAPAS (experimental)                                            *
 * ================================================================== */

/**
 * Pestaña experimental: paradas cercanas y rutas.
 *
 * Vive aparte del resto a propósito. No consulta la fuente oficial de llegadas
 * (esa fuente limita por IP y su cola es para el aviso de próximo bus), no
 * guarda nada en disco y no toca el estado de ninguna otra pantalla. Lo único
 * que comparte es la red de líneas ya cargada y la ficha de parada.
 */
function renderMapas(): string {
  const maps = state.maps

  return `
    <div class="lab-banner">
        ${icon('info')}
        <div>
          <strong>Función experimental</strong>
          <span>Los tiempos de ruta son estimaciones a partir del recorrido oficial, no horarios en firme.</span>
        </div>
      </div>

      <div class="segmented" role="tablist" aria-label="Modo del mapa">
        ${[
          { id: 'cercanas', label: 'Paradas cercanas', iconName: 'pin' },
          { id: 'rutas', label: 'Rutas', iconName: 'route' },
        ]
          .map(
            (item) => `
              <button
                class="segmented-item"
                type="button"
                role="tab"
                aria-selected="${maps.mode === item.id}"
                data-action="maps-mode"
                data-mode="${item.id}"
              >${icon(item.iconName)}<span>${esc(item.label)}</span></button>
            `,
          )
          .join('')}
      </div>

      <!-- El contenedor es SIEMPRE el mismo nodo, encajado o a pantalla
           completa: solo cambia cómo se coloca. Moverlo de sitio en el árbol
           obligaría a reconstruir Leaflet en cada apertura. -->
      <div class="map-shell maps-shell${maps.expanded ? ' is-expanded' : ''}">
        <!-- data-morph="skip": dentro manda Leaflet. Sin esto, el repintado
             incremental le borraba los hijos en cada latido del reloj y el mapa
             se quedaba en un rectangulo vacio. -->
        <div id="maps-map" data-morph="skip"></div>
        ${
          maps.mode === 'cercanas'
            ? `<button class="map-locate${maps.locating ? ' is-busy' : ''}" type="button"
                 data-action="maps-locate" aria-label="Centrar en mi ubicación">
                 ${icon('crosshair')}
               </button>`
            : ''
        }
        ${
          maps.expanded
            ? `<button class="map-close" type="button" data-action="maps-collapse" aria-label="Cerrar el mapa">
                 ${icon('close')}
               </button>`
            : `<button class="map-expand" type="button" data-action="maps-expand">
                 ${icon('map')} Ampliar
               </button>`
        }
      </div>

    ${maps.mode === 'cercanas' ? renderNearbyPanel() : renderRoutePanel()}
  `
}

/* ------------------------------ Cercanas ------------------------------ */

function renderNearbyPanel(): string {
  const maps = state.maps

  if (maps.locating && !maps.location) {
    return `
      <section class="card"><div class="card-body">
        <div class="skeleton skeleton-row"></div>
        <div class="skeleton skeleton-row"></div>
        <p class="text-tiny">Buscando tu ubicación…</p>
      </div></section>
    `
  }

  if (!maps.location) {
    // El interruptor de ubicación del teléfono y el permiso de SALBUS son dos
    // cosas distintas que desde aquí se ven igual —no llega la posición— y se
    // arreglan en pantallas distintas del sistema. Decir "activa la ubicación"
    // sin llevar hasta donde se activa deja el problema donde estaba.
    const blocked = maps.locationBlocked

    return `
      <section class="card"><div class="card-body">
        ${
          maps.locationError
            ? notice('error', maps.locationError)
            : `<p class="card-sub is-wrap">Para enseñarte las paradas que tienes al lado, la aplicación
                 necesita saber dónde estás. La ubicación no sale del teléfono ni se guarda.</p>`
        }
        ${
          blocked
            ? `<button class="btn btn-primary btn-block" type="button" data-action="open-location-settings">
                 ${icon('pin')} ${
                   blocked === 'service'
                     ? 'Activar la ubicación del teléfono'
                     : 'Abrir los permisos de SALBUS'
                 }
               </button>
               <button class="btn btn-secondary btn-block" type="button" data-action="maps-locate">
                 ${icon('crosshair')} Volver a intentarlo
               </button>`
            : `<button class="btn btn-primary btn-block" type="button" data-action="maps-locate">
                 ${icon('crosshair')} Usar mi ubicación
               </button>`
        }
      </div></section>
    `
  }

  const nearby = nearestStopsForView()

  if (nearby.length === 0) {
    return `
      <section class="card"><div class="card-body">
        ${emptyState(
          'pin',
          'Ninguna parada cerca',
          'No hay paradas de la red a menos de 900 m de donde estás.',
        )}
      </div></section>
    `
  }

  return `
    <section class="card">
      <div class="card-head"><div class="card-head-copy">
        <h2 class="card-title">Paradas más cercanas</h2>
        <p class="card-sub">${esc(locationAgeLabel())}</p>
      </div></div>
      <div class="card-body">
        <div class="nearby-list">
          ${nearby
            .map((entry, index) => {
              const lines = state.network?.getLinesForStop(entry.stop.stopId) ?? []
              return `
                <button class="nearby-item" type="button" data-action="maps-open-stop" data-stop="${esc(
                  entry.stop.stopId,
                )}">
                  <span class="nearby-rank">${index + 1}</span>
                  <span class="nearby-copy">
                    <span class="nearby-name">${esc(entry.stop.stopName)}</span>
                    <span class="nearby-meta">${esc(formatMeters(entry.meters))} · ${esc(
                      formatWalk(entry.minutes),
                    )} andando</span>
                    <span class="chip-row">
                      ${lines
                        .slice(0, 8)
                        .map((line) => lineChip(line.lineId, line.color, 'sm'))
                        .join('')}
                    </span>
                  </span>
                  ${icon('chevron')}
                </button>
              `
            })
            .join('')}
        </div>
      </div>
    </section>
  `
}

/* -------------------------------- Rutas ------------------------------- */

function renderRoutePanel(): string {
  const maps = state.maps

  if (maps.picking) {
    return renderRoutePicker(maps.picking)
  }

  return `
    <section class="card">
      <div class="card-body">
        <div class="route-form">
          ${renderRouteField('origin', 'Desde', maps.origin)}
          <button class="mini-btn route-swap" type="button" data-action="maps-swap"
            aria-label="Intercambiar origen y destino">${icon('swap')}</button>
          ${renderRouteField('destination', 'Hasta', maps.destination)}
        </div>

        <button
          class="btn btn-primary btn-block"
          type="button"
          data-action="maps-plan"
          ${!maps.origin || !maps.destination || maps.planning ? 'disabled' : ''}
        >${icon('route')} ${maps.planning ? 'Calculando…' : 'Calcular ruta'}</button>
      </div>
    </section>

    ${renderPlanResult()}
  `
}

function renderRouteField(field: 'origin' | 'destination', label: string, point: RoutePoint | null): string {
  return `
    <button class="route-field" type="button" data-action="maps-pick" data-field="${field}">
      <span class="route-field-dot${field === 'destination' ? ' is-end' : ''}"></span>
      <span class="route-field-copy">
        <span class="route-field-label">${esc(label)}</span>
        <span class="route-field-value${point ? '' : ' is-empty'}">${esc(
          point ? point.label : 'Elegir en la lista de paradas',
        )}</span>
      </span>
      ${icon('chevron')}
    </button>
  `
}

/**
 * Buscador de un extremo de la ruta.
 *
 * Se abre DENTRO de la pestaña y no en la hoja inferior compartida: así esta
 * función experimental no toca la maquinaria que usan el resto de pantallas.
 */
function renderRoutePicker(field: 'origin' | 'destination'): string {
  const results = state.network?.findStops(state.maps.query, 25) ?? []

  return `
    <section class="card">
      <div class="card-head">
        <div class="card-head-copy">
          <h2 class="card-title">${field === 'origin' ? 'Punto de salida' : 'Punto de llegada'}</h2>
          <p class="card-sub">Tu ubicación o una parada de la red</p>
        </div>
        <button class="mini-btn" type="button" data-action="maps-pick-cancel" aria-label="Cerrar">
          ${icon('close')}
        </button>
      </div>
      <div class="card-body">
        <button class="btn btn-secondary btn-block" type="button" data-action="maps-pick-here">
          ${icon('crosshair')} Mi ubicación
        </button>

        <input
          class="input"
          id="maps-query"
          type="search"
          placeholder="Buscar una parada por su nombre"
          value="${esc(state.maps.query)}"
          autocomplete="off"
        />

        <div class="result-list">
          ${
            results.length === 0
              ? emptyState('search', 'Sin resultados', 'Ninguna parada coincide con lo que has escrito.')
              : results
                  .map(
                    (stop) => `
                      <button class="result-item" type="button" data-action="maps-pick-stop" data-stop="${esc(
                        stop.stopId,
                      )}">
                        <span class="stop-code">${esc(stop.stopId)}</span>
                        <span class="result-copy">
                          <span class="result-name is-wrap">${esc(stop.stopName)}</span>
                        </span>
                        ${icon('chevron')}
                      </button>
                    `,
                  )
                  .join('')
          }
        </div>
      </div>
    </section>
  `
}

function renderPlanResult(): string {
  const plan = state.maps.plan

  if (!plan) {
    return ''
  }

  if (plan.status === 'unreachable') {
    return `<section class="card"><div class="card-body">${notice('warn', plan.reason)}</div></section>`
  }

  if (plan.status === 'walk') {
    return `
      <section class="card">
        <div class="card-head"><div class="card-head-copy">
          <h2 class="card-title">Se llega antes andando</h2>
          <p class="card-sub">${esc(formatWalk(plan.walking.totalMinutes))} · ${esc(
            formatMeters(walkingMeters(plan.walking)),
          )}</p>
        </div></div>
        <div class="card-body">
          <p class="text-tiny">Ningún autobús te deja antes que tus pies para esa distancia.</p>
        </div>
      </section>
    `
  }

  return `
    <div id="ruta-resultado" class="stack-sm">
      ${renderItinerary(plan.best, true)}
      ${plan.alternatives.map((itinerary) => renderItinerary(itinerary, false)).join('')}
    </div>
  `
}

function renderItinerary(itinerary: Itinerary, best: boolean): string {
  const lines = itinerary.legs.filter((leg): leg is BusLeg => leg.kind === 'bus')

  return `
    <section class="card itinerary${best ? ' is-best' : ''}">
      <div class="card-head">
        <div class="card-head-copy">
          <h2 class="card-title">${esc(formatWalk(itinerary.totalMinutes))}${
            best ? ' · la más rápida' : ''
          }</h2>
          <p class="card-sub is-wrap">${esc(
            `${itinerary.transfers === 0 ? 'Sin transbordos' : itinerary.transfers === 1 ? 'Un transbordo' : `${itinerary.transfers} transbordos`} · ${formatWalk(
              itinerary.walkMinutes,
            )} a pie · espera ${formatWalk(itinerary.waitMinutes)}`,
          )}</p>
        </div>
        <span class="itinerary-lines">
          ${lines.map((leg) => lineChip(leg.lineId, lineColor(leg.lineId), 'sm')).join('')}
        </span>
      </div>
      <div class="card-body">
        <ol class="itinerary-legs">
          ${itinerary.legs.map((leg, index) => renderLeg(leg, index)).join('')}
        </ol>
      </div>
    </section>
  `
}

function renderLeg(leg: RouteLeg, index: number): string {
  if (leg.kind === 'walk') {
    // Un transbordo de treinta metros no es "andar", es cruzar; decirlo así
    // evita que parezca una caminata y, sobre todo, deja claro que la parada
    // de subida NO es la misma en la que te has bajado.
    const verb = leg.meters < 80 ? 'Cruzar a' : 'Andar hasta'

    return `
      <li class="leg is-walk">
        <span class="leg-mark">${icon('walk')}</span>
        <div class="leg-copy">
          <strong>${esc(verb)} ${esc(leg.toName)}</strong>
          <span>${esc(formatMeters(leg.meters))} · ${esc(formatWalk(leg.minutes))}${
            // Sin callejero el paseo se mide en linea recta y se queda corto
            // siempre. Decirlo es la diferencia entre un dato y una promesa.
            leg.onStreets ? '' : ' · en línea recta'
          }</span>
        </div>
      </li>
    `
  }

  const color = lineColor(leg.lineId)

  return `
    <li class="leg is-bus">
      <span class="leg-mark" style="--leg:${esc(color)}">${lineChip(leg.lineId, color, 'sm')}</span>
      <div class="leg-copy">
        <strong>Hacia ${esc(leg.headsign)}</strong>
        <span>Sube en ${esc(leg.from.stopName)}</span>
        <span>Baja en ${esc(leg.to.stopName)}</span>
        <span class="leg-meta">${leg.stops.length - 1} paradas · ${esc(
          formatWalk(leg.minutes),
        )} · espera ~${esc(formatWalk(leg.waitMinutes))}</span>
      </div>
      <button class="mini-btn" type="button" data-action="maps-focus-leg" data-leg="${index}"
        aria-label="Ver este tramo en el mapa">${icon('eye')}</button>
    </li>
  `
}

/* ---------------------------- Ayudas de la pestaña -------------------- */

export function nearestStopsForView(): NearbyStop[] {
  const location = state.maps.location
  if (!location || !state.network) {
    return []
  }

  return nearestStops(location.point, state.network.stops, 6)
}

function locationAgeLabel(): string {
  const location = state.maps.location
  if (!location) {
    return ''
  }

  const accuracy = Number.isFinite(location.accuracy) ? Math.round(location.accuracy) : null
  return accuracy ? `Precisión aproximada de ${accuracy} m` : 'Ubicación aproximada'
}

function walkingMeters(itinerary: Itinerary): number {
  return itinerary.legs.reduce((total, leg) => (leg.kind === 'walk' ? total + leg.meters : total), 0)
}

export function formatMeters(meters: number): string {
  if (meters < 1000) {
    return `${Math.round(meters / 10) * 10} m`
  }
  return `${(meters / 1000).toFixed(1).replace('.', ',')} km`
}

/** Minutos redondeados hacia arriba: prometer menos de lo que se tarda molesta. */
export function formatWalk(minutes: number): string {
  const total = Math.max(1, Math.ceil(minutes))
  if (total < 60) {
    return `${total} min`
  }
  return `${Math.floor(total / 60)} h ${total % 60} min`
}

/* ================================================================== *
 * 7 · AJUSTES                                                         *
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

    ${renderRefreshRulesCard()}

    ${renderExperimentalCard()}

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
 * Cada cuánto se actualiza cada cosa, y con qué condición.
 *
 * Ninguna de estas frecuencias es un capricho: todas salen de repartir una sola
 * cola de consultas —una petición cada 2 s, que es el máximo que la fuente
 * oficial sostiene sin bloquear por IP— entre funciones que la necesitan a la
 * vez. Por eso la columna que de verdad importa no es "cada cuánto", sino
 * "cuándo": casi todo lo que aquí aparece está apagado la mayor parte del
 * tiempo, y ese es el motivo de que lo que queda encendido llegue a tiempo.
 */
function renderRefreshRulesCard(): string {
  const seconds = (ms: number) => `${Math.round(ms / 1000)} s`

  const rows: Array<[string, string, string]> = [
    [
      'Paradas guardadas',
      'una vez al abrir la app',
      'Una pasada por todas, en serie, para que la primera que despliegues ya tenga sus tiempos.',
    ],
    [
      'Parada desplegada',
      seconds(FRESHNESS.focused),
      'Solo la que esté abierta, y solo mientras lo esté. Plegada no enseña tiempos: pedirlos sería gastar cola para nada.',
    ],
    [
      'Ficha de una parada',
      seconds(FRESHNESS.focused),
      'La del buscador y la del mapa. Tocar una parada en el mapa ya lanza la consulta, antes de pulsar “Ver tiempos”.',
    ],
    [
      'Aviso de próximo bus',
      seconds(FRESHNESS.focused),
      `Solo si está activo. Con la app cerrada lo lleva el servicio en segundo plano, que consulta cada ${TRACKING_INTERVAL_SECONDS} s.`,
    ],
    [
      'Por dónde viene · mirándolo',
      seconds(FRESHNESS.routeVisible),
      `El recorrido entero (${ROUTE_WINDOW_STOPS} paradas) mientras la pestaña Seguir está delante. Son ${ROUTE_WINDOW_STOPS * 2} s de cola por vuelta: solo se sostiene con la pantalla puesta.`,
    ],
    [
      'Por dónde viene · de fondo',
      seconds(FRESHNESS.routeBackground),
      `Fuera de la pestaña solo se busca el "a N paradas" del aviso: con el autobús a menos de ${ROUTE_SCAN_MAX_MINUTES} min, hasta donde puede estar, y parando en la primera parada que lo tenga encima.`,
    ],
    [
      'Puntualidad',
      seconds(FRESHNESS.monitor),
      `Solo dentro de la franja del control. Con un autobús ya entrando se aprieta a ${seconds(
        FRESHNESS.focused,
      )}; fuera de la franja no se consulta nada.`,
    ],
  ]

  return `
    <section class="card">
      <div class="card-head"><div class="card-head-copy">
        <h3 class="card-title">Frecuencias de actualización</h3>
        <p class="card-sub">Cada cuánto se pide cada cosa, y con qué condición</p>
      </div></div>
      <div class="card-body">
        <div class="rule-list">
          ${rows
            .map(
              ([title, rate, condition]) => `
                <div class="rule-item">
                  <div class="rule-head">
                    <strong>${esc(title)}</strong>
                    <span class="pill">${esc(rate)}</span>
                  </div>
                  <span class="rule-when">${esc(condition)}</span>
                </div>
              `,
            )
            .join('')}
        </div>

        <dl class="kv">
          <dt>Entre peticiones</dt><dd>${(MIN_REQUEST_SPACING_MS / 1000).toFixed(0)} s, siempre en serie</dd>
          <dt>Revisión del plan</dt><dd>cada segundo</dd>
          <dt>Lote automático</dt><dd>como mucho uno cada ${Math.round(AUTO_CYCLE_MS / 1000)} s</dd>
          <dt>“Al día” en pantalla</dt><dd>dato de hace menos de 40 s</dd>
          <dt>App en segundo plano</dt><dd>solo siguen el aviso activo y la puntualidad en franja</dd>
        </dl>

        <p class="text-tiny">
          Una parada solo se vuelve a pedir cuando su dato pasa del tiempo indicado, así que esos
          segundos son un máximo, no un reloj: si la cola está ocupada por algo más urgente, se
          espera. Lo que nunca ocurre es que dos consultas salgan a la vez.
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
          <dt>Avisos creados</dt><dd>máximo ${MAX_TRACKING_JOBS}</dd>
          <dt>Actualizándose a la vez</dt><dd>${MAX_ACTIVE_JOBS}</dd>
          <dt>Al reanudar uno</dt><dd>se pausa automáticamente el otro</dd>
          <dt>Al crear uno de más</dt><dd>se pide cuál se sustituye</dd>
          <dt>Fuera de la pestaña Seguir</dt><dd>sigue avisando, sin dibujar el recorrido</dd>
          <dt>Midiendo puntualidad</dt><dd>sigue avisando, sin rastrear por dónde viene</dd>
        </dl>

        <p class="text-tiny">
          Un aviso hace las dos cosas que antes estaban separadas: la notificación con los minutos
          que faltan y el recorrido parada a parada con el autobús situado en una de ellas. Para lo
          segundo hace falta saber por qué sentido viene, y la fuente oficial nunca lo dice: cuando
          por tu parada pasa la línea en los dos sentidos, se pregunta al crear el aviso. Por el
          resto de paradas pasa uno solo y no hay nada que elegir.
        </p>

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

/**
 * Funciones en pruebas.
 *
 * Van en su propia tarjeta y no mezcladas con los ajustes de siempre: encender
 * algo experimental tiene que ser una decisión consciente, y apagarlo tiene que
 * ser fácil de encontrar cuando estorbe.
 */
function renderExperimentalCard(): string {
  return `
    <section class="card">
      <div class="card-head"><div class="card-head-copy">
        <h3 class="card-title">Experimental</h3>
        <p class="card-sub">En pruebas: puede cambiar o desaparecer</p>
      </div></div>
      <div class="card-body">
        ${renderSettingRow(
          'map',
          'Pestaña Mapas',
          'Paradas cercanas a tu ubicación y cálculo de rutas en autobús. Apagada no consume nada.',
          state.settings.experimentalMaps,
          'toggle-maps',
        )}
        <p class="text-tiny">
          Las rutas se calculan con el recorrido oficial de las líneas, así que los minutos son
          estimaciones y no horarios en firme. No consulta los tiempos de llegada en tiempo real:
          esa cola es para los avisos de próximo bus.
        </p>
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
          ? renderReplaceJobSheet(sheet.stopId)
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
          <span>Notificación fija con los minutos que faltan y por dónde viene · ${state.trackings.length} de ${MAX_TRACKING_JOBS} creados.</span>
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
 * Se ha alcanzado el tope de avisos creados.
 *
 * En vez de rechazar la acción con un error, se enseña lo que ya hay y se pide
 * cuál se sustituye: quien lo pide ya ha decidido que quiere este aviso nuevo, y
 * lo único que falta por saber es a costa de cuál.
 */
function renderReplaceJobSheet(stopId: string): string {
  return `
    <div class="sheet-head">
      <h3>Avisarme del próximo bus</h3>
      <p>Ya tienes ${MAX_TRACKING_JOBS} de ${MAX_TRACKING_JOBS}. Elige cuál se sustituye por el de ${esc(
        stopName(stopId),
      )}.</p>
    </div>

    <div class="sheet-options">
      ${state.trackings
        .map(
          (job) => `
        <button class="sheet-option" type="button" data-action="replace-job" data-stop="${esc(
          stopId,
        )}" data-job="${esc(job.id)}">
          ${lineChip(job.lineId, lineColor(job.lineId))}
          <span class="sheet-option-copy">
            <strong>${esc(job.stopName)}</strong>
            <span>${esc(describeArrival(job.stopId, job.lineId))} · ${job.active ? 'activo' : 'en pausa'}</span>
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

function renderPickLineSheet(stopId: string, purpose: 'tracking' | 'monitor'): string {
  const network = state.network
  const lines = network?.getLinesForStop(stopId) ?? []
  const selectedLineId = state.draft.lineId || lines[0]?.lineId || ''
  const directions = selectedLineId ? network?.getDirectionsThroughStop(stopId, selectedLineId) ?? [] : []

  const title = purpose === 'tracking' ? 'Avisarme del próximo bus' : 'Medir puntualidad'

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
      // El sentido se pregunta cuando de verdad hay algo que elegir. En un
      // aviso no sirve para filtrar —la fuente no distingue sentidos, así que
      // sonará con cualquier autobús de la línea— sino para saber por dónde
      // viene y poder contar las paradas que faltan. Por el 93 % de las paradas
      // pasa un solo sentido de cada línea: ahí preguntar sería una pregunta
      // sin respuestas.
      purpose === 'tracking' && trackingDirectionOptions(stopId, selectedLineId).length < 2
        ? ''
        : `
      <label class="field">
        <span>Sentido</span>
        <select class="select" data-action="draft-direction">
          ${(purpose === 'tracking' ? trackingDirectionOptions(stopId, selectedLineId) : directions)
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
          : purpose === 'tracking'
            ? '<span class="text-tiny">Por esta parada pasa la línea en los dos sentidos. Sirve para decirte a cuántas paradas viene el autobús: el aviso sonará igual con cualquiera de los dos, porque la fuente oficial no los distingue.</span>'
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

