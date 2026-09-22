package com.icuas.salbus;

import android.app.Activity;
import android.graphics.Color;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * Banco de pruebas del widget de paradas. SOLO en debug.
 *
 * El widget se dibuja en el lanzador, y para verlo hay que instalarlo, entrar
 * en el selector de widgets y arrastrarlo a un hueco del tamano exacto que se
 * quiera mirar: cuatro veces, y otra mas por cada tema. Esta actividad infla
 * los MISMOS layouts dentro de cajas del tamano de la rejilla, de forma que un
 * cambio de estetica se ve entero de una vez con:
 *
 *   gradlew installDebug
 *   adb shell am start -n com.icuas.bussalamanca/com.icuas.salbus.WidgetPreviewActivity
 *   adb exec-out screencap -p > widget.png
 *
 * y el tema oscuro con `adb shell cmd uimode night yes`.
 *
 * NO es el widget de verdad: no hay RemoteViews ni PendingIntent, porque lo que
 * se esta comprobando es como se ve, no a donde lleva. Las filas se rellenan
 * igual que en {@link FavouritesWidget} y el numero de paradas sale de
 * {@link FavouritesWidget#rowsForHeight}, asi que la relacion tamano-filas que
 * se ve aqui es la misma que dara el lanzador.
 */
public class WidgetPreviewActivity extends Activity {

    /** Ancho, alto y titulo de cada caja. Los altos son los de la rejilla: 70n-30 dp. */
    private static final int[][] SIZES = {
        { 180, 110 },
        { 250, 180 },
        { 320, 250 },
        { 320, 320 },
        { 180, 320 }
    };

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);

        LinearLayout page = new LinearLayout(this);
        page.setOrientation(LinearLayout.VERTICAL);
        page.setPadding(dp(16), dp(16), dp(16), dp(24));

        // Gris medio a proposito: sobre blanco no se ve si el widget tiene
        // borde, y sobre negro no se ve el degradado del tema claro.
        page.setBackgroundColor(Color.parseColor("#9AA4B8"));

        for (int[] size : SIZES) {
            addSample(page, size[0], size[1], sampleStops());
        }

        // Y el estado sin paradas, que es ademas lo que ensena el selector del
        // lanzador antes de colocar el widget.
        addSample(page, 250, 180, new ArrayList<WidgetStore.Stop>());

        ScrollView scroll = new ScrollView(this);
        scroll.addView(page);
        setContentView(scroll);
    }

    private void addSample(LinearLayout page, int widthDp, int heightDp, List<WidgetStore.Stop> stops) {
        int capacity = FavouritesWidget.rowsForHeight(heightDp);
        // Mismo umbral que FavouritesWidget.COMPACT_WIDTH_DP.
        boolean compact = widthDp < 220;
        int shown = Math.min(capacity, stops.size());

        TextView caption = new TextView(this);
        caption.setText(widthDp + "x" + heightDp + " dp · caben " + capacity + (compact ? " · estrecha" : "")
            + (stops.isEmpty() ? " · sin paradas guardadas" : " · se ven " + shown));
        caption.setTextColor(Color.WHITE);
        caption.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        caption.setPadding(0, dp(12), 0, dp(6));
        page.addView(caption);

        View widget = LayoutInflater.from(this).inflate(R.layout.widget_favourites, page, false);
        ViewGroup rows = widget.findViewById(R.id.widget_rows);
        rows.removeAllViews();

        if (stops.isEmpty()) {
            rows.setVisibility(View.GONE);
            widget.findViewById(R.id.widget_empty).setVisibility(View.VISIBLE);
        } else {
            rows.setVisibility(View.VISIBLE);
            widget.findViewById(R.id.widget_empty).setVisibility(View.GONE);

            for (int index = 0; index < shown; index++) {
                WidgetStore.Stop stop = stops.get(index);
                View row = LayoutInflater.from(this).inflate(R.layout.widget_favourites_row, rows, false);

                ((TextView) row.findViewById(R.id.widget_row_badge)).setText(stop.id);
                ((TextView) row.findViewById(R.id.widget_row_name)).setText(stop.label);
                row.findViewById(R.id.widget_row_meta).setVisibility(compact ? View.GONE : View.VISIBLE);

                rows.addView(row);
            }
        }

        FrameLayout box = new FrameLayout(this);
        LinearLayout.LayoutParams boxParams =
            new LinearLayout.LayoutParams(dp(widthDp), dp(heightDp));
        boxParams.gravity = Gravity.START;
        box.setLayoutParams(boxParams);
        box.addView(widget, new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT
        ));

        page.addView(box);
    }

    /** Nombres largos y cortos mezclados: es donde se rompen los recortes. */
    private static List<WidgetStore.Stop> sampleStops() {
        return new ArrayList<>(Arrays.asList(
            new WidgetStore.Stop("104", "Gran Via"),
            new WidgetStore.Stop("27", "Plaza de Espana"),
            new WidgetStore.Stop("312", "Avenida de Portugal, 43 (junto al mercado)"),
            new WidgetStore.Stop("8", "Puente Romano")
        ));
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
