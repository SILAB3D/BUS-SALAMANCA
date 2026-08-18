package com.icuas.bussalamanca;

import android.content.Intent;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Puente entre la interfaz web y {@link BusTrackingService}.
 *
 * La app web no puede seguir consultando cuando pasa a segundo plano (Android
 * congela los temporizadores del WebView), asi que delega el aviso de "proximo
 * bus" en un servicio en primer plano y se limita a reflejar sus resultados.
 */
@CapacitorPlugin(name = "BusTracking")
public class BusTrackingPlugin extends Plugin {

    @Override
    public void load() {
        BusTrackingService.setListener(this);
    }

    @Override
    protected void handleOnDestroy() {
        // El servicio debe sobrevivir a la destruccion de la actividad; solo se
        // desengancha el puente para no retener una instancia muerta.
        BusTrackingService.setListener(null);
        super.handleOnDestroy();
    }

    @PluginMethod
    public void start(PluginCall call) {
        String stopId = call.getString("stopId", "");
        String lineId = call.getString("lineId", "");

        if (stopId == null || stopId.isEmpty() || lineId == null || lineId.isEmpty()) {
            call.reject("Faltan stopId o lineId.");
            return;
        }

        Intent intent = new Intent(getContext(), BusTrackingService.class);
        intent.setAction(BusTrackingService.ACTION_START);
        intent.putExtra(BusTrackingService.EXTRA_STOP_ID, stopId);
        intent.putExtra(BusTrackingService.EXTRA_STOP_NAME, call.getString("stopName", stopId));
        intent.putExtra(BusTrackingService.EXTRA_LINE_ID, lineId);
        intent.putExtra(BusTrackingService.EXTRA_DESTINATION, call.getString("destination", ""));
        intent.putExtra(BusTrackingService.EXTRA_INTERVAL, call.getInt("intervalSeconds", 30));

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                getContext().startForegroundService(intent);
            } else {
                getContext().startService(intent);
            }
            call.resolve();
        } catch (Exception error) {
            call.reject("No se pudo iniciar el servicio: " + error.getMessage());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Intent intent = new Intent(getContext(), BusTrackingService.class);
        intent.setAction(BusTrackingService.ACTION_STOP);
        getContext().stopService(intent);
        call.resolve();
    }

    @PluginMethod
    public void isRunning(PluginCall call) {
        JSObject result = new JSObject();
        result.put("running", BusTrackingService.isRunning());
        call.resolve(result);
    }

    /** Invocado desde el servicio en cada ciclo para que la UI se mantenga al dia. */
    void emitArrivalUpdate(String stopId, String lineId, int minutes, boolean arriving, int status) {
        JSObject payload = new JSObject();
        payload.put("stopId", stopId);
        payload.put("lineId", lineId);
        payload.put("minutes", minutes);
        payload.put("arriving", arriving);
        payload.put("status", statusName(status));
        payload.put("at", System.currentTimeMillis());
        notifyListeners("arrivalUpdate", payload);
    }

    private static String statusName(int status) {
        switch (status) {
            case ArrivalsClient.STATUS_OK:
                return "ok";
            case ArrivalsClient.STATUS_EMPTY:
                return "empty";
            case ArrivalsClient.STATUS_THROTTLED:
                return "throttled";
            default:
                return "error";
        }
    }
}
