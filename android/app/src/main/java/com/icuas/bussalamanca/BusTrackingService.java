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
 * Consulta una sola parada cada `intervalSeconds` (15 s por defecto: cuatro
 * actualizaciones por minuto) y reescribe SIEMPRE la misma notificacion, de modo
 * que el tiempo mostrado es el actual y nunca queda un aviso secundario congelado.
 *
 * El seguimiento no termina con el primer autobus: cuenta los pasos reales de la
 * linea y sigue avisando del siguiente hasta completar {@link #TARGET_BUSES},
 * salvo que se detenga a mano antes.
 */
public class BusTrackingService extends Service {

    public static final String ACTION_START = "com.icuas.bussalamanca.TRACKING_START";
    public static final String ACTION_STOP = "com.icuas.bussalamanca.TRACKING_STOP";

    public static final String EXTRA_STOP_ID = "stopId";
    public static final String EXTRA_STOP_NAME = "stopName";
    public static final String EXTRA_LINE_ID = "lineId";
    public static final String EXTRA_DESTINATION = "destination";
    public static final String EXTRA_INTERVAL = "intervalSeconds";

    public static final String EXTRA_BUSES_SEEN = "busesSeen";

    private static final String CHANNEL_ID = "salbus-seguimiento";

    /**
     * Id unico del aviso de seguimiento: todo el ciclo de vida reescribe este mismo
     * id. Dos ids serian dos notificaciones, y la que se deja de escribir se queda
     * congelada en la barra.
     */
    private static final int NOTIFICATION_ID = 4201;

    /** Aviso final, ya no persistente, cuando se completa el seguimiento. */
    private static final int SUMMARY_NOTIFICATION_ID = 4202;

    /** Autobuses que hay que ver pasar antes de dar por terminado el aviso. */
    private static final int TARGET_BUSES = 3;

    /** Ciclos seguidos sin ver la linea, tras haberla tenido encima, para darla por pasada. */
    private static final int MISSING_STREAK_TO_PASS = 2;

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
    private long intervalMs = 15_000L;
    private long backoffMs = BACKOFF_BASE_MS;

    /** Deteccion de pasos: se arma cuando el bus esta encima y se cierra al alejarse. */
    private boolean armed = false;
    private int lastMinutes = -1;
    private int missingStreak = 0;
    private int busesSeen = 0;

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

        String nextStopId = valueOf(intent.getStringExtra(EXTRA_STOP_ID));
        String nextLineId = valueOf(intent.getStringExtra(EXTRA_LINE_ID));

        // Reanudar el mismo seguimiento (la app vuelve a llamar a start, o el sistema
        // recrea el servicio) no puede borrar los autobuses ya contados.
        boolean sameJob = running && nextStopId.equals(stopId) && nextLineId.equals(lineId);

        stopId = nextStopId;
        lineId = nextLineId;
        stopName = valueOf(intent.getStringExtra(EXTRA_STOP_NAME));
        destination = valueOf(intent.getStringExtra(EXTRA_DESTINATION));

        if (!sameJob) {
            armed = false;
            lastMinutes = -1;
            missingStreak = 0;
            // Se acota al ultimo autobus pendiente: arrancar el servicio significa
            // que aun queda alguno por ver, y con la cuenta ya completa nunca
            // llegaria a terminar.
            busesSeen = Math.min(TARGET_BUSES - 1,
                Math.max(0, intent.getIntExtra(EXTRA_BUSES_SEEN, 0)));
        }

        int seconds = intent.getIntExtra(EXTRA_INTERVAL, 15);
        // Nunca por debajo de 15 s: cuatro actualizaciones por minuto es el ritmo
        // objetivo y tambien el suelo que protege a la fuente oficial.
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
                int minutes = arrival.arriving ? 0 : arrival.minutes;
                missingStreak = 0;

                if (minutes <= 3) {
                    armed = true;
                }

                // Se alejo tras haber estado encima: ese autobus ya ha pasado y el
                // tiempo que se ve ahora es el del siguiente.
                if (armed && lastMinutes >= 0 && lastMinutes <= 2 && minutes >= 6) {
                    if (registerBusPassed()) {
                        return;
                    }
                }

                lastMinutes = minutes;

                String title = minutes <= 0
                    ? "Línea " + lineId + " · Llegando"
                    : "Línea " + lineId + " · En " + minutes + " min";

                update(title, stopName + " → " + destination
                    + "\n" + progress() + " · actualizado a las " + clock());
                notifyUi(result.status, minutes, arrival.arriving);
            } else if (result.status == ArrivalsClient.STATUS_EMPTY
                || result.status == ArrivalsClient.STATUS_OK) {
                // La linea deja de aparecer justo despues de pasar: es la otra forma
                // de detectar el paso, ademas del salto de minutos.
                missingStreak += 1;

                if (armed && missingStreak >= MISSING_STREAK_TO_PASS) {
                    if (registerBusPassed()) {
                        return;
                    }
                }

                update("Línea " + lineId + " · sin paso previsto",
                    stopName + "\n" + progress() + " · comprobado a las " + clock());
                notifyUi(result.status, -1, false);
            } else {
                // Un error de red no dice nada del autobus: no cuenta como ausencia.
                update("Línea " + lineId + " · sin conexión",
                    stopName + "\n" + progress() + " · último intento a las " + clock());
                notifyUi(result.status, -1, false);
            }
        }

        worker.postDelayed(this::poll, nextDelay);
    }

    /**
     * Da por pasado un autobus y prepara el siguiente.
     *
     * @return true si con este ya se han visto los {@link #TARGET_BUSES} y el
     *     servicio se esta deteniendo, por lo que el ciclo debe cortar aqui.
     */
    private boolean registerBusPassed() {
        busesSeen += 1;
        armed = false;
        lastMinutes = -1;
        missingStreak = 0;

        if (busesSeen >= TARGET_BUSES) {
            finish();
            return true;
        }

        notifyPassed();
        return false;
    }

    /** Aviso final y parada del servicio: el seguimiento ha cumplido su objetivo. */
    private void finish() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) {
            Notification summary = new Notification.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_salbus)
                .setContentTitle("Línea " + lineId + " · aviso completado")
                .setContentText("Han pasado " + TARGET_BUSES + " autobuses por " + stopName + ".")
                .setContentIntent(openAppIntent())
                .setAutoCancel(true)
                .setCategory(Notification.CATEGORY_TRANSPORT)
                .build();
            manager.notify(SUMMARY_NOTIFICATION_ID, summary);
        }

        // running = false antes de avisar: la UI lee de ahi que el aviso ha acabado.
        running = false;
        notifyUi(ArrivalsClient.STATUS_OK, -1, false);
        stopSelf();
    }

    private String progress() {
        return "Autobús " + Math.min(busesSeen + 1, TARGET_BUSES) + " de " + TARGET_BUSES;
    }

    private void notifyUi(int status, int minutes, boolean arriving) {
        BusTrackingPlugin plugin = listener;
        if (plugin != null) {
            plugin.emitArrivalUpdate(stopId, lineId, minutes, arriving, status, busesSeen, !running);
        }
    }

    private void notifyPassed() {
        BusTrackingPlugin plugin = listener;
        if (plugin != null) {
            plugin.emitBusPassed(stopId, lineId, busesSeen, TARGET_BUSES);
        }
    }

    private void update(String title, String body) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) {
            manager.notify(NOTIFICATION_ID, buildNotification(title, body));
        }
    }

    private PendingIntent openAppIntent() {
        Intent openIntent = new Intent(this, MainActivity.class);
        openIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);

        return PendingIntent.getActivity(
            this, 0, openIntent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private Notification buildNotification(String title, String body) {
        PendingIntent contentIntent = openAppIntent();

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

    /** Con segundos: a cuatro refrescos por minuto, la hora sola no cambiaria. */
    private String clock() {
        return new SimpleDateFormat("HH:mm:ss", new Locale("es", "ES")).format(new Date());
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
