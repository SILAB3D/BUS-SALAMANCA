/**
 * Deteccion de pasos reales de un autobus por una parada.
 *
 * La fuente oficial solo dice "a la linea N le faltan M minutos". No existe un
 * evento "el bus ha pasado", asi que hay que deducirlo observando como decrece
 * ese contador y que ocurre despues. Reglas (todas medidas contra datos reales):
 *
 *   1. ARMADO. Cuando el contador baja a `ARM_MINUTES` o menos, hay un bus
 *      entrando. Se anota el instante estimado de paso: `ahora + minutos`.
 *   2. PASO POR SALTO. Si estando armado el contador SUBE de golpe, lo que se
 *      esta viendo ya es el bus siguiente: el anterior ha pasado. El salto mnimo
 *      es de 3 minutos para no confundirlo con el ruido de la fuente (un mismo
 *      bus puede oscilar 1-2 minutos entre consultas).
 *   3. PASO POR DESAPARICION. Si estando armado la linea deja de aparecer, el bus
 *      ha pasado y no hay otro a la vista. Se exigen dos consultas seguidas sin
 *      verlo, salvo que ya se hubiera rebasado la hora estimada de paso, en cuyo
 *      caso una basta.
 *
 * La version anterior solo aceptaba la regla 2 con un salto hasta >= 6 minutos, de
 * modo que en las lineas frecuentes (donde el bus siguiente ya viene a 4 minutos)
 * NUNCA se registraba un paso. Ese era el motivo principal de que la pantalla de
 * puntualidad se quedase siempre vacia.
 *
 * El modulo es puro: no toca DOM, red ni almacenamiento. Asi se puede probar
 * entero desde Node (`npm test`).
 */

/** Contador (en minutos) a partir del cual se considera que el bus esta entrando. */
export const ARM_MINUTES = 3

/** Subida minima del contador que delata que ya se esta viendo el bus siguiente. */
export const JUMP_MINUTES = 3

/** Consultas seguidas sin ver la linea que confirman el paso. */
export const MISSING_STREAK = 2

/** Dos pasos de la misma linea no pueden estar mas juntos que esto. */
export const MIN_GAP_MS = 90_000

/** Tolerancia por defecto al emparejar un paso con su hora programada. */
export const DEFAULT_TOLERANCE_MIN = 15

export interface MonitorRuntime {
  armed: boolean
  /** Ultimo contador visto (minutos), o `null` si la linea no aparecia. */
  lastMinutes: number | null
  /** Instante estimado de paso mientras esta armado. */
  expectedPassAt: number | null
  missingStreak: number
  /** Ultimo paso registrado, para no contar dos veces el mismo bus. */
  lastPassAt: number | null
}

export interface Observation {
  /** Minutos que faltan segun la fuente, o `null` si la linea no figura. */
  minutes: number | null
  /** Instante de la observacion (epoch ms). */
  at: number
}

export interface PassDetection {
  runtime: MonitorRuntime
  /** Instante estimado en que el bus paso, o `null` si aun no hay paso. */
  passAt: number | null
  /** Regla que disparo la deteccion; util para el registro. */
  reason: 'jump' | 'gone' | null
}

export function emptyRuntime(): MonitorRuntime {
  return { armed: false, lastMinutes: null, expectedPassAt: null, missingStreak: 0, lastPassAt: null }
}

export function observe(previous: MonitorRuntime | undefined, observation: Observation): PassDetection {
  const runtime: MonitorRuntime = { ...emptyRuntime(), ...previous }
  const { minutes, at } = observation

  const commit = (reason: 'jump' | 'gone'): PassDetection => {
    const passAt = clampPassAt(runtime.expectedPassAt, at)

    // Rebote de la fuente: el mismo bus no puede pasar dos veces seguidas.
    if (runtime.lastPassAt !== null && passAt - runtime.lastPassAt < MIN_GAP_MS) {
      return { runtime: { ...runtime, armed: false, expectedPassAt: null }, passAt: null, reason: null }
    }

    return {
      runtime: {
        armed: false,
        lastMinutes: minutes,
        expectedPassAt: null,
        missingStreak: 0,
        lastPassAt: passAt,
      },
      passAt,
      reason,
    }
  }

  if (minutes === null) {
    runtime.missingStreak += 1

    const overdue = runtime.expectedPassAt !== null && at >= runtime.expectedPassAt
    if (runtime.armed && (runtime.missingStreak >= MISSING_STREAK || overdue)) {
      return commit('gone')
    }

    runtime.lastMinutes = null
    return { runtime, passAt: null, reason: null }
  }

  runtime.missingStreak = 0

  const jumped =
    runtime.armed && runtime.lastMinutes !== null && minutes >= runtime.lastMinutes + JUMP_MINUTES

  if (jumped) {
    const detection = commit('jump')
    if (detection.passAt !== null) {
      // El contador que se acaba de leer ya es el del bus siguiente.
      detection.runtime.lastMinutes = minutes
      detection.runtime.armed = minutes <= ARM_MINUTES
      detection.runtime.expectedPassAt = minutes <= ARM_MINUTES ? at + minutes * 60_000 : null
    }
    return detection
  }

  if (minutes <= ARM_MINUTES) {
    runtime.armed = true
    // Se guarda la estimacion mas tardia disponible: la ultima observacion es la
    // mejor informada sobre cuando entra de verdad.
    runtime.expectedPassAt = at + minutes * 60_000
  }

  runtime.lastMinutes = minutes
  return { runtime, passAt: null, reason: null }
}

function clampPassAt(expected: number | null, at: number): number {
  if (expected === null) {
    return at
  }
  // La estimacion nunca puede quedar en el futuro respecto a la deteccion, ni
  // mas de cinco minutos antes (seria un dato viejo arrastrado).
  return Math.min(at, Math.max(expected, at - 5 * 60_000))
}

/* ------------------------------------------------------------------ *
 * Emparejado con el horario programado                                 *
 * ------------------------------------------------------------------ */

export interface SlotMatch {
  slot: string | null
  /** Desvio en minutos frente al horario (positivo = tarde). */
  delta: number | null
}

/**
 * Empareja un paso observado con la salida programada mas cercana.
 *
 * `slots` debe venir ya acotado a la franja del control (mas un margen): de lo
 * contrario un paso de las 08:02 se atribuia a la salida de las 08:05 aunque el
 * control cubriese solo hasta las 08:00, y la muestra desaparecia de la tabla.
 */
export function matchSlot(
  observedMinutes: number,
  slots: string[],
  toleranceMinutes = DEFAULT_TOLERANCE_MIN,
): SlotMatch {
  let best: string | null = null
  let bestDelta: number | null = null

  for (const slot of slots) {
    const delta = observedMinutes - clockToMinutes(slot)
    if (bestDelta === null || Math.abs(delta) < Math.abs(bestDelta)) {
      best = slot
      bestDelta = delta
    }
  }

  if (best === null || bestDelta === null || Math.abs(bestDelta) > toleranceMinutes) {
    return { slot: null, delta: null }
  }

  return { slot: best, delta: bestDelta }
}

export function clockToMinutes(clock: string): number {
  const [hours = '0', minutes = '0'] = clock.split(':')
  return (Number.parseInt(hours, 10) || 0) * 60 + (Number.parseInt(minutes, 10) || 0)
}

export function minutesToClock(dayMinutes: number): string {
  const normalized = ((Math.round(dayMinutes) % 1440) + 1440) % 1440
  return `${String(Math.floor(normalized / 60)).padStart(2, '0')}:${String(normalized % 60).padStart(2, '0')}`
}

/** Media de un conjunto de minutos del dia, redondeada al minuto. */
export function averageMinutes(values: number[]): number | null {
  if (values.length === 0) {
    return null
  }
  return Math.round(values.reduce((total, value) => total + value, 0) / values.length)
}
