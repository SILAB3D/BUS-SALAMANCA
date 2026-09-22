package com.icuas.salbus;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.widget.RemoteViews;

import java.util.List;

/**
 * Widget de paradas favoritas.
 *
 * Ensena entre 1 y 4 de las paradas guardadas —las primeras de la lista de la
 * app— y cada una es un atajo a "Avisarme del proximo bus" de ESA parada.
 *
 * CUANTAS SE VEN LO DECIDE EL TAMANO. El widget es redimensionable
 * (`resizeMode` en res/xml/widget_favourites_info.xml) y el lanzador avisa de
 * cada estiron en {@link #onAppWidgetOptionsChanged}; de la altura que reporta
 * sale el numero de filas. No hay ajuste dentro de la app para esto a
 * proposito: el tamano ya se elige arrastrando el widget, y tener ademas un
 * numero en Ajustes permitiria pedir cuatro paradas en un widget donde solo
 * caben dos.
 *
 * El pulsado NO abre la ficha de la parada: abre la app con la parada elegida y
 * la web levanta la hoja del aviso (ver {@link WidgetPlugin}). La eleccion de
 * linea y sentido necesita la red oficial, que solo existe en la parte web, asi
 * que el widget no puede resolverla por su cuenta.
 */
public class FavouritesWidget extends AppWidgetProvider {

    /**
     * Intent con el que el widget abre la app.
     *
     * La accion es propia y no MAIN para que la web pueda distinguir "me han
     * abierto desde el widget" de un arranque normal desde el icono.
     */
    static final String ACTION_OPEN_STOP = "com.icuas.salbus.WIDGET_OPEN_STOP";

    /** Parada elegida, dentro del intent anterior. */
    static final String EXTRA_STOP_ID = "com.icuas.salbus.WIDGET_STOP_ID";

    /*
     * Altura de una fila de parada, con su separacion: 8+8 dp de relleno, el
     * nombre a 14sp, la linea de accion a 11sp y 6 dp hasta la siguiente.
     */
    private static final int ROW_HEIGHT_DP = 56;

    /** Lo que no son filas: el relleno de la caja (10+10) y la cabecera. */
    private static final int CHROME_HEIGHT_DP = 44;

    /** Altura minima declarada en res/xml/widget_favourites_info.xml. */
    private static final int MIN_HEIGHT_DP = 110;

    /** Ancho minimo declarado en res/xml/widget_favourites_info.xml. */
    private static final int MIN_WIDTH_DP = 180;

    /**
     * Por debajo de este ancho la fila se queda en una linea.
     *
     * Al nombre de la parada le quedan unos 80 dp cuando el widget mide el
     * minimo: con la segunda linea puesta, las dos salen cortadas. Sin ella el
     * nombre sigue cortado a veces, pero es lo unico que se corta.
     */
    private static final int COMPACT_WIDTH_DP = 220;

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] widgetIds) {
        for (int widgetId : widgetIds) {
            render(context, manager, widgetId);
        }
    }

    /** El widget se ha estirado o encogido: puede que ahora quepan mas paradas. */
    @Override
    public void onAppWidgetOptionsChanged(
        Context context,
        AppWidgetManager manager,
        int widgetId,
        Bundle newOptions
    ) {
        render(context, manager, widgetId);
    }

    /**
     * Redibuja todos los widgets colocados.
     *
     * Lo llama la app cuando cambian las paradas guardadas: el widget no tiene
     * refresco periodico (updatePeriodMillis="0") porque su contenido solo
     * cambia cuando alguien guarda, quita o renombra una parada.
     */
    static void renderAll(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        if (manager == null) {
            return;
        }

        int[] widgetIds = manager.getAppWidgetIds(new ComponentName(context, FavouritesWidget.class));
        if (widgetIds == null) {
            return;
        }

        for (int widgetId : widgetIds) {
            render(context, manager, widgetId);
        }
    }

    private static void render(Context context, AppWidgetManager manager, int widgetId) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_favourites);

        int capacity = rowsForHeight(heightDp(manager, widgetId));
        views.removeAllViews(R.id.widget_rows);

        List<WidgetStore.Stop> stops = WidgetStore.readStops(context);

        if (stops.isEmpty()) {
            // Sin paradas no hay atajos: el widget entero abre la app, que es
            // donde se guardan.
            views.setViewVisibility(R.id.widget_rows, View.GONE);
            views.setViewVisibility(R.id.widget_empty, View.VISIBLE);
            views.setOnClickPendingIntent(R.id.widget_empty, openApp(context, widgetId, null, 0));
            manager.updateAppWidget(widgetId, views);
            return;
        }

        views.setViewVisibility(R.id.widget_rows, View.VISIBLE);
        views.setViewVisibility(R.id.widget_empty, View.GONE);

        // Widget estrecho: la linea de accion no cabe entera y se quedaria en
        // «Avisarme d...», que no dice nada y le roba el sitio al nombre de la
        // parada, que es lo unico que hay que poder leer.
        boolean compact = widthDp(manager, widgetId) < COMPACT_WIDTH_DP;

        int shown = Math.min(capacity, stops.size());

        for (int index = 0; index < shown; index++) {
            WidgetStore.Stop stop = stops.get(index);
            RemoteViews row = new RemoteViews(context.getPackageName(), R.layout.widget_favourites_row);

            // La segunda linea de la fila (que pulsarla avisa del proximo bus) es
            // fija y ya viene del layout: aqui solo se rellena lo que cambia de
            // una parada a otra.
            row.setTextViewText(R.id.widget_row_badge, stop.id);
            row.setTextViewText(R.id.widget_row_name, stop.label);
            row.setViewVisibility(R.id.widget_row_meta, compact ? View.GONE : View.VISIBLE);
            row.setOnClickPendingIntent(
                R.id.widget_row,
                openApp(context, widgetId, stop.id, index)
            );

            views.addView(R.id.widget_rows, row);
        }

        manager.updateAppWidget(widgetId, views);
    }

    /**
     * Cuantas paradas caben en esa altura, de 1 a 4.
     *
     * Se cuenta por division entera y hacia abajo: mas vale un hueco al final
     * que una cuarta parada cortada por la mitad. Con las alturas de la rejilla
     * del lanzador sale una parada por celda a partir de la segunda: 110dp una,
     * 180dp dos, 250dp tres y 320dp cuatro.
     */
    static int rowsForHeight(int heightDp) {
        int usable = Math.max(heightDp, MIN_HEIGHT_DP) - CHROME_HEIGHT_DP;
        int rows = usable / ROW_HEIGHT_DP;

        return Math.max(1, Math.min(WidgetStore.MAX_STOPS, rows));
    }

    private static int widthDp(AppWidgetManager manager, int widgetId) {
        return optionDp(manager, widgetId, AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, MIN_WIDTH_DP);
    }

    private static int heightDp(AppWidgetManager manager, int widgetId) {
        return optionDp(manager, widgetId, AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, MIN_HEIGHT_DP);
    }

    /**
     * Una de las medidas que reporta el lanzador, en dp.
     *
     * Se piden siempre las MINIMAS, que son las del telefono en vertical: es la
     * peor de las dos orientaciones, y dibujar para la buena dejaria filas
     * cortadas al girar el telefono.
     */
    private static int optionDp(AppWidgetManager manager, int widgetId, String key, int fallback) {
        try {
            Bundle options = manager.getAppWidgetOptions(widgetId);
            if (options == null) {
                return fallback;
            }

            int value = options.getInt(key, 0);
            return value > 0 ? value : fallback;
        } catch (Exception error) {
            return fallback;
        }
    }

    /**
     * Abre SALBUS, con la parada elegida dentro si se pulso una.
     *
     * `requestCode` distinto por fila y por widget: dos PendingIntent se
     * consideran el mismo cuando coinciden accion, datos y codigo —los extras NO
     * cuentan—, asi que sin esto todas las filas acabarian abriendo la parada de
     * la primera.
     */
    private static PendingIntent openApp(Context context, int widgetId, String stopId, int index) {
        Intent intent = new Intent(context, MainActivity.class);
        intent.setAction(ACTION_OPEN_STOP);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);

        if (stopId != null) {
            intent.putExtra(EXTRA_STOP_ID, stopId);
        }

        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }

        return PendingIntent.getActivity(
            context,
            widgetId * (WidgetStore.MAX_STOPS + 1) + index,
            intent,
            flags
        );
    }
}
