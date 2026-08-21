package com.icuas.bussalamanca;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;

import androidx.annotation.Nullable;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Servicio en primer plano que mantiene vivos los avisos de "proximo bus".
 *
 * Es la unica forma fiable de seguir actualizando en Android cuando la app pasa a
 * segundo plano: los temporizadores del WebView se congelan, pero un servicio en
 * primer plano con notificacion persistente sigue ejecutandose.
 *
 * Desde la v4.4 puede llevar mas de un aviso a la vez (hasta {@link #MAX_JOBS}).
 * Cada uno tiene su propia notificacion y su propia cuenta de autobuses, y se
 * consultan en serie dentro de cada ciclo para no disparar dos peticiones
 * simultaneas contra una fuente que limita por IP.
 *
 * El seguimiento de un aviso no termina con el primer autobus: cuenta los pasos
 * reales de la linea y sigue avisando del siguiente hasta completar
 * {@link #targetBuses}, salvo que se detenga a mano antes.
 */
public class BusTrackingService extends Service {

    /** Sustituye la lista de avisos vivos por la que llega en el intent. */
    public static final String ACTION_SYNC = "com.icuas.bussalamanca.TRACKING_SYNC";

    /** Detiene el servicio entero (lo pide la app, no la persona usuaria). */
    public static final String ACTION_STOP = "com.icuas.bussalamanca.TRACKING_STOP";

    /** Detiene UN aviso desde el boton de su notificacion. */
    public static final String ACTION_STOP_JOB = "com.icuas.bussalamanca.TRACKING_STOP_JOB";

    public static final String EXTRA_JOBS = "jobs";
    public static final String EXTRA_JOB_ID = "jobId";
    public static final String EXTRA_INTERVAL = "intervalSeconds";
    public static final String EXTRA_VIBRATE = "vibrateOnApproach";
    public static final String EXTRA_TARGET = "busTarget";

    /**
     * Separador de campos de cada aviso dentro del intent.
     *
     * NO puede ser "|": el id de un aviso ya ES `stopId|lineId`, asi que un "|"
     * como separador partia el id en dos y corria TODOS los campos un puesto. La
     * parada que se consultaba pasaba a ser el id de la linea, y la linea que se
     * buscaba, el nombre de la parada: el aviso no encontraba nunca su autobus y
     * repetia "sin paso previsto" en cada ciclo.
     */
    public static final String FIELD_SEPARATOR = "\u001F";

    private static final String CHANNEL_ID = "salbus-seguimiento";

    /**
     * Ids de notificacion, uno por ranura de aviso. Cada aviso reescribe siempre
     * el mismo id: dos ids serian dos notificaciones, y la que se deja de
     * escribir se queda congelada en la barra.
     */
    private static final int NOTIFICATION_ID_BASE = 4201;

    /** Aviso final, ya no persistente, cuando se completa un seguimiento. */
    private static final int SUMMARY_NOTIFICATION_ID = 4210;

    /** Avisos simultaneos que admite el servicio. */
    public static final int MAX_JOBS = 2;

    /** Tope de autobuses por aviso; el numero real lo elige la app. */
    public static final int MAX_TARGET_BUSES = 3;

    /** Ciclos seguidos sin ver la linea, tras haberla tenido encima, para darla por pasada. */
    private static final int MISSING_STREAK_TO_PASS = 2;

    /** Minutos restantes a partir de los cuales se avisa con una vibracion corta. */
    private static final int VIBRATION_THRESHOLD_MINUTES = 3;

    /** Espera tras un 429, duplicandose hasta el maximo. */
    private static final long BACKOFF_BASE_MS = 15_000L;
    private static final long BACKOFF_MAX_MS = 120_000L;

    /** Separacion entre las consultas de dos avisos dentro del mismo ciclo. */
    private static final long JOB_SPACING_MS = 2_000L;

    /**
     * Avisos detenidos a mano desde la notificacion.
     *
     * Se guardan en disco porque la app puede estar cerrada cuando ocurre: sin
     * esto, al volver a abrirla veria su aviso guardado, no encontraria el
     * servicio vivo y lo revivria, resucitando una notificacion que la persona
     * usuaria acababa de quitar.
     */
    private static final String PREFS = "salbus.tracking";
    private static final String PREF_STOPPED = "stoppedJobIds";

    private static volatile boolean running = false;

    /** La instancia del plugin recibe las actualizaciones para reflejarlas en la UI. */
    @Nullable
    private static volatile BusTrackingPlugin listener = null;

    private HandlerThread workerThread;
    private Handler worker;

    private final List<Job> jobs = new ArrayList<>();
    private long intervalMs = 15_000L;
    private long backoffMs = BACKOFF_BASE_MS;
    private boolean vibrateOnApproach = true;

    /**
     * Autobuses que ve pasar cada aviso antes de cerrarse.
     *
     * Es un ajuste de la app, no una constante: quien pone un aviso casi siempre
     * espera EL proximo autobus, y encadenar tres dejaba la notificacion viva
     * mucho despues de haberse subido al primero.
     */
    private int targetBuses = 1;

    /** Un aviso: una parada, una linea y todo lo que hay que recordar de ella. */
    private static final class Job {
        final String id;
        final String stopId;
        final String stopName;
        final String lineId;
        final String destination;

        /** Deteccion de pasos: se arma cuando el bus esta encima y se cierra al alejarse. */
        boolean armed = false;
        int lastMinutes = -1;
        int missingStreak = 0;
        int busesSeen = 0;
        /** La vibracion de los 3 minutos ya se ha dado para el autobus en curso. */
        boolean warnedAt3 = false;
        /** La ultima consulta de este aviso se topo con el limite de la fuente. */
        boolean throttled = false;

        Job(String id, String stopId, String stopName, String lineId, String destination) {
            this.id = id;
            this.stopId = stopId;
            this.stopName = stopName;
            this.lineId = lineId;
            this.destination = destination;
        }
    }

    public static boolean isRunning() {
        return running;
    }

    public static void setListener(@Nullable BusTrackingPlugin plugin) {
        listener = plugin;
    }

    /** Ids de los avisos que la persona usuaria detuvo desde la notificacion. */
    static Set<String> readStoppedIds(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        return new LinkedHashSet<>(prefs.getStringSet(PREF_STOPPED, new LinkedHashSet<String>()));
    }

    static void clearStoppedIds(Context context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .remove(PREF_STOPPED)
            .apply();
    }

    private void rememberStopped(String jobId) {
        Set<String> stored = readStoppedIds(this);
        stored.add(jobId);
        getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putStringSet(PREF_STOPPED, stored)
            .apply();
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
            stopEverything();
            return START_NOT_STICKY;
        }

        if (ACTION_STOP_JOB.equals(intent.getAction())) {
            stopJob(valueOf(intent.getStringExtra(EXTRA_JOB_ID)));
            return START_REDELIVER_INTENT;
        }

        // "id|stopId|stopName|lineId|destination|busesSeen" por aviso: el intent
        // solo admite tipos simples y una cadena por aviso evita arrastrar JSON.
        String[] incoming = intent.getStringArrayExtra(EXTRA_JOBS);
        if (incoming == null || incoming.length == 0) {
            stopEverything();
            return START_NOT_STICKY;
        }

        int seconds = intent.getIntExtra(EXTRA_INTERVAL, 15);
        // Nunca por debajo de 15 s: cuatro actualizaciones por minuto es el ritmo
        // objetivo y tambien el suelo que protege a la fuente oficial.
        intervalMs = Math.max(15, seconds) * 1000L;
        vibrateOnApproach = intent.getBooleanExtra(EXTRA_VIBRATE, true);
        targetBuses = Math.min(MAX_TARGET_BUSES, Math.max(1, intent.getIntExtra(EXTRA_TARGET, 1)));

        applyJobs(incoming);

        if (jobs.isEmpty()) {
            stopEverything();
            return START_NOT_STICKY;
        }

        Job first = jobs.get(0);
        startInForeground(buildNotification(first,
            "Buscando tu autobús…",
            "Línea " + first.lineId + " · " + first.stopName));
        running = true;

        worker.removeCallbacksAndMessages(null);
        worker.post(this::poll);

        // START_REDELIVER_INTENT: si el sistema mata el servicio, lo recrea con los
        // mismos datos de seguimiento.
        return START_REDELIVER_INTENT;
    }

    /**
     * Sustituye la lista de avisos conservando el estado (autobuses contados,
     * deteccion en curso) de los que ya estaban: reactivar la app o cambiar el
     * otro aviso no puede reiniciar la cuenta de este.
     */
    private void applyJobs(String[] incoming) {
        List<Job> next = new ArrayList<>();

        for (String raw : incoming) {
            if (next.size() >= MAX_JOBS) {
                break;
            }

            String[] parts = raw.split(Pattern.quote(FIELD_SEPARATOR), 6);
            if (parts.length < 5) {
                continue;
            }

            Job job = new Job(parts[0], parts[1], parts[2], parts[3], parts[4]);
            Job previous = findJob(parts[0]);

            if (previous != null) {
                job.armed = previous.armed;
                job.lastMinutes = previous.lastMinutes;
                job.missingStreak = previous.missingStreak;
                job.busesSeen = previous.busesSeen;
                job.warnedAt3 = previous.warnedAt3;
            } else {
                // Se acota al ultimo autobus pendiente: crear el aviso significa
                // que aun queda alguno por ver, y con la cuenta ya completa nunca
                // llegaria a terminar.
                job.busesSeen = Math.min(targetBuses - 1, Math.max(0, parseInt(parts, 5)));
            }

            next.add(job);
        }

        jobs.clear();
        jobs.addAll(next);
        cancelSpareNotifications();
    }

    private static int parseInt(String[] parts, int index) {
        if (parts.length <= index) {
            return 0;
        }
        try {
            return Integer.parseInt(parts[index]);
        } catch (NumberFormatException error) {
            return 0;
        }
    }

    @Nullable
    private Job findJob(String id) {
        for (Job job : jobs) {
            if (job.id.equals(id)) {
                return job;
            }
        }
        return null;
    }

    /** Ranuras de notificacion que ya no usa ningun aviso. */
    private void cancelSpareNotifications() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) {
            return;
        }
        for (int slot = jobs.size(); slot < MAX_JOBS; slot += 1) {
            manager.cancel(NOTIFICATION_ID_BASE + slot);
        }
    }

    private void startInForeground(Notification notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_ID_BASE, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(NOTIFICATION_ID_BASE, notification);
        }
    }

    /** Detiene un aviso a peticion de la persona usuaria y lo deja anotado. */
    private void stopJob(String jobId) {
        Job job = findJob(jobId);
        if (job == null) {
            return;
        }

        rememberStopped(jobId);
        jobs.remove(job);
        cancelSpareNotifications();
        notifyJobStopped(jobId);

        if (jobs.isEmpty()) {
            stopEverything();
            return;
        }

        // El aviso que queda pasa a la ranura 0, que es la que sostiene el
        // servicio en primer plano.
        Job first = jobs.get(0);
        startInForeground(buildNotification(first,
            "Línea " + first.lineId + " · actualizando…",
            first.stopName + "\n" + progress(first)));
    }

    private void stopEverything() {
        running = false;
        if (worker != null) {
            worker.removeCallbacksAndMessages(null);
        }
        jobs.clear();
        stopSelf();
    }

    private void poll() {
        if (!running) {
            return;
        }

        long nextDelay = intervalMs;

        for (int index = 0; index < jobs.size(); index += 1) {
            if (!running) {
                return;
            }

            if (index > 0) {
                sleep(JOB_SPACING_MS);
            }

            Job job = jobs.get(index);

            if (pollJob(job, index)) {
                // El aviso ha terminado y se ha retirado de la lista: se repite
                // este indice, que ahora ocupa el siguiente.
                index -= 1;
                continue;
            }

            if (job.throttled) {
                nextDelay = Math.max(nextDelay, backoffMs);
            }
        }

        if (jobs.isEmpty()) {
            stopEverything();
            return;
        }

        worker.postDelayed(this::poll, nextDelay);
    }

    /**
     * Un ciclo de un aviso.
     *
     * @return true si el aviso ha completado su objetivo y ya no esta en la lista.
     */
    private boolean pollJob(Job job, int slot) {
        ArrivalsClient.Result result = ArrivalsClient.fetch(job.stopId);
        job.throttled = result.status == ArrivalsClient.STATUS_THROTTLED;

        if (job.throttled) {
            // La fuente esta limitando: se espera mas y se mantiene el ultimo texto.
            backoffMs = Math.min(BACKOFF_MAX_MS, backoffMs * 2);
            notifyUi(job, result.status, -1, false);
            return false;
        }

        backoffMs = BACKOFF_BASE_MS;

        ArrivalsClient.Arrival arrival =
            result.status == ArrivalsClient.STATUS_OK ? result.findLine(job.lineId) : null;

        if (arrival != null) {
            int minutes = arrival.arriving ? 0 : arrival.minutes;
            job.missingStreak = 0;

            if (minutes <= 3) {
                job.armed = true;
            }

            // Se alejo tras haber estado encima: ese autobus ya ha pasado y el
            // tiempo que se ve ahora es el del siguiente.
            if (job.armed && job.lastMinutes >= 0 && job.lastMinutes <= 2 && minutes >= 6) {
                return registerBusPassed(job, slot);
            }

            // Vibracion corta al entrar en los 3 minutos, una sola vez por
            // autobus: repetirla en cada consulta seria un zumbido cada 15 s.
            if (vibrateOnApproach && !job.warnedAt3 && minutes <= VIBRATION_THRESHOLD_MINUTES) {
                job.warnedAt3 = true;
                vibrateShort();
            }

            job.lastMinutes = minutes;

            String title = minutes <= 0
                ? "Línea " + job.lineId + " · Llegando"
                : "Línea " + job.lineId + " · En " + minutes + " min";

            update(job, slot, title, job.stopName + " → " + job.destination
                + "\n" + progress(job) + " · actualizado a las " + clock());
            notifyUi(job, result.status, minutes, arrival.arriving);
            return false;
        }

        if (result.status == ArrivalsClient.STATUS_EMPTY || result.status == ArrivalsClient.STATUS_OK) {
            // La linea deja de aparecer justo despues de pasar: es la otra forma
            // de detectar el paso, ademas del salto de minutos.
            job.missingStreak += 1;

            if (job.armed && job.missingStreak >= MISSING_STREAK_TO_PASS) {
                return registerBusPassed(job, slot);
            }

            update(job, slot, "Línea " + job.lineId + " · sin paso previsto",
                job.stopName + "\n" + progress(job) + " · comprobado a las " + clock());
            notifyUi(job, result.status, -1, false);
            return false;
        }

        // Un error de red no dice nada del autobus: no cuenta como ausencia.
        update(job, slot, "Línea " + job.lineId + " · sin conexión",
            job.stopName + "\n" + progress(job) + " · último intento a las " + clock());
        notifyUi(job, result.status, -1, false);
        return false;
    }

    /**
     * Da por pasado un autobus y prepara el siguiente.
     *
     * @return true si con este ya se han visto los {@link #targetBuses} y el
     *     aviso se ha retirado de la lista.
     */
    private boolean registerBusPassed(Job job, int slot) {
        job.busesSeen += 1;
        job.armed = false;
        job.lastMinutes = -1;
        job.missingStreak = 0;
        job.warnedAt3 = false;

        if (job.busesSeen >= targetBuses) {
            finish(job, slot);
            return true;
        }

        notifyPassed(job);
        return false;
    }

    /** Aviso final y retirada del seguimiento: ha cumplido su objetivo. */
    private void finish(Job job, int slot) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) {
            Notification summary = new Notification.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_salbus)
                .setContentTitle("Línea " + job.lineId + " · aviso completado")
                .setContentText(targetBuses > 1
                    ? "Han pasado " + targetBuses + " autobuses por " + job.stopName + "."
                    : "Tu autobús ha pasado por " + job.stopName + ".")
                .setContentIntent(openAppIntent())
                .setAutoCancel(true)
                .setCategory(Notification.CATEGORY_TRANSPORT)
                .build();
            manager.notify(SUMMARY_NOTIFICATION_ID + slot, summary);
        }

        jobs.remove(job);
        cancelSpareNotifications();
        // La UI lo lee de `finished` para cerrar el aviso en pantalla.
        notifyUi(job, ArrivalsClient.STATUS_OK, -1, false, true);
    }

    /** Con un solo autobus por aviso el contador no dice nada: se calla. */
    private String progress(Job job) {
        if (targetBuses <= 1) {
            return job.destination;
        }
        return "Autobús " + Math.min(job.busesSeen + 1, targetBuses) + " de " + targetBuses;
    }

    /** Vibracion corta: solo un toque, para que se note sin llegar a molestar. */
    private void vibrateShort() {
        Vibrator vibrator = resolveVibrator();
        if (vibrator == null || !vibrator.hasVibrator()) {
            return;
        }

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                vibrator.vibrate(VibrationEffect.createOneShot(220, VibrationEffect.DEFAULT_AMPLITUDE));
            } else {
                vibrator.vibrate(220);
            }
        } catch (Exception ignored) {
            /* algunos fabricantes lo bloquean en modo de ahorro */
        }
    }

    @Nullable
    private Vibrator resolveVibrator() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            VibratorManager manager = getSystemService(VibratorManager.class);
            return manager == null ? null : manager.getDefaultVibrator();
        }
        return getSystemService(Vibrator.class);
    }

    private void notifyUi(Job job, int status, int minutes, boolean arriving) {
        notifyUi(job, status, minutes, arriving, false);
    }

    private void notifyUi(Job job, int status, int minutes, boolean arriving, boolean finished) {
        BusTrackingPlugin plugin = listener;
        if (plugin != null) {
            plugin.emitArrivalUpdate(
                job.id, job.stopId, job.lineId, minutes, arriving, status, job.busesSeen, finished);
        }
    }

    private void notifyPassed(Job job) {
        BusTrackingPlugin plugin = listener;
        if (plugin != null) {
            plugin.emitBusPassed(job.id, job.stopId, job.lineId, job.busesSeen, targetBuses);
        }
    }

    private void notifyJobStopped(String jobId) {
        BusTrackingPlugin plugin = listener;
        if (plugin != null) {
            plugin.emitJobStopped(jobId);
        }
    }

    private void update(Job job, int slot, String title, String body) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) {
            manager.notify(NOTIFICATION_ID_BASE + slot, buildNotification(job, title, body));
        }
    }

    private PendingIntent openAppIntent() {
        Intent openIntent = new Intent(this, MainActivity.class);
        openIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);

        return PendingIntent.getActivity(
            this, 0, openIntent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private Notification buildNotification(Job job, String title, String body) {
        PendingIntent contentIntent = openAppIntent();

        Intent stopIntent = new Intent(this, BusTrackingService.class);
        stopIntent.setAction(ACTION_STOP_JOB);
        stopIntent.putExtra(EXTRA_JOB_ID, job.id);
        // Un requestCode por aviso: con el mismo, el segundo PendingIntent
        // reutilizaria los extras del primero y el boton pararia el aviso ajeno.
        PendingIntent stopPending = PendingIntent.getService(
            this,
            1 + Math.abs(job.id.hashCode() % 1000),
            stopIntent,
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

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

    private static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
        }
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
