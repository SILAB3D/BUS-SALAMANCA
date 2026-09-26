package com.icuas.salbus;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.View;
import android.widget.RemoteViews;

import java.util.List;

/**
 * Widget de paradas favoritas.
 *
 * Ensena entre 1 y 4 de las paradas guardadas —las primeras de la lista de la
 * app— y cada una es un atajo a "Avisarme del proximo bus" de ESA parada.
 *
 * CUANTAS SE VEN, Y COMO DE GRANDES, LO DECIDE EL TAMANO. El widget es
 * redimensionable (`resizeMode` en res/xml/widget_favourites_info.xml) y el
 * lanzador avisa de cada estiron en {@link #onAppWidgetOptionsChanged}; de la
 * altura que reporta sale el numero de filas, y las filas se reparten el alto
 * entero para que no quede espacio vacio (ver {@link #fit}). No hay ajuste dentro de la app para esto a
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

    /**
     * Alto minimo de una parada, con su separacion: 6 dp hasta la anterior,
     * 6+6 de relleno y dos lineas de texto (14sp y 11sp). Es lo que se usa para
     * decidir cuantas caben; lo que sobre se reparte entre ellas. Con las
     * alturas de la rejilla sale 110dp una, 180dp dos, 250dp tres y 320dp
     * cuatro.
     */
    static final int MIN_ROW_DP = 56;

    /** Separacion entre paradas: el relleno superior de widget_row_slot. */
    private static final int ROW_GAP_DP = 6;

    /** Relleno de la caja del widget, arriba mas abajo (10+10). */
    private static final int BOX_PADDING_DP = 20;

    /** Alto de la cabecera: el autobus de 16dp y 8dp hasta la primera parada. */
    private static final int HEADER_DP = 24;

    /** Altura minima declarada en res/xml/widget_favourites_info.xml. */
    private static final int MIN_HEIGHT_DP = 110;

    /** Ancho minimo declarado en res/xml/widget_favourites_info.xml. */
    private static final int MIN_WIDTH_DP = 180;

    /**
     * Por debajo de este ancho la linea de accion solo sale si a la parada le
     * sobra alto para darle dos lineas.
     *
     * Al nombre de la parada le quedan unos 80 dp cuando el widget mide el
     * minimo: con la segunda linea puesta en una sola linea, las dos salen
     * cortadas.
     */
    private static final int COMPACT_WIDTH_DP = 220;

    /**
     * Como se reparte el widget para un tamano y un numero de paradas dados.
     *
     * La idea es que no quede espacio vacio: las paradas que se ensenan se
     * reparten el alto entero (llevan peso 1 en el layout) y, cuanto mas alto
     * le toca a cada una, mas grande es la letra y mas lineas tiene el nombre.
     * Asi una sola parada guardada en un widget de 4x4 lo llena, en vez de
     * quedarse arriba con el resto de la caja en blanco.
     *
     * Es una clase aparte, y sin nada de Android, para que el banco de pruebas
     * de debug (WidgetPreviewActivity) dibuje exactamente lo mismo.
     */
    static final class Fit {
        /** Si se ve la cabecera con el titulo. */
        boolean header;
        /** Cuantas paradas caben (1 a 4), las haya guardadas o no. */
        int capacity;
        /** Cuantas se ensenan de verdad. */
        int shown;
        /** Alto que le toca a cada parada, sin la separacion, en dp. */
        int rowDp;

        float badgeSp;
        float nameSp;
        float metaSp;
        int nameLines;
        /** 0 = la linea de accion no se ve. */
        int metaLines;
        /** Relleno de la insignia, en dp: horizontal y vertical. */
        int badgePadH;
        int badgePadV;
    }

    static Fit fit(int widthDp, int heightDp, int stopCount) {
        int height = Math.max(heightDp, MIN_HEIGHT_DP);
        Fit fit = new Fit();

        int withHeader = rowsFor(height - BOX_PADDING_DP - HEADER_DP);
        int withoutHeader = rowsFor(height - BOX_PADDING_DP);

        // La cabecera solo se sacrifica si con ello se ve una parada guardada
        // mas; si no, se queda, porque es lo que dice de que app es el widget.
        fit.header = !(withoutHeader > withHeader && stopCount > withHeader);
        fit.capacity = fit.header ? withHeader : withoutHeader;
        fit.shown = Math.max(1, Math.min(fit.capacity, stopCount));

        int rowsArea = height - BOX_PADDING_DP - (fit.header ? HEADER_DP : 0);
        fit.rowDp = rowsArea / fit.shown - ROW_GAP_DP;

        boolean narrow = widthDp < COMPACT_WIDTH_DP;

        if (fit.rowDp >= 110) {
            fit.badgeSp = 19;
            fit.nameSp = 20;
            fit.metaSp = 13;
            fit.nameLines = 3;
            fit.metaLines = 2;
            fit.badgePadH = 10;
            fit.badgePadV = 8;
        } else if (fit.rowDp >= 76) {
            fit.badgeSp = 16;
            fit.nameSp = 17;
            fit.metaSp = 12;
            fit.nameLines = 2;
            fit.metaLines = narrow ? 2 : 1;
            fit.badgePadH = 8;
            fit.badgePadV = 6;
        } else if (fit.rowDp >= 50) {
            fit.badgeSp = 13;
            fit.nameSp = 14;
            fit.metaSp = 11;
            fit.nameLines = 1;
            // Estrecho: la linea de accion se quedaria en «Avisarme d...», que
            // no dice nada y le roba el sitio al nombre de la parada.
            fit.metaLines = narrow ? 0 : 1;
            fit.badgePadH = 6;
            fit.badgePadV = 5;
        } else {
            // Justo: solo el numero y el nombre, en una linea.
            fit.badgeSp = 12;
            fit.nameSp = 13;
            fit.metaSp = 11;
            fit.nameLines = 1;
            fit.metaLines = 0;
            fit.badgePadH = 6;
            fit.badgePadV = 4;
        }

        return fit;
    }

    /**
     * Cuantas paradas caben en ese alto, de 1 a 4.
     *
     * Por division entera y hacia abajo: mas vale repartir el sobrante entre
     * las que caben que meter una mas aplastada. La primera parada no lleva
     * separacion encima, de ahi el ROW_GAP_DP que se suma.
     */
    private static int rowsFor(int areaDp) {
        int rows = (areaDp + ROW_GAP_DP) / MIN_ROW_DP;
        return Math.max(1, Math.min(WidgetStore.MAX_STOPS, rows));
    }

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
        views.removeAllViews(R.id.widget_rows);

        List<WidgetStore.Stop> stops = WidgetStore.readStops(context);

        if (stops.isEmpty()) {
            // Sin paradas no hay atajos: el widget entero abre la app, que es
            // donde se guardan.
            views.setViewVisibility(R.id.widget_header, View.VISIBLE);
            views.setViewVisibility(R.id.widget_rows, View.GONE);
            views.setViewVisibility(R.id.widget_empty, View.VISIBLE);
            views.setOnClickPendingIntent(R.id.widget_empty, openApp(context, widgetId, null, 0));
            manager.updateAppWidget(widgetId, views);
            return;
        }

        Fit fit = fit(widthDp(manager, widgetId), heightDp(manager, widgetId), stops.size());
        float density = context.getResources().getDisplayMetrics().density;

        views.setViewVisibility(R.id.widget_header, fit.header ? View.VISIBLE : View.GONE);
        views.setViewVisibility(R.id.widget_rows, View.VISIBLE);
        views.setViewVisibility(R.id.widget_empty, View.GONE);

        for (int index = 0; index < fit.shown; index++) {
            WidgetStore.Stop stop = stops.get(index);
            RemoteViews row = new RemoteViews(context.getPackageName(), R.layout.widget_favourites_row);

            // La primera parada no lleva separacion encima: pegaria un hueco
            // bajo la cabecera, o bajo el borde si la cabecera no esta.
            if (index == 0) {
                row.setViewPadding(R.id.widget_row_slot, 0, 0, 0, 0);
            }

            // La segunda linea de la fila (que pulsarla avisa del proximo bus) es
            // fija y ya viene del layout: aqui solo se rellena lo que cambia de
            // una parada a otra, y los tamanos que dependen del alto.
            row.setTextViewText(R.id.widget_row_badge, stop.id);
            row.setTextViewText(R.id.widget_row_name, stop.label);

            row.setTextViewTextSize(R.id.widget_row_badge, TypedValue.COMPLEX_UNIT_SP, fit.badgeSp);
            row.setTextViewTextSize(R.id.widget_row_name, TypedValue.COMPLEX_UNIT_SP, fit.nameSp);
            row.setTextViewTextSize(R.id.widget_row_meta, TypedValue.COMPLEX_UNIT_SP, fit.metaSp);
            row.setInt(R.id.widget_row_name, "setMaxLines", fit.nameLines);

            int padH = Math.round(fit.badgePadH * density);
            int padV = Math.round(fit.badgePadV * density);
            row.setViewPadding(R.id.widget_row_badge, padH, padV, padH, padV);

            if (fit.metaLines > 0) {
                row.setViewVisibility(R.id.widget_row_meta, View.VISIBLE);
                row.setInt(R.id.widget_row_meta, "setMaxLines", fit.metaLines);
            } else {
                row.setViewVisibility(R.id.widget_row_meta, View.GONE);
            }

            row.setOnClickPendingIntent(
                R.id.widget_row,
                openApp(context, widgetId, stop.id, index)
            );

            views.addView(R.id.widget_rows, row);
        }

        manager.updateAppWidget(widgetId, views);
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
