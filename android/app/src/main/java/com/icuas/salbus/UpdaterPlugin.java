package com.icuas.salbus;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Descarga e instalacion de una actualizacion publicada como release de GitHub.
 *
 * Las dos cosas son imposibles desde JavaScript:
 *
 *  - DESCARGAR. La WebView tiene origen localhost, asi que cualquier fetch pasa
 *    por CORS, y la URL de descarga de un asset de release redirige a
 *    release-assets.githubusercontent.com, que no manda Access-Control-Allow-Origin.
 *    Ademas, cruzar diez megas por el puente de Capacitor obliga a codificarlos
 *    en base64 (un tercio mas de memoria, y en el hilo principal). Aqui es un
 *    flujo directo a disco, con progreso real y en un hilo aparte.
 *
 *  - INSTALAR. Necesita el permiso REQUEST_INSTALL_PACKAGES, exponer el fichero
 *    como content:// mediante un FileProvider, y un Intent del sistema.
 *
 * Lo que NO puede hacer: instalar en silencio. Eso exige ser device owner o app
 * de sistema. El ultimo paso es siempre un dialogo que la persona confirma.
 *
 * Quien manda sobre "que version tengo instalada" es el PackageManager, no un
 * numero incrustado en el bundle web: ese numero se queda congelado si la
 * WebView sirve una copia vieja de la pagina, y con el la app se ofrecia a si
 * misma la actualizacion que acababa de instalar, una y otra vez.
 */
@CapacitorPlugin(name = "Updater")
public class UpdaterPlugin extends Plugin {

    /** Nombre fijo: una descarga a medias se sobrescribe en el siguiente intento. */
    private static final String APK_NAME = "salbus-update.apk";

    private static final int CONNECT_TIMEOUT_MS = 20_000;
    private static final int READ_TIMEOUT_MS = 60_000;

    /** Con menos de esto entre avisos, el puente se satura sin que se note en pantalla. */
    private static final long PROGRESS_INTERVAL_MS = 250;

    /**
     * En Android 8+ el permiso de «instalar apps desconocidas» se concede por
     * aplicacion, en una pantalla de ajustes del sistema. Nada dentro de la app
     * avisa de que ha cambiado: hay que volver a preguntarlo al recuperar el
     * primer plano.
     */
    @PluginMethod
    public void canInstall(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("granted", getContext().getPackageManager().canRequestPackageInstalls());
        call.resolve(ret);
    }

    /**
     * Version realmente instalada, leida del sistema.
     *
     * Es la unica fuente fiable: sobrevive a un bundle web cacheado y, si una
     * instalacion se queda a medias, sigue diciendo la verdad, con lo que la
     * actualizacion se vuelve a ofrecer en lugar de darse por hecha.
     */
    @PluginMethod
    public void currentVersion(PluginCall call) {
        JSObject ret = new JSObject();

        try {
            PackageInfo info = getContext().getPackageManager()
                .getPackageInfo(getContext().getPackageName(), 0);

            ret.put("versionCode", versionCodeOf(info));
            ret.put("versionName", info.versionName == null ? "" : info.versionName);
        } catch (Exception error) {
            // Imposible en la practica: es su propio paquete. Con 0, la app se
            // ofreceria cualquier release, que es preferible a no ofrecer nada.
            ret.put("versionCode", 0L);
            ret.put("versionName", "");
        }

        call.resolve(ret);
    }

    @PluginMethod
    public void openInstallSettings(PluginCall call) {
        try {
            Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES);
            intent.setData(Uri.parse("package:" + getContext().getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getActivity().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("No se pudo abrir los ajustes de instalación", e);
        }
    }

    /**
     * Descarga anterior que quedo sin instalar, para no repetirla al recuperar
     * el permiso.
     *
     * Dice ademas QUE version es ese archivo, leyendola del propio APK. Sin ese
     * dato, una descarga vieja se daba por buena para cualquier release nueva:
     * se pulsaba "Instalar", se reinstalaba la version anterior y al abrir la
     * app volvia a ofrecerse la misma actualizacion. Un archivo que no se puede
     * leer como APK (una descarga cortada) se borra aqui mismo.
     */
    @PluginMethod
    public void pendingUpdate(PluginCall call) {
        File apk = new File(getContext().getCacheDir(), APK_NAME);
        JSObject ret = new JSObject();

        if (!apk.exists() || apk.length() == 0) {
            ret.put("ready", false);
            ret.put("path", null);
            ret.put("versionCode", 0L);
            ret.put("versionName", "");
            call.resolve(ret);
            return;
        }

        PackageInfo info = getContext().getPackageManager()
            .getPackageArchiveInfo(apk.getAbsolutePath(), 0);

        if (info == null) {
            // Descarga truncada o corrupta: no sirve para nada y ocupa sitio.
            apk.delete();
            ret.put("ready", false);
            ret.put("path", null);
            ret.put("versionCode", 0L);
            ret.put("versionName", "");
            call.resolve(ret);
            return;
        }

        ret.put("ready", true);
        ret.put("path", apk.getAbsolutePath());
        ret.put("versionCode", versionCodeOf(info));
        ret.put("versionName", info.versionName == null ? "" : info.versionName);
        call.resolve(ret);
    }

    /** Tira la descarga guardada: ya no vale para la version que toca ahora. */
    @PluginMethod
    public void clearPending(PluginCall call) {
        File apk = new File(getContext().getCacheDir(), APK_NAME);
        if (apk.exists()) {
            apk.delete();
        }
        call.resolve();
    }

    @SuppressWarnings("deprecation")
    private static long versionCodeOf(PackageInfo info) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            return info.getLongVersionCode();
        }
        return info.versionCode;
    }

    @PluginMethod
    public void download(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("Falta la dirección de descarga");
            return;
        }

        call.setKeepAlive(true);

        new Thread(() -> {
            HttpURLConnection connection = null;
            try {
                File target = new File(getContext().getCacheDir(), APK_NAME);
                connection = open(url);

                int status = connection.getResponseCode();
                if (status != HttpURLConnection.HTTP_OK) {
                    call.reject("La descarga respondió " + status);
                    return;
                }

                long total = connection.getContentLengthLong();
                long written = 0;
                long lastNotifiedAt = 0;

                try (InputStream input = connection.getInputStream();
                     OutputStream output = new FileOutputStream(target)) {
                    byte[] buffer = new byte[64 * 1024];
                    int read;

                    while ((read = input.read(buffer)) != -1) {
                        output.write(buffer, 0, read);
                        written += read;

                        long now = System.currentTimeMillis();
                        if (now - lastNotifiedAt >= PROGRESS_INTERVAL_MS) {
                            lastNotifiedAt = now;
                            notifyProgress(written, total);
                        }
                    }
                }

                notifyProgress(written, total);

                JSObject ret = new JSObject();
                ret.put("path", target.getAbsolutePath());
                ret.put("bytes", written);
                call.resolve(ret);
            } catch (Exception e) {
                // reject de Capacitor acepta Exception, no Throwable.
                call.reject("No se pudo descargar la actualización: " + e.getMessage(), e);
            } finally {
                if (connection != null) {
                    connection.disconnect();
                }
            }
        }).start();
    }

    @PluginMethod
    public void install(PluginCall call) {
        String path = call.getString("path");
        if (path == null || path.isEmpty()) {
            call.reject("Falta la ruta del archivo descargado");
            return;
        }

        File apk = new File(path);
        if (!apk.exists() || apk.length() == 0) {
            call.reject("El archivo descargado ya no está disponible");
            return;
        }

        if (!getContext().getPackageManager().canRequestPackageInstalls()) {
            call.reject("PERMISSION_REQUIRED");
            return;
        }

        try {
            // El FileProvider que declara Capacitor ya cubre getCacheDir()
            // mediante <cache-path> en res/xml/file_paths.xml.
            Uri uri = FileProvider.getUriForFile(
                getContext(),
                getContext().getPackageName() + ".fileprovider",
                apk
            );

            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getActivity().startActivity(intent);

            call.resolve();
        } catch (Exception e) {
            call.reject("No se pudo abrir el instalador: " + e.getMessage(), e);
        }
    }

    private HttpURLConnection open(String url) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
        connection.setReadTimeout(READ_TIMEOUT_MS);
        connection.setInstanceFollowRedirects(true);
        // GitHub sirve el asset desde otro dominio tras un redirect.
        connection.setRequestProperty("Accept", "application/octet-stream");
        connection.setRequestProperty("User-Agent", "SALBUS-Updater");
        return connection;
    }

    private void notifyProgress(long written, long total) {
        JSObject payload = new JSObject();
        payload.put("bytes", written);
        payload.put("total", total);
        // Sin Content-Length no hay porcentaje honesto; se manda -1 y la
        // interfaz enseña una descarga sin cifra en vez de inventarla.
        payload.put("percent", total > 0 ? (int) ((written * 100) / total) : -1);
        notifyListeners("downloadProgress", payload);
    }
}
