/**
 * Por donde viene un autobus: en cual de las paradas anteriores esta.
 *
 * LA FUENTE NO LO DICE. La web oficial no publica posiciones ni identificadores
 * de vehiculo: por cada parada dice "linea N, M minutos" y nada mas. Lo unico
 * que delata una presencia fisica es que ese contador caiga a cero o uno, o que
 * la fuente escriba "LLEGANDO A PARADA". Todo lo demas es deduccion.
 *
 * La deduccion consiste en mirar ese mismo indicio en las paradas ANTERIORES
 * del recorrido —que vienen ya en el orden real del trayecto— y quedarse con la
 * mas avanzada que lo cumpla.
 *
 * Lo de "la mas avanzada" no es un detalle de estilo. Las paradas se consultan
 * en serie, una cada dos segundos, asi que los datos de una ventana NO son del
 * mismo instante: puede quedar un "llegando" rezagado de hace medio minuto y
 * otro mas adelante recien traido. Como un autobus solo avanza, el indice mayor
 * es siempre la verdad mas nueva.
 *
 * El modulo es puro: no toca DOM, ni red, ni estado. Lo usan las dos partes que
 * cuentan paradas —"ver por donde viene" y el aviso de proximo bus— porque dos
 * implementaciones de esta regla acabarian situando el mismo autobus en dos
 * sitios distintos con los mismos datos delante.
 *
 * El servicio nativo (BusTrackingService.sweepRoute) lleva su propia copia
 * portada a Java, porque tiene que contar paradas con la app cerrada. `npm test`
 * comprueba que las constantes no se separen.
 */

/** Contador (en minutos) al que se considera que el autobus esta en esa parada. */
export const AT_STOP_MINUTES = 1

/**
 * Paradas anteriores que se miran para localizar el autobus de un aviso.
 *
 * Ocho, siempre las mismas: son las que DIBUJA la pestana Seguir y las que se
 * recorren para el "a N paradas" de la notificacion. Una sola ventana, un solo
 * recuento, digan lo que digan la pestana abierta o el servicio nativo.
 *
 * Ocho no significa ocho peticiones. Con la pestana delante si —hay que dibujar
 * las ocho—, pero fuera de ella la busqueda va de tu parada hacia atras y PARA
 * en la primera que tenga el autobus encima, que es lo unico que hace falta
 * para decir a cuantas paradas viene. Cuando esta cerca, que es cuando el dato
 * sirve para algo, cuesta una o dos consultas; el ocho solo dice hasta donde se
 * puede llegar buscando cuando viene de lejos.
 */
export const ROUTE_WINDOW_STOPS = 8

/**
 * Por encima de estos minutos no se busca el autobus.
 *
 * Con veinte minutos por delante el autobus puede ni haber salido, "a trece
 * paradas" no cambia lo que nadie va a hacer, y la busqueda costaria el maximo
 * de peticiones justo cuando menos falta hace. El recuento aparece cuando
 * empieza a servir para algo: cuando hay que decidir si bajar ya a la parada.
 */
export const ROUTE_SCAN_MAX_MINUTES = 20

/**
 * Antiguedad maxima de una localizacion antes de dejar de ensenarla.
 *
 * Un autobus en marcha deja de estar donde estaba: pasado este tiempo, repetir
 * "a dos paradas" es afirmar algo que ya no consta. Se calla en vez de envejecer
 * el numero, porque un recuento a medias no se distingue en pantalla de uno
 * recien traido.
 */
export const ROUTE_FIX_MAX_AGE_MS = 120_000

/**
 * Hay que buscar por donde viene el autobus, para un tiempo de espera dado?
 *
 * Con veinte minutos por delante no: el autobus puede ni haber salido, "a trece
 * paradas" no cambia lo que nadie va a hacer, y la busqueda costaria la ventana
 * entera justo cuando menos falta hace. El recuento aparece cuando empieza a
 * servir para algo, o sea cuando hay que decidir si bajar ya a la parada.
 *
 * Lo que NO se hace es recortar la ventana por los minutos que faltan. Eso daba
 * por sentado que el autobus avanza a un ritmo fijo, y en cuanto acumulaba
 * retraso la busqueda se paraba antes de llegar a el: el aviso se quedaba sin
 * saber por donde venia precisamente cuando venia con retraso.
 */
export function shouldScanRoute(minutesUntil: number): boolean {
  return Number.isFinite(minutesUntil) && minutesUntil >= 0 && minutesUntil <= ROUTE_SCAN_MAX_MINUTES
}

/**
 * En cual de las paradas de la ventana esta el autobus.
 *
 * `minutesByStop` son los minutos que la fuente da para ESA linea en cada
 * parada, en el orden del recorrido (la primera es la mas lejana, la ultima es
 * la parada de referencia), ya envejecidos con el tiempo transcurrido desde que
 * se obtuvieron. `null` es "esa parada no publica ahora esa linea", que no es lo
 * mismo que cero.
 *
 * @returns el indice dentro de la ventana, o -1 si no consta en ninguna.
 */
export function locateBus(minutesByStop: Array<number | null>): number {
  let found = -1

  for (let index = 0; index < minutesByStop.length; index += 1) {
    const minutes = minutesByStop[index]
    if (minutes !== null && minutes <= AT_STOP_MINUTES) {
      found = index
    }
  }

  return found
}

/**
 * A cuantas paradas de la de referencia esta el autobus.
 *
 * @param windowLength paradas de la ventana, incluida la de referencia (la ultima).
 * @param busIndex lo que devolvio `locateBus`.
 * @returns 0 si esta en tu parada, N si viene N paradas antes, `null` si no consta.
 */
export function stopsAwayFrom(windowLength: number, busIndex: number): number | null {
  if (busIndex < 0 || windowLength <= 0) {
    return null
  }

  return Math.max(0, windowLength - 1 - busIndex)
}

/** "en tu parada" · "a 1 parada" · "a 4 paradas" · "" cuando no consta. */
export function describeStopsAway(stopsAway: number | null): string {
  if (stopsAway === null) {
    return ''
  }

  if (stopsAway <= 0) {
    return 'en tu parada'
  }

  return stopsAway === 1 ? 'a 1 parada' : `a ${stopsAway} paradas`
}
