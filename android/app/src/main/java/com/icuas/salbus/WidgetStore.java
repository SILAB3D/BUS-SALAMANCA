package com.icuas.salbus;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * Las paradas guardadas, en un sitio donde el widget pueda leerlas.
 *
 * Las favoritas viven en el localStorage de la WebView, y el widget se dibuja
 * fuera de ella: cuando el lanzador pide pintarlo la app puede llevar dias sin
 * abrirse, asi que no hay ninguna pagina a la que preguntar. La web copia aqui
 * la lista cada vez que cambia ({@link WidgetPlugin#sync}) y el widget lee
 * SOLO de esta copia.
 *
 * Consecuencia asumida: el widget ensena lo ultimo que la app dejo escrito. Con
 * la app recien instalada y nunca abierta la copia esta vacia y el widget lo
 * dice en vez de mentir con una lista a medias.
 */
final class WidgetStore {

    private static final String PREFS = "salbus.widget";
    private static final String KEY_STOPS = "favourites";

    /** Cuantas paradas caben como maximo en el widget mas grande. */
    static final int MAX_STOPS = 4;

    private WidgetStore() {
    }

    /** Una parada tal y como la ensena el widget. */
    static final class Stop {
        final String id;
        /** El nombre que se ve en la app: el alias si lo tiene, si no el oficial. */
        final String label;

        Stop(String id, String label) {
            this.id = id;
            this.label = label;
        }
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /**
     * Sustituye la copia entera. Como en el resto del puente con la web, se
     * manda la lista completa y no altas y bajas sueltas: asi no hay forma de
     * que el widget y la app discrepen sobre que hay guardado.
     */
    static void writeStops(Context context, List<Stop> stops) {
        JSONArray array = new JSONArray();

        for (Stop stop : stops) {
            if (stop.id == null || stop.id.isEmpty()) {
                continue;
            }

            try {
                JSONObject item = new JSONObject();
                item.put("id", stop.id);
                item.put("label", stop.label == null || stop.label.isEmpty() ? stop.id : stop.label);
                array.put(item);
            } catch (Exception ignored) {
                // Una parada ilegible no puede tumbar la copia de las demas.
            }
        }

        prefs(context).edit().putString(KEY_STOPS, array.toString()).apply();
    }

    /**
     * La copia guardada, ya recortada a lo que cabe en el widget mas grande.
     *
     * El recorte se hace aqui y no al escribir para que la lista guardada siga
     * siendo la de la app: si manana el widget creciera, no habria que esperar
     * a que alguien abriera SALBUS para volver a tener las paradas de sobra.
     */
    static List<Stop> readStops(Context context) {
        List<Stop> stops = new ArrayList<>();
        String raw = prefs(context).getString(KEY_STOPS, "[]");

        try {
            JSONArray array = new JSONArray(raw);

            for (int index = 0; index < array.length() && stops.size() < MAX_STOPS; index++) {
                JSONObject item = array.optJSONObject(index);
                if (item == null) {
                    continue;
                }

                String id = item.optString("id", "");
                if (id.isEmpty()) {
                    continue;
                }

                stops.add(new Stop(id, item.optString("label", id)));
            }
        } catch (Exception ignored) {
            // Con la copia corrupta el widget ensena su estado vacio, que al
            // menos dice donde se arregla.
        }

        return stops;
    }
}
