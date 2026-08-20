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

Consecuencia visible: en una lista larga los tiempos **no son de un mismo
instante**. Cada parada de «Ver por dónde viene» lleva a su derecha un punto con
la fase en la que está (`syncState` en `src/ui.ts`), y la tarjeta incluye la
leyenda de colores:

| Color | Significado |
| --- | --- |
| Azul, parpadeando | Se está consultando ahora |
| Aro ámbar | En cola, esperando turno |
| Verde | Dato de hace menos de un minuto |
| Gris | Dato más antiguo |
| Ámbar sólido | La fuente limitó la consulta (429) |
| Rojo | Sin conexión con la fuente |

El estado por parada vive en `state.stopSync`; lo alimentan `onStart`/`onFeed` de
`fetchStopsSequentially`.

## Buscar por mapa

Al elegir línea y sentido el mapa pasa a **pantalla completa**, y se vuelve al
buscador con la ✕ de la esquina superior derecha. El contenedor `#stop-map` no
cambia de sitio en el árbol al ampliarse: solo cambia cómo se coloca (`.map-shell.is-expanded`),
porque moverlo obligaría a reconstruir Leaflet en cada apertura. Tras el cambio
de tamaño hay que llamar a `invalidateSize()` **antes** de `fitBounds()`: si no,
el encuadre se calcula con el tamaño anterior y el recorrido sale diminuto.

Las paradas se dibujan con chinchetas (`L.divIcon`) del color de la línea y su
número de orden en el recorrido. Como una línea entera solo cabe en pantalla muy
alejado, y ahí treinta chinchetas se solapan, el tamaño se escala con el zoom
(`applyZoomScale`: clases `is-far` e `is-mid` sobre el contenedor). Al pulsar una
parada se abre un globo con su nombre, su código y las líneas que pasan por ella;
los tiempos no van en el globo, porque abrirían una consulta por cada parada que
se tocara.

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

## Actualización automática

Un `git push` a `main` acaba convertido en una actualización instalada en el
móvil. El workflow `.github/workflows/release.yml` compila y **firma** la APK,
la publica como release, y la app la ofrece al abrirse.

```
git push a main
      │
      ▼
GitHub Actions ── compila y firma ──▶ Release (tag: v<versionName>-b<versionCode>)
      │
      ▼
La app, al arrancar
   1. GET api.github.com/.../releases/latest   (JavaScript, con CORS)
   2. compara versionCode con el suyo
   3. descarga la APK                          (Java, sin CORS)
   4. lanza el instalador del sistema
      │
      ▼
1 toque → instalada, datos intactos
```

**Android no permite que una app normal instale nada en silencio.** Eso exige
ser *device owner* o app de sistema. Comprobar, descargar y preparar sí es
automático; el último paso es un diálogo del sistema que se confirma a mano.

### La trampa del CORS

La app corre en una WebView cuyo origen es `localhost`, así que todo `fetch`
está sujeto a CORS:

| Petición | ¿Manda `Access-Control-Allow-Origin`? |
| --- | --- |
| `api.github.com/.../releases/latest` | **Sí**, `*` |
| La URL de descarga de un asset | **No** (redirige a `release-assets.githubusercontent.com`) |

Por eso el `versionCode` publicado sale de la **etiqueta** de la release
(`v4.3.0-b1007` → 1007), que ya viene en la respuesta de la API, y no de un
`latest.json` adjunto que la WebView no podría leer. La APK sí se descarga del
asset, pero eso lo hace `UpdaterPlugin.java`, que no pasa por CORS.

### El versionado

`versionCode` = `VERSION_CODE_BASE` + número de commits. Crece solo en cada
push, sin que haya que acordarse de subirlo. La base es **1000** porque las
versiones anteriores a este sistema llegaron a mano hasta la 430, muy por
encima del número de commits: sin ella la primera release automática habría
salido por debajo de lo ya instalado y el móvil no la habría reconocido.

La fórmula vive por duplicado, en `tools/version.mjs` (que alimenta al bundle
vía `vite.config.ts` y al workflow) y en `android/app/build.gradle`, porque
Gradle no puede importar JavaScript. **`npm test` comprueba que las dos
coinciden**: si se separan, la app compara su `versionCode` contra otro número
y el canal falla en silencio.

*Contrapartida:* no se puede reescribir la historia de `main`. Un rebase o un
`push --force` que reduzca el número de commits deja las releases nuevas por
debajo de lo instalado.

### El fallo silencioso

La comprobación del arranque **calla sus errores**: sin cobertura, o con
GitHub limitando por peticiones, la app sigue funcionando sin molestar. El
precio es que un fallo real se ve exactamente igual que «no hay novedades».

Por eso Ajustes → *Actualizaciones* incluye una comprobación **manual** que sí
cuenta lo que ocurre: versión encontrada, ya al día, o el error exacto. No es
un adorno; es la única forma de distinguir «no hay nada» de «está roto».

### La clave de firma

Android identifica una app por `applicationId` + firma. Una APK firmada con
otra clave no es una actualización sino una app distinta, y la instalación
falla con `INSTALL_FAILED_UPDATE_INCOMPATIBLE`.

- La clave vive **fuera del repositorio**, en `../salbus-keystore/`.
- `android/keystore.properties` y `*.jks` están en `.gitignore`.
- En CI viaja como secret en base64 y se reconstruye en el runner.
- **Si se pierde, ningún dispositivo con la app instalada podrá actualizarse
  nunca más**: habría que desinstalar y reinstalar, perdiendo los datos locales.

Secrets necesarios en *Settings → Secrets and variables → Actions*, pestaña
**Secrets** (no *Variables*): `SALBUS_KEYSTORE_BASE64`,
`SALBUS_KEYSTORE_PASSWORD`, `SALBUS_KEY_ALIAS`, `SALBUS_KEY_PASSWORD`.

El repositorio debe ser **público**: la app consulta la API sin credenciales y
en uno privado recibiría un 404 y no ofrecería nada nunca. Meter un token en
la APK no es una opción, porque cualquiera puede extraerlo.

### Compilar una release a mano

```powershell
npm run build
npx cap sync android
cd android; .\gradlew.bat assembleRelease
```

Sin clave de firma disponible la tarea **falla a propósito**, en vez de
producir una APK firmada en debug que ningún móvil aceptaría como
actualización.

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
