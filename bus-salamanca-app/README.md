# Bus Salamanca

Aplicacion base para Android construida con Vite + TypeScript + Capacitor. La app carga el GTFS local desde `public/data/gtfs.zip`, organiza la interfaz por pestañas y muestra proximas salidas segun el horario estatico. La capa de tiempo real queda desacoplada mediante `VITE_REALTIME_URL`.

## Funcionalidad actual

- Pestaña `Informacion de autobuses` con buscador, selector de paradas, boton de actualizacion y registro de parada en el hub.
- Pestaña `Hub personal` con tarjetas para paradas favoritas y refresco automatico configurable entre 10 y 60 segundos.
- Persistencia local de paradas guardadas y frecuencia de actualizacion mediante `localStorage`.

## Estado actual

- El feed GTFS disponible es estatico: incluye `routes`, `stops`, `trips`, `stop_times`, `shapes` y `calendar_dates`.
- No hay GTFS-RT dentro del ZIP, por lo que el tiempo real necesita un backend o API adicional.
- La app ya queda preparada para compilar a Android con Capacitor.

## Requisitos

- Node.js 20 o superior.
- Android Studio y Android SDK para abrir y compilar la app nativa.

## Comandos principales

```bash
npm install
npm run dev
npm run cap:android
npm run android:open
```

## Flujo recomendado

1. Arranca la interfaz en web con `npm run dev`.
2. Cuando la UI este correcta, genera la version nativa con `npm run cap:android`.
3. Abre Android Studio con `npm run android:open`.
4. Compila o ejecuta desde Android Studio en un emulador o dispositivo.

## Tiempo real

La app ya puede trabajar con un proxy local GTFS-RT. Crea un archivo `.env` con estas variables:

```bash
VITE_REALTIME_URL=http://localhost:8787
REALTIME_PORT=8787
GTFS_STATIC_ZIP_PATH=public/data/gtfs.zip
GTFS_RT_TRIP_UPDATES_URL=
GTFS_RT_VEHICLE_POSITIONS_URL=
GTFS_RT_AUTH_HEADER=
GTFS_RT_AUTH_TOKEN=
GTFS_RT_REFRESH_MS=15000
REALTIME_WEB_FALLBACK_ENABLED=true
REALTIME_WEB_BASE_URL=https://salamancadetransportes.com/tiempos-de-llegada/
REALTIME_WEB_CACHE_MS=10000
REALTIME_STATIC_SCHEDULE_FALLBACK_ENABLED=false
```

Si no configuras `GTFS_RT_TRIP_UPDATES_URL` y `GTFS_RT_VEHICLE_POSITIONS_URL`, el proxy entra automaticamente en modo fallback web por parada y consulta `?ref=<stopId>` en la URL base indicada.

Mientras pruebas este metodo, `REALTIME_STATIC_SCHEDULE_FALLBACK_ENABLED=false` evita mezclar llegadas del GTFS estatico con las llegadas extraidas de la web. Solo si lo cambias a `true` volvera a usar el horario estatico como respaldo.

Luego arranca el proxy con:

```bash
npm run server:realtime
```

El proxy expone estos endpoints:

- `GET /status`
- `GET /stops/:stopId/arrivals?limit=8`
- `GET /hub/arrivals?stopIds=1,2,3&limit=5`

La app intentara leer `GET /status` en esa URL y espera un JSON con esta forma:

```json
{
  "providerName": "gtfs-rt-proxy",
  "connected": true,
  "vehicleCount": 24,
  "updatedAt": "2026-03-16T18:45:00Z",
  "statusMessage": "Datos de vehiculos actualizados cada 15 segundos"
}
```

## Siguiente iteracion tecnica

1. Convertir el GTFS a SQLite o indexarlo en backend para evitar parsing completo en el movil.
2. Añadir mapa con Leaflet o Google Maps y representar `shapes` y posiciones de vehiculos.
3. Incorporar estimaciones por parada si dispones de GTFS-RT `trip_updates`.

## Que falta por tu parte

Opcional: si consigues acceso oficial GTFS-RT, rellena la URL y credenciales para usar ese origen preferente. Mientras tanto, el fallback web ya permite mostrar tiempos de llegada reales por parada.