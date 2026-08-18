# SALBUS

Aplicación Android (Capacitor + Vite + TypeScript) para consultar los tiempos de
llegada de los autobuses urbanos de Salamanca, seguir un autobús por su recorrido
y medir la puntualidad real de una línea.

## Estructura

```
src/
  main.ts                  Arranque, enrutado, motor de refresco y avisos
  dom.ts                   Repintado incremental (no recrea el DOM en cada tick)
  state.ts                 Estado de la app y persistencia en localStorage
  views.ts                 Las seis pantallas y las hojas inferiores
  ui.ts                    Iconos, formato y componentes compartidos
  style.css                Sistema de diseño (tokens, claro/oscuro)
  services/
    arrivals.ts            Cliente de llegadas con cola y control de ritmo
    arrival-parser.ts      Lectura del panel oficial (sin red: se puede probar)
    punctuality.ts         Detección de pasos reales y desvío frente al horario
    network.ts             Red oficial de líneas, sentidos y paradas
    schedule.ts            Horario programado a partir del GTFS estático
    notifications.ts       Notificaciones locales
public/data/
  network.json             Red oficial generada (27 líneas · 80 sentidos)
  gtfs.zip                 GTFS estático (solo horario teórico)
android/                   Proyecto nativo, servicio en primer plano incluido
tools/                     Generadores y comprobaciones
```

## Fuentes de información

Todo procede de **Salamanca de Transportes**:

| Dato | Origen | Actualización |
| --- | --- | --- |
| Llegadas en tiempo real | `salamancadetransportes.com/tiempos-de-llegada/?ref=<parada>` | En vivo |
| Líneas, sentidos y paradas | `salamancadetransportes.com/informacion-de-lineas/lineas/` | `npm run data:network` |
| Horario programado | `public/data/gtfs.zip` (GTFS estático) | Manual |

La página de líneas incrusta, por cada línea, los atributos
`data-paradas-trayecto-{uno..cuatro}` con la **secuencia ordenada de paradas de
cada sentido** (referencia, nombre y coordenadas). De ahí sale `network.json`,
que cubre las 27 líneas, sus 80 trayectos y las 349 paradas de la red.

> El GTFS incluido declara servicio del 2026-03-16 al 2026-03-31. Está caducado y
> la app lo advierte: solo se usa como horario teórico en la pantalla de
> puntualidad, nunca como tiempo de llegada.

## Ritmo de consultas a la fuente

La web oficial está tras Cloudflare con un limitador por IP. Medido el
2026-08-17 contra `?ref=<parada>`:

- responde **403** si el `User-Agent` no es de navegador;
- admite una ráfaga de **6–8 peticiones** desde reposo y luego devuelve **429**;
- se recupera en **6–10 s**;
- **1 petición cada 2 s se sostiene indefinidamente** sin ningún bloqueo.

Por eso todas las consultas pasan por una cola serializada con 2 s de separación
(`MIN_REQUEST_SPACING_MS`), nunca en paralelo, con caché por parada y espera
progresiva ante un 429. Ese es el mínimo seguro; bajar de ~1,5 s vuelve a
provocar bloqueos.

## Repintado de la interfaz

La pantalla se repinta una vez por segundo para envejecer los minutos y las
antigüedades. Ese repintado es **incremental** (`src/dom.ts`): se compara el HTML
nuevo con el DOM vivo y solo se tocan los nodos que han cambiado. Reescribir todo
con `innerHTML`, como se hacía antes, destruía el elemento sobre el que el
sistema había abierto un desplegable y lo cerraba al instante.

- `data-morph="skip"` marca lo que gestiona otro (el contenedor de Leaflet).
- `data-key` da identidad estable a los elementos de una lista.
- Los campos con el foco nunca se sobrescriben.

`npm run ui:stability` lo comprueba en Chrome: desplegable, tarjetas, foco,
texto escrito y posición del cursor tras varios ciclos de refresco.

## Medición de puntualidad

La fuente oficial no publica «el autobús ha pasado»: solo cuántos minutos faltan.
El paso se deduce en `src/services/punctuality.ts`:

1. **Armado**: el contador baja a 3 minutos o menos y se anota la hora estimada
   de paso (`ahora + minutos`).
2. **Paso por salto**: estando armado el contador sube 3 minutos o más, señal de
   que lo que se ve ya es la expedición siguiente.
3. **Paso por desaparición**: estando armado la línea deja de figurar en dos
   consultas seguidas (o en una si ya se rebasó la hora estimada).

La hora que se guarda es la **estimada con el contador**, no el instante en que
se detecta: con consultas cada 30 s, «ahora» llega tarde.

Cada paso se asocia a la salida programada más cercana **de la franja del control
y del sentido elegido** (±15 min). Los pasos sin salida cercana también se
guardan y se muestran aparte: son la señal más clara de que el horario oficial se
ha quedado atrás.

> La medición necesita la app abierta durante la franja: la fuente no ofrece
> histórico y el servicio en primer plano solo cubre el aviso de próximo bus.

`npm run test:punctuality -- --stop 222 --line 4 --minutes 90` graba la fuente
real con el mismo parser y la misma lógica que la app, y escribe lo observado.

## Funcionamiento en segundo plano

El aviso de «próximo bus» lo mantiene un **servicio en primer plano** nativo
(`BusTrackingService`), no el WebView: Android congela los temporizadores de la
página al pasar a segundo plano. El servicio consulta la parada cada 30 s (15 s
cuando el autobús está a 2 minutos o menos), reescribe la misma notificación en
cada ciclo y envía los datos a la interfaz mediante el plugin `BusTracking` para
que pantalla y notificación digan siempre lo mismo.

El icono pequeño de la notificación (`res/drawable/ic_stat_salbus.xml`) es una
silueta monocroma **sin fondo**: Android descarta el color y usa solo el canal
alfa, así que un icono con fondo se vería como un cuadrado blanco.

## Comandos

```bash
npm install

npm run dev            # navegador (usa el proxy de vite.config.ts)
npm run build          # comprobación de tipos + empaquetado

npm test               # comprobaciones de lógica con fixtures
npm run test:live      # además consulta la fuente oficial
npm run ui:check       # detecta desbordes de maquetación
npm run ui:stability   # el refresco no destruye la interfaz
npm run test:punctuality -- --stop 222 --line 4   # graba la fuente real

npm run data:network   # regenera public/data/network.json
npm run assets:icons   # regenera iconos y splash desde public/favicon.svg

npm run android:sync   # build + cap sync
npm run android:build  # genera el APK de depuración
npm run android:open   # abre Android Studio
```

## Mantenimiento

- **Red de líneas**: `npm run data:network` cuando cambien recorridos o paradas.
- **Horario programado**: sustituir `public/data/gtfs.zip` por un feed vigente.
- **Icono**: editar `public/favicon.svg` y `public/icon-mono.svg`, después
  `npm run assets:icons`.
