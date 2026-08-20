package com.icuas.bussalamanca;

import android.content.Intent;
import android.net.Uri;
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

    /** Ruta de una descarga anterior, para no repetirla al recuperar el permiso. */
    @PluginMethod
    public void pendingUpdate(PluginCall call) {
        File apk = new File(getContext().getCacheDir(), APK_NAME);
        JSObject ret = new JSObject();
        ret.put("ready", apk.exists() && apk.length() > 0);
        ret.put("path", apk.exists() ? apk.getAbsolutePath() : null);
        call.resolve(ret);
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
