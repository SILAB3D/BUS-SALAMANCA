import { Capacitor } from '@capacitor/core'
import { LocalNotifications } from '@capacitor/local-notifications'

import type { PermissionState } from '../state'

/**
 * Notificaciones locales.
 *
 * El aviso de "proximo bus" es una notificacion PERSISTENTE (`ongoing`) que se
 * reescribe con el mismo id cada vez que llegan datos nuevos: Android sustituye el
 * contenido en el sitio, sin apilar avisos ni volver a sonar.
 *
 * El icono pequeno de la barra de estado debe ser una silueta monocroma con fondo
 * transparente (`res/drawable/ic_stat_salbus.xml`); Android descarta el color y
 * pinta solo el canal alfa, por lo que un icono con fondo se veria como un cuadro.
 */

const CHANNEL_ID = 'salbus-seguimiento'
const SMALL_ICON = 'ic_stat_salbus'

let channelReady = false

export function isNative(): boolean {
  return Capacitor.isNativePlatform()
}

export async function ensureNotificationPermission(): Promise<PermissionState> {
  if (!isNative()) {
    return 'unknown'
  }

  try {
    let status = await LocalNotifications.checkPermissions()
    if (status.display !== 'granted') {
      status = await LocalNotifications.requestPermissions()
    }

    if (status.display === 'granted') {
      await ensureChannel()
      return 'granted'
    }

    return status.display === 'denied' ? 'denied' : 'unknown'
  } catch {
    return 'unknown'
  }
}

async function ensureChannel(): Promise<void> {
  if (channelReady || Capacitor.getPlatform() !== 'android') {
    return
  }

  try {
    await LocalNotifications.createChannel({
      id: CHANNEL_ID,
      name: 'Seguimiento de autobus',
      description: 'Aviso persistente con los minutos que faltan para tu autobus.',
      // IMPORTANCE_LOW: visible y actualizable, pero sin sonido en cada refresco.
      importance: 2,
      visibility: 1,
      sound: undefined,
      vibration: false,
    })
    channelReady = true
  } catch {
    /* el canal ya existe o el plugin no lo soporta */
  }
}

export interface TrackingNotification {
  id: number
  stopName: string
  lineId: string
  destination: string
  minutes: number | null
  arriving: boolean
  updatedAt: Date
  stale: boolean
}

export async function showTrackingNotification(payload: TrackingNotification): Promise<void> {
  if (!isNative()) {
    return
  }

  await ensureChannel()

  const eta = payload.arriving
    ? 'Llegando a la parada'
    : payload.minutes === null
      ? 'Sin estimacion ahora mismo'
      : payload.minutes <= 0
        ? 'Llegando'
        : `En ${payload.minutes} min`

  const suffix = payload.stale ? ' · dato no confirmado' : ''
  const clock = payload.updatedAt.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })

  try {
    await LocalNotifications.schedule({
      notifications: [
        {
          id: payload.id,
          title: `Línea ${payload.lineId} · ${eta}`,
          body: `${payload.stopName} → ${payload.destination}\nActualizado a las ${clock}${suffix}`,
          channelId: CHANNEL_ID,
          smallIcon: SMALL_ICON,
          ongoing: true,
          autoCancel: false,
          silent: true,
        },
      ],
    })
  } catch {
    /* la notificacion es un extra: nunca debe romper el ciclo de refresco */
  }
}

export async function showArrivalAlert(id: number, lineId: string, stopName: string): Promise<void> {
  if (!isNative()) {
    return
  }

  await ensureChannel()

  try {
    await LocalNotifications.schedule({
      notifications: [
        {
          id,
          title: `Línea ${lineId} está llegando`,
          body: `Tu autobús está entrando en ${stopName}.`,
          channelId: CHANNEL_ID,
          smallIcon: SMALL_ICON,
          ongoing: false,
          autoCancel: true,
        },
      ],
    })
  } catch {
    /* ignorado a proposito */
  }
}

export async function cancelNotification(id: number): Promise<void> {
  if (!isNative()) {
    return
  }

  try {
    await LocalNotifications.cancel({ notifications: [{ id }] })
  } catch {
    /* ignorado a proposito */
  }
}

/** Id numerico estable a partir de una clave de texto. */
export function notificationId(key: string): number {
  let hash = 0
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) | 0
  }
  return Math.abs(hash % 2_000_000) + 1000
}
