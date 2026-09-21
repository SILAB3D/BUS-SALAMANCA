package com.icuas.salbus;

import android.content.Intent;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * Puente entre la interfaz web y {@link FavouritesWidget}.
 *
 * Hace dos cosas, una en cada sentido:
 *
 *  - {@code sync} baja al widget la lista de paradas guardadas. El widget vive
 *    fuera de la WebView y no puede leer el localStorage, asi que la web le deja
 *    una copia ({@link WidgetStore}) cada vez que esa lista cambia.
 *
 *  - {@code pendingStop} sube la parada que se acaba de pulsar en el widget,
 *    para que la web abra su hoja de "Avisarme del proximo bus".
 *
 * Lo segundo se PREGUNTA, no se emite. Pulsar el widget suele traer la app
 * desde cero o desde segundo plano, y en los dos casos el aviso llegaria antes
 * de que la pagina tuviera oyentes: la parada se guarda aqui y la web la recoge
 * al arrancar y cada vez que vuelve a primer plano. El evento {@code openStop}
 * existe solo para el caso raro de que la app ya estuviera delante.
 */
@CapacitorPlugin(name = "Widget")
public class WidgetPlugin extends Plugin {

    /**
     * Parada pulsada que la web todavia no ha recogido.
     *
     * Estatica porque el intent puede llegar antes de que exista la instancia
     * del plugin —arranque en frio— y porque girar el telefono destruye la
     * actividad: en una instancia normal la parada se perderia por el camino.
     */
    private static volatile String pendingStopId = null;

    @Override
    public void load() {
        // Arranque en frio: la parada viene en el intent que abrio la app.
        if (getActivity() != null) {
            capture(getActivity().getIntent());
        }
    }

    /** La app ya estaba abierta (aunque fuera en segundo plano) y llega un intent nuevo. */
    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);

        if (!capture(intent)) {
            return;
        }

        JSObject payload = new JSObject();
        payload.put("stopId", pendingStopId);
        notifyListeners("openStop", payload);
    }

    /**
     * Guarda la parada del intent, si la trae.
     *
     * El extra se borra despues: sin eso, cualquier cosa que reconstruyera la
     * actividad —girar el telefono, el sistema recuperandola de memoria— volveria
     * a leer el mismo intent y abriria otra vez una hoja que ya se habia cerrado.
     */
    private boolean capture(Intent intent) {
        if (intent == null || !FavouritesWidget.ACTION_OPEN_STOP.equals(intent.getAction())) {
            return false;
        }

        String stopId = intent.getStringExtra(FavouritesWidget.EXTRA_STOP_ID);
        intent.removeExtra(FavouritesWidget.EXTRA_STOP_ID);

        if (stopId == null || stopId.isEmpty()) {
            return false;
        }

        pendingStopId = stopId;
        return true;
    }

    /**
     * Entrega la parada pulsada en el widget Y la olvida: se lee una sola vez.
     *
     * Sin el borrado, volver a la app dias despues abriria la hoja de un toque
     * que ya se atendio.
     */
    @PluginMethod
    public void pendingStop(PluginCall call) {
        // Segunda pasada por el intent de la actividad: si por lo que fuera este
        // plugin se hubiera creado despues de abrirse la app, `load()` no habria
        // llegado a tiempo de leerlo y el toque en el widget se perderia.
        if (pendingStopId == null && getActivity() != null) {
            capture(getActivity().getIntent());
        }

        JSObject ret = new JSObject();
        ret.put("stopId", pendingStopId);
        pendingStopId = null;
        call.resolve(ret);
    }

    /**
     * Sustituye las paradas del widget por estas y lo redibuja.
     *
     * Llega la lista COMPLETA, como en el resto del puente con la web: con altas
     * y bajas sueltas bastaria un fallo para que el widget ensenara para siempre
     * una parada que ya nadie tiene guardada.
     */
    @PluginMethod
    public void sync(PluginCall call) {
        JSArray incoming = call.getArray("stops");
        List<WidgetStore.Stop> stops = new ArrayList<>();

        if (incoming != null) {
            try {
                for (Object item : incoming.toList()) {
                    JSONObject stop = item instanceof JSONObject
                        ? (JSONObject) item
                        : new JSONObject(String.valueOf(item));

                    String id = stop.optString("id", "");
                    if (id.isEmpty()) {
                        continue;
                    }

                    stops.add(new WidgetStore.Stop(id, stop.optString("label", id)));
                }
            } catch (Exception error) {
                call.reject("Lista de paradas no valida: " + error.getMessage());
                return;
            }
        }

        try {
            WidgetStore.writeStops(getContext(), stops);
            FavouritesWidget.renderAll(getContext());
        } catch (Exception error) {
            call.reject("No se pudo actualizar el widget: " + error.getMessage());
            return;
        }

        call.resolve();
    }
}
