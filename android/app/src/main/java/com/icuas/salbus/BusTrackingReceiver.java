package com.icuas.salbus;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

/**
 * Despertador de los controles de puntualidad.
 *
 * Entre franja y franja el servicio NO se queda vivo: un servicio en primer
 * plano de tipo dataSync tiene un tope diario de horas en Android 15, y gastarlo
 * esperando lo dejaria detenido justo cuando hiciera falta medir. En su lugar se
 * programa una alarma para el comienzo de la siguiente franja y el servicio se
 * apaga del todo.
 *
 * Cuando la alarma llega, el sistema deja a la app unos segundos de permiso para
 * arrancar un servicio en primer plano; es en esos segundos donde ocurre todo lo
 * de aqui. Tambien atiende al arranque del movil, porque un reinicio se lleva por
 * delante tanto el servicio como las alarmas programadas.
 */
public class BusTrackingReceiver extends BroadcastReceiver {

    /** Ha llegado la hora de mirar si toca medir. */
    public static final String ACTION_WAKE = "com.icuas.salbus.TRACKING_WAKE";

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent == null ? "" : String.valueOf(intent.getAction());

        if (Intent.ACTION_BOOT_COMPLETED.equals(action)) {
            // Tras reiniciar no se arranca nada: solo se vuelve a poner el
            // despertador de la siguiente franja. Arrancar un servicio en primer
            // plano desde el arranque del sistema no siempre esta permitido.
            BusTrackingService.planBackgroundWork(context, BusTrackingService.readStoredMonitors(context));
            return;
        }

        if (!ACTION_WAKE.equals(action)) {
            return;
        }

        Intent service = new Intent(context, BusTrackingService.class);
        service.setAction(BusTrackingService.ACTION_TICK);

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(service);
            } else {
                context.startService(service);
            }
        } catch (Exception error) {
            // El sistema puede negarse a arrancar el servicio (ahorro extremo de
            // bateria, app restringida). Se vuelve a intentar mas tarde en lugar
            // de perder la franja entera.
            BusTrackingService.scheduleWakeUp(context, System.currentTimeMillis() + 10 * 60_000L);
        }
    }
}
