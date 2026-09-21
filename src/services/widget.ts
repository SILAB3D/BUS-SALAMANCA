import { Capacitor, registerPlugin } from '@capacitor/core'

/**
 * Widget de paradas favoritas de la pantalla de inicio.
 *
 * El widget lo dibuja Android, fuera de la WebView, y por tanto no puede leer ni
 * las favoritas (que viven en el localStorage) ni la red oficial de lineas. Este
 * modulo es lo que cubre esa distancia, en los dos sentidos:
 *
 *   - `syncWidgetStops` le baja los nombres de las paradas guardadas cada vez
 *     que esa lista cambia. El widget no tiene refresco propio: lo que se le
 *     mande es lo que ensenara hasta la proxima vez.
 *
 *   - `takeWidgetStop` recoge la parada que se acaba de pulsar en el, para abrir
 *     su hoja de "Avisarme del proximo bus". Elegir linea y sentido necesita la
 *     red oficial, asi que esa ventana solo puede levantarse aqui.
 *
 * Fuera de Android nada de esto existe y todas las funciones son inocuas: en el
 * navegador no hay pantalla de inicio donde poner un widget.
 */

/** Una parada tal y como la ensena el widget. */
export interface WidgetStop {
  stopId: string
  /** Lo que se lee en la app: el alias si lo tiene, si no el nombre oficial. */
  label: string
}

interface WidgetPlugin {
  /** Sustituye las paradas del widget por estas y lo redibuja. */
  sync(options: { stops: Array<{ id: string, label: string }> }): Promise<void>
  /** La parada pulsada en el widget, una sola vez: al leerla se olvida. */
  pendingStop(): Promise<{ stopId: string | null }>
  addListener(
    event: 'openStop',
    handler: (payload: { stopId: string }) => void,
  ): Promise<{ remove: () => Promise<void> }>
}

const Widget = registerPlugin<WidgetPlugin>('Widget')

/**
 * Cuantas paradas puede llegar a ensenar el widget mas grande.
 *
 * El mismo numero vive en `WidgetStore.MAX_STOPS`. Aqui sirve para no mandar una
 * lista de cuarenta paradas de la que el widget solo mirara las primeras.
 */
export const WIDGET_MAX_STOPS = 4

function supported(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'
}

/**
 * Baja al widget las paradas guardadas, en el mismo orden en que se ven en
 * Inicio: el widget pequeno ensena la primera, el grande las cuatro primeras.
 */
export async function syncWidgetStops(stops: WidgetStop[]): Promise<void> {
  if (!supported()) {
    return
  }

  try {
    await Widget.sync({
      stops: stops.slice(0, WIDGET_MAX_STOPS).map((stop) => ({
        id: stop.stopId,
        label: stop.label,
      })),
    })
  } catch {
    // Que el widget se quede con la lista de antes no puede impedir guardar una
    // parada: es una copia de conveniencia, no el dato.
  }
}

/**
 * La parada pulsada en el widget, si hay alguna sin atender.
 *
 * Se PREGUNTA en vez de esperar un evento porque pulsar el widget casi siempre
 * trae la app desde cero o desde segundo plano, y en los dos casos el aviso
 * llegaria antes de que esta pagina tuviera oyentes. La parte nativa la guarda y
 * aqui se recoge al arrancar y cada vez que la app vuelve a primer plano.
 */
export async function takeWidgetStop(): Promise<string | null> {
  if (!supported()) {
    return null
  }

  try {
    const { stopId } = await Widget.pendingStop()
    return stopId && stopId.length > 0 ? stopId : null
  } catch {
    return null
  }
}

/**
 * Avisa de un toque en el widget con la app ya delante.
 *
 * Es el caso raro —para llegar al widget hay que estar en la pantalla de
 * inicio—, asi que esto complementa a `takeWidgetStop`, no lo sustituye.
 *
 * El aviso NO trae la parada a proposito: quien la lee es siempre
 * `takeWidgetStop`, que ademas la olvida. Si esta se sirviera del evento y
 * aquella de la consulta, el mismo toque podria atenderse dos veces.
 */
export async function onWidgetStopTap(handler: () => void): Promise<void> {
  if (!supported()) {
    return
  }

  try {
    await Widget.addListener('openStop', () => handler())
  } catch {
    // Sin el oyente queda la consulta al volver a primer plano.
  }
}
