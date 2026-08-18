package com.icuas.bussalamanca;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Cliente de llegadas para el servicio en segundo plano.
 *
 * Replica la misma logica que `src/services/arrivals.ts`:
 *  - envia un User-Agent de navegador (sin el, la web oficial responde 403),
 *  - parsea fila a fila para no confundir las filas "LLEGANDO A PARADA",
 *  - distingue "sin servicio" de un error de red.
 */
final class ArrivalsClient {

    static final int STATUS_OK = 0;
    static final int STATUS_EMPTY = 1;
    static final int STATUS_THROTTLED = 2;
    static final int STATUS_ERROR = 3;

    private static final String BASE_URL = "https://salamancadetransportes.com/tiempos-de-llegada/";

    private static final String USER_AGENT =
        "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) "
            + "Chrome/120.0.0.0 Mobile Safari/537.36";

    private static final Pattern LINE_PATTERN =
        Pattern.compile("<b>\\s*L[ií]nea\\s*([^:<]+)\\s*:\\s*</b>", Pattern.CASE_INSENSITIVE);

    private static final Pattern VALUE_PATTERN =
        Pattern.compile("<span[^>]*class=\"right\"[^>]*>(.*?)</span>",
            Pattern.CASE_INSENSITIVE | Pattern.DOTALL);

    private static final Pattern MINUTES_PATTERN =
        Pattern.compile("(\\d+)\\s*minuto", Pattern.CASE_INSENSITIVE);

    private ArrivalsClient() {
    }

    static final class Arrival {
        final String lineId;
        final int minutes;
        final boolean arriving;

        Arrival(String lineId, int minutes, boolean arriving) {
            this.lineId = lineId;
            this.minutes = minutes;
            this.arriving = arriving;
        }
    }

    static final class Result {
        final int status;
        final List<Arrival> arrivals = new ArrayList<>();

        Result(int status) {
            this.status = status;
        }

        Arrival findLine(String lineId) {
            Arrival best = null;
            for (Arrival arrival : arrivals) {
                if (!arrival.lineId.equals(lineId)) {
                    continue;
                }
                if (best == null || arrival.minutes < best.minutes) {
                    best = arrival;
                }
            }
            return best;
        }
    }

    static Result fetch(String stopId) {
        HttpURLConnection connection = null;

        try {
            String url = BASE_URL + "?ref=" + URLEncoder.encode(stopId, "UTF-8");
            connection = (HttpURLConnection) new URL(url).openConnection();
            connection.setRequestProperty("User-Agent", USER_AGENT);
            connection.setRequestProperty("Accept", "text/html,application/xhtml+xml");
            connection.setRequestProperty("Accept-Language", "es-ES,es;q=0.9");
            connection.setConnectTimeout(12000);
            connection.setReadTimeout(12000);

            int code = connection.getResponseCode();

            if (code == 429) {
                return new Result(STATUS_THROTTLED);
            }

            if (code != 200) {
                return new Result(STATUS_ERROR);
            }

            StringBuilder body = new StringBuilder();
            try (BufferedReader reader =
                     new BufferedReader(new InputStreamReader(connection.getInputStream(), "UTF-8"))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    body.append(line).append('\n');
                }
            }

            return parse(body.toString());
        } catch (Exception error) {
            return new Result(STATUS_ERROR);
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    static Result parse(String html) {
        int blockStart = html.indexOf("id=\"arrival_times_results\"");
        if (blockStart < 0) {
            return new Result(STATUS_ERROR);
        }

        String block = html.substring(blockStart, Math.min(html.length(), blockStart + 20000));

        if (block.contains("No hay datos actuales de l")) {
            return new Result(STATUS_EMPTY);
        }

        Result result = new Result(STATUS_OK);

        // Se trocea por filas: cada fila se parsea de forma independiente para que
        // una fila sin minutos no se empareje con el tiempo de la siguiente.
        String[] rows = block.split("<div\\s+class=\"arrival_times_results_row\">");

        for (int index = 1; index < rows.length; index += 1) {
            String row = rows[index];
            int end = row.indexOf("</div></div>");
            if (end >= 0) {
                row = row.substring(0, end + 12);
            }

            Matcher lineMatcher = LINE_PATTERN.matcher(row);
            Matcher valueMatcher = VALUE_PATTERN.matcher(row);

            if (!lineMatcher.find() || !valueMatcher.find()) {
                continue;
            }

            String lineId = lineMatcher.group(1).trim();
            String raw = valueMatcher.group(1).replaceAll("<[^>]+>", " ").replaceAll("\\s+", " ").trim();

            if (raw.toLowerCase().contains("llegando") || raw.toLowerCase().contains("en parada")) {
                result.arrivals.add(new Arrival(lineId, 0, true));
                continue;
            }

            Matcher minutesMatcher = MINUTES_PATTERN.matcher(raw);
            if (minutesMatcher.find()) {
                try {
                    result.arrivals.add(
                        new Arrival(lineId, Integer.parseInt(minutesMatcher.group(1)), false));
                } catch (NumberFormatException ignored) {
                    // Fila con formato inesperado: se descarta sin romper el resto.
                }
            }
        }

        if (result.arrivals.isEmpty()) {
            return new Result(STATUS_EMPTY);
        }

        return result;
    }
}
