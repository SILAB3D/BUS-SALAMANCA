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
 * Paradas anteriores que ensena el recorrido de un aviso.
 *
 * Es lo que se DIBUJA cuando alguien esta mirando la pestana, y por tanto lo
 * que se consulta entonces: ocho paradas son ~16 s de cola, sostenibles solo
 * con la pantalla delante. Fuera de ahi nadie mira el recorrido y basta con
 * buscar hasta ROUTE_SCAN_MAX_STOPS.
 */
export const ROUTE_WINDOW_STOPS = 8

/**
 * Paradas anteriores como mucho que se miran para localizar el autobus cuando
 * NO se esta mirando el recorrido.
 *
 * Cada una es una peticion contra una fuente que solo admite una cada dos
 * segundos, y esas peticiones salen del mismo turno que necesita el tiempo de
 * TU parada. Seis son ~12 s de cola: por encima de eso empieza a llegar tarde
 * justamente el dato por el que se creo el aviso.
 */
export const ROUTE_SCAN_MAX_STOPS = 6

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
 * Minutos que tarda de media un autobus urbano entre dos paradas.
 *
 * Solo se usa para acotar hasta donde buscar: con cinco minutos de espera no
 * tiene sentido consultar la parada de hace diez. No es una estimacion que se
 * ensene en ninguna parte ni sustituye a la deteccion; si lo fuera, el recuento
 * seria una division y no haria falta consultar nada.
 */
export const MINUTES_PER_STOP = 1.5

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
 * Cuantas paradas anteriores hay que mirar para un tiempo de espera dado.
 *
 * Cero significa "no busques": o no hay dato de llegada, o el autobus esta
 * demasiado lejos como para que el recuento aporte algo.
 *
 * La busqueda va de la parada propia hacia atras y se para en la primera que
 * tenga el autobus encima, asi que cuando esta cerca —que es cuando el dato
 * importa— basta con una o dos consultas.
 */
export function routeScanDepth(minutesUntil: number): number {
  if (!Number.isFinite(minutesUntil) || minutesUntil < 0 || minutesUntil > ROUTE_SCAN_MAX_MINUTES) {
    return 0
  }

  return Math.min(ROUTE_SCAN_MAX_STOPS, Math.ceil(minutesUntil / MINUTES_PER_STOP) + 1)
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
