package com.icuas.bussalamanca;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;

import androidx.annotation.Nullable;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * Servicio en primer plano que mantiene vivo el aviso de "proximo bus".
 *
 * Es la unica forma fiable de seguir actualizando en Android cuando la app pasa a
 * segundo plano: los temporizadores del WebView se congelan, pero un servicio en
 * primer plano con notificacion persistente sigue ejecutandose.
 *
 * Consulta una sola parada cada `intervalSeconds` (30 s por defecto), muy por
 * debajo del limite de la fuente oficial, y reescribe la misma notificacion en
 * cada ciclo para que el tiempo mostrado sea siempre el actual.
 */
public class BusTrackingService extends Service {

    public static final String ACTION_START = "com.icuas.bussalamanca.TRACKING_START";
    public static final String ACTION_STOP = "com.icuas.bussalamanca.TRACKING_STOP";

    public static final String EXTRA_STOP_ID = "stopId";
    public static final String EXTRA_STOP_NAME = "stopName";
    public static final String EXTRA_LINE_ID = "lineId";
    public static final String EXTRA_DESTINATION = "destination";
    public static final String EXTRA_INTERVAL = "intervalSeconds";

    private static final String CHANNEL_ID = "salbus-seguimiento";
    private static final int NOTIFICATION_ID = 4201;

    /** Espera tras un 429, duplicandose hasta el maximo. */
    private static final long BACKOFF_BASE_MS = 15_000L;
    private static final long BACKOFF_MAX_MS = 120_000L;

    private static volatile boolean running = false;

    /** La instancia del plugin recibe las actualizaciones para reflejarlas en la UI. */
    @Nullable
    private static volatile BusTrackingPlugin listener = null;

    private HandlerThread workerThread;
    private Handler worker;

    private String stopId = "";
    private String stopName = "";
    private String lineId = "";
    private String destination = "";
    private long intervalMs = 30_000L;
    private long backoffMs = BACKOFF_BASE_MS;

    public static boolean isRunning() {
        return running;
    }

    public static void setListener(@Nullable BusTrackingPlugin plugin) {
        listener = plugin;
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
        workerThread = new HandlerThread("salbus-tracking");
        workerThread.start();
        worker = new Handler(workerThread.getLooper());
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || ACTION_STOP.equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }

        stopId = valueOf(intent.getStringExtra(EXTRA_STOP_ID));
        stopName = valueOf(intent.getStringExtra(EXTRA_STOP_NAME));
        lineId = valueOf(intent.getStringExtra(EXTRA_LINE_ID));
        destination = valueOf(intent.getStringExtra(EXTRA_DESTINATION));

        int seconds = intent.getIntExtra(EXTRA_INTERVAL, 30);
        // Nunca por debajo de 15 s: protege a la fuente oficial de un exceso de
        // consultas aunque se pida un intervalo menor.
        intervalMs = Math.max(15, seconds) * 1000L;

        startInForeground(buildNotification("Buscando tu autobús…", "Línea " + lineId + " · " + stopName));
        running = true;

        worker.removeCallbacksAndMessages(null);
        worker.post(this::poll);

        // START_REDELIVER_INTENT: si el sistema mata el servicio, lo recrea con los
        // mismos datos de seguimiento.
        return START_REDELIVER_INTENT;
    }

    private void startInForeground(Notification notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    private void poll() {
        if (!running) {
            return;
        }

        ArrivalsClient.Result result = ArrivalsClient.fetch(stopId);
        long nextDelay = intervalMs;

        if (result.status == ArrivalsClient.STATUS_THROTTLED) {
            // La fuente esta limitando: se espera mas y se mantiene el ultimo texto.
            nextDelay = Math.max(intervalMs, backoffMs);
            backoffMs = Math.min(BACKOFF_MAX_MS, backoffMs * 2);
            notifyUi(result.status, -1, false);
        } else {
            backoffMs = BACKOFF_BASE_MS;

            ArrivalsClient.Arrival arrival =
                result.status == ArrivalsClient.STATUS_OK ? result.findLine(lineId) : null;

            if (arrival != null) {
                String title = arrival.arriving || arrival.minutes <= 0
                    ? "Línea " + lineId + " · Llegando"
                    : "Línea " + lineId + " · En " + arrival.minutes + " min";

                update(title, stopName + " → " + destination + "\nActualizado a las " + clock());
                notifyUi(result.status, arrival.minutes, arrival.arriving);

                // Cuando el bus esta encima conviene mirar mas a menudo.
                if (arrival.minutes <= 2) {
                    nextDelay = Math.max(15_000L, intervalMs / 2);
                }
            } else if (result.status == ArrivalsClient.STATUS_EMPTY) {
                update("Línea " + lineId + " · sin paso previsto",
                    stopName + "\nComprobado a las " + clock());
                notifyUi(result.status, -1, false);
            } else {
                update("Línea " + lineId + " · sin conexión",
                    stopName + "\nÚltimo intento a las " + clock());
                notifyUi(result.status, -1, false);
            }
        }

        worker.postDelayed(this::poll, nextDelay);
    }

    private void notifyUi(int status, int minutes, boolean arriving) {
        BusTrackingPlugin plugin = listener;
        if (plugin != null) {
            plugin.emitArrivalUpdate(stopId, lineId, minutes, arriving, status);
        }
    }

    private void update(String title, String body) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) {
            manager.notify(NOTIFICATION_ID, buildNotification(title, body));
        }
    }

    private Notification buildNotification(String title, String body) {
        Intent openIntent = new Intent(this, MainActivity.class);
        openIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);

        PendingIntent contentIntent = PendingIntent.getActivity(
            this, 0, openIntent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        Intent stopIntent = new Intent(this, BusTrackingService.class);
        stopIntent.setAction(ACTION_STOP);
        PendingIntent stopPending = PendingIntent.getService(
            this, 1, stopIntent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        return new Notification.Builder(this, CHANNEL_ID)
            // Icono monocromo con fondo transparente: Android solo usa el alfa.
            .setSmallIcon(R.drawable.ic_stat_salbus)
            .setContentTitle(title)
            .setStyle(new Notification.BigTextStyle().bigText(body))
            .setContentText(body.replace('\n', ' '))
            .setContentIntent(contentIntent)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setCategory(Notification.CATEGORY_TRANSPORT)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .addAction(new Notification.Action.Builder(null, "Detener", stopPending).build())
            .build();
    }

    private void createChannel() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) {
            return;
        }

        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            "Seguimiento de autobús",
            // IMPORTANCE_LOW: se ve y se actualiza, pero no suena en cada refresco.
            NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Aviso persistente con los minutos que faltan para tu autobús.");
        channel.setShowBadge(false);
        channel.enableVibration(false);
        channel.setSound(null, null);
        manager.createNotificationChannel(channel);
    }

    private String clock() {
        return new SimpleDateFormat("HH:mm", new Locale("es", "ES")).format(new Date());
    }

    private static String valueOf(@Nullable String value) {
        return value == null ? "" : value;
    }

    @Override
    public void onDestroy() {
        running = false;
        if (worker != null) {
            worker.removeCallbacksAndMessages(null);
        }
        if (workerThread != null) {
            workerThread.quitSafely();
        }
        super.onDestroy();
    }
}
