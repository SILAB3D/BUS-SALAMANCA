package com.icuas.bussalamanca;

import android.content.Intent;
import android.os.Build;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;

/**
 * Puente entre la interfaz web y {@link BusTrackingService}.
 *
 * La app web no puede seguir consultando cuando pasa a segundo plano (Android
 * congela los temporizadores del WebView), asi que delega los avisos de "proximo
 * bus" en un servicio en primer plano y se limita a reflejar sus resultados.
 *
 * La web manda SIEMPRE la lista completa de avisos activos ({@code sync}), no
 * altas y bajas sueltas: asi no hay forma de que las dos partes discrepen sobre
 * cuantos avisos hay vivos.
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

    /**
     * Sustituye los avisos vivos por los que llegan. Con la lista vacia se
     * detiene el servicio entero.
     */
    @PluginMethod
    public void sync(PluginCall call) {
        JSArray incoming = call.getArray("jobs");
        List<String> encoded = new ArrayList<>();

        if (incoming != null) {
            try {
                for (Object item : incoming.toList()) {
                    JSONObject job = item instanceof JSONObject
                        ? (JSONObject) item
                        : new JSONObject(String.valueOf(item));

                    String id = job.optString("id", "");
                    String stopId = job.optString("stopId", "");
                    String lineId = job.optString("lineId", "");

                    if (id.isEmpty() || stopId.isEmpty() || lineId.isEmpty()) {
                        continue;
                    }

                    // El separador es "|" y forma parte del id (stopId|lineId):
                    // el resto de campos se sanean para no romper el formato.
                    encoded.add(String.join("|",
                        id,
                        stopId,
                        clean(job.optString("stopName", stopId)),
                        lineId,
                        clean(job.optString("destination", "")),
                        String.valueOf(job.optInt("busesSeen", 0))));
                }
            } catch (Exception error) {
                call.reject("Lista de avisos no valida: " + error.getMessage());
                return;
            }
        }

        Intent intent = new Intent(getContext(), BusTrackingService.class);

        if (encoded.isEmpty()) {
            intent.setAction(BusTrackingService.ACTION_STOP);
            getContext().stopService(intent);
            call.resolve();
            return;
        }

        intent.setAction(BusTrackingService.ACTION_SYNC);
        intent.putExtra(BusTrackingService.EXTRA_JOBS, encoded.toArray(new String[0]));
        intent.putExtra(BusTrackingService.EXTRA_INTERVAL, call.getInt("intervalSeconds", 15));
        intent.putExtra(BusTrackingService.EXTRA_VIBRATE,
            Boolean.TRUE.equals(call.getBoolean("vibrateOnApproach", true)));

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

    /** Detiene todos los avisos. */
    @PluginMethod
    public void stop(PluginCall call) {
        Intent intent = new Intent(getContext(), BusTrackingService.class);
        intent.setAction(BusTrackingService.ACTION_STOP);
        getContext().stopService(intent);
        call.resolve();
    }

    /**
     * Estado del servicio para reconciliar al abrir la app.
     *
     * {@code stopped} son los avisos que la persona usuaria detuvo desde la
     * notificacion, posiblemente con la app cerrada. Sin ese dato, la web veria
     * su aviso guardado, no encontraria el servicio vivo y lo revivria.
     */
    @PluginMethod
    public void status(PluginCall call) {
        Set<String> stopped = BusTrackingService.readStoppedIds(getContext());

        JSArray ids = new JSArray();
        for (String id : stopped) {
            ids.put(id);
        }

        JSObject result = new JSObject();
        result.put("running", BusTrackingService.isRunning());
        result.put("stopped", ids);
        call.resolve(result);
    }

    /** La web ya ha aplicado las bajas: se olvidan para no repetirlas. */
    @PluginMethod
    public void clearStopped(PluginCall call) {
        BusTrackingService.clearStoppedIds(getContext());
        call.resolve();
    }

    /** Invocado desde el servicio en cada ciclo para que la UI se mantenga al dia. */
    void emitArrivalUpdate(
        String jobId,
        String stopId,
        String lineId,
        int minutes,
        boolean arriving,
        int status,
        int busesSeen,
        boolean finished
    ) {
        JSObject payload = new JSObject();
        payload.put("jobId", jobId);
        payload.put("stopId", stopId);
        payload.put("lineId", lineId);
        payload.put("minutes", minutes);
        payload.put("arriving", arriving);
        payload.put("status", statusName(status));
        payload.put("busesSeen", busesSeen);
        payload.put("finished", finished);
        payload.put("at", System.currentTimeMillis());
        notifyListeners("arrivalUpdate", payload);
    }

    /** Un autobus mas ha pasado por la parada y el aviso sigue con el siguiente. */
    void emitBusPassed(String jobId, String stopId, String lineId, int busesSeen, int target) {
        JSObject payload = new JSObject();
        payload.put("jobId", jobId);
        payload.put("stopId", stopId);
        payload.put("lineId", lineId);
        payload.put("busesSeen", busesSeen);
        payload.put("target", target);
        payload.put("at", System.currentTimeMillis());
        notifyListeners("busPassed", payload);
    }

    /** Detenido desde el boton "Detener" de su notificacion. */
    void emitJobStopped(String jobId) {
        JSObject payload = new JSObject();
        payload.put("jobId", jobId);
        notifyListeners("jobStopped", payload);
    }

    /** El "|" separa campos en el intent; en un nombre de parada seria un corte. */
    private static String clean(String value) {
        return value == null ? "" : value.replace('|', ' ');
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
