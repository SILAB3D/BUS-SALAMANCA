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
    bus-position.ts        En qué parada está el autobús (regla compartida)
    routing.ts             Paradas cercanas y cálculo de rutas (experimental)
    streets.ts             Callejero peatonal: por dónde se anda de verdad
    network.ts             Red oficial de líneas, sentidos y paradas
    schedule.ts            Horario programado a partir del GTFS estático
    notifications.ts       Notificaciones locales
public/data/
  network.json             Red oficial generada (27 líneas · 80 sentidos)
  streets.json             Callejero peatonal de OpenStreetMap (carga diferida)
  gtfs.zip                 GTFS estático (solo horario teórico)
android/                   Proyecto nativo, servicio en primer plano incluido
  app/src/main/java/com/icuas/salbus/
tools/                     Generadores y comprobaciones
```

### El nombre

Todo se llama **SALBUS**: la app, la carpeta del proyecto, `package.json`, el
paquete de código Java (`com.icuas.salbus`) y el `namespace` de Gradle.

Con **una excepción deliberada**: el `applicationId` de Android sigue siendo
`com.icuas.bussalamanca` y no puede cambiar nunca. Ese identificador *es* la
identidad de la app instalada; con otro, el sistema ve una aplicación distinta,
la instalada deja de tener ruta de actualización, quedan dos iconos y las
paradas, avisos e historial —que viven en el almacenamiento de ese
identificador— se quedan en la vieja. Por eso `appId` en `capacitor.config.ts`
tampoco se toca: Capacitor lo copia tal cual al `applicationId`.

## Fuentes de información

Todo procede de **Salamanca de Transportes**:

| Dato | Origen | Actualización |
| --- | --- | --- |
| Llegadas en tiempo real | `salamancadetransportes.com/tiempos-de-llegada/?ref=<parada>` | En vivo |
| Líneas, sentidos y paradas | `salamancadetransportes.com/informacion-de-lineas/lineas/` | `npm run data:network` |
| Horario programado | `public/data/gtfs.zip` (GTFS estático) | Manual |
| Calles para los paseos | OpenStreetMap vía Overpass | `npm run data:streets` |

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

### Qué se actualiza, cada cuánto y con qué condición

Todas estas frecuencias salen de repartir **una sola cola** —una petición cada
2 s— entre funciones que la quieren a la vez. Por eso la columna que manda no es
«cada cuánto» sino «cuándo»: casi todo está apagado la mayor parte del tiempo, y
eso es lo que permite que lo encendido llegue a tiempo.

| Qué | Cada cuánto | Cuándo |
| --- | --- | --- |
| Paradas guardadas | una vez al abrir la app | Una pasada por todas, en serie |
| Parada desplegada | 15 s | Solo la que esté abierta (una a la vez) |
| Ficha de una parada | 15 s | Buscador y mapa; el globo del mapa ya la adelanta |
| Aviso de próximo bus | 15 s | Solo si está activo; con la app cerrada, el servicio nativo |
| Por dónde viene el aviso | 30 s | Solo con el autobús a menos de 20 min, y solo hasta donde puede estar |
| Ver por dónde viene | 20 s por parada | Solo activo, en su pestaña y con la app delante |
| Puntualidad | 30 s (15 s con bus entrando) | Solo dentro de la franja del control |

Los números viven **una sola vez**, en `FRESHNESS` de `src/state.ts`. Ajustes →
*Frecuencias de actualización* los lee de ahí: contarlos en dos sitios acaba
siempre con dos cifras distintas, y la que se enseña es la que no se cumple.

Un dato se pinta como **«al día» durante 40 s** (`SYNC_FRESH_MS` en `src/ui.ts`).
Son el doble del ciclo de un recorrido activo, así que verde significa «entró en
uno de los dos últimos ciclos». Con el minuto de antes, una parada podía haberse
saltado dos ciclos enteros y seguir pintada de verde.

### El repaso de arranque

Al abrir la app se hace **una** pasada en serie por todas las paradas guardadas
(`primeFavourites`). No es un capricho: la fuente tarda lo suyo y solo admite una
consulta cada dos segundos, así que la primera parada que se desplegaba se
quedaba mirando un esqueleto. Esa espera se adelanta al arranque, donde ya hay
una pantalla de bienvenida y una lista que mirar.

Es **una sola vez por sesión**. A partir de ahí, en vivo solo se mantiene la
parada desplegada: plegada no enseña ni un tiempo, y refrescar diez paradas para
no mirar ninguna es gastar la cola contra una fuente que limita por IP.

## Buscar por mapa

**Sin línea ni sentido elegidos el mapa no está vacío: enseña las 349 paradas de
la red**, como puntos sin número, y se puede tocar cualquiera. Es la forma
natural de usar un mapa —«esta es mi calle, esta es mi parada»— y antes obligaba
a saber de antemano qué línea pasa por ella. El botón «Ampliar» funciona también
ahí, que es justo donde más falta hace para acertarle con el dedo.

Al abrir el globo de una parada **se lanza ya la consulta de sus tiempos**, antes
de pulsar «Ver tiempos». Quien abre el globo casi siempre acaba pulsando el
botón, y esa consulta tarda: adelantándola, para cuando se pulsa el dato suele
estar puesto. «Ver tiempos» ya no fuerza otra consulta si la que se adelantó
sigue fresca (`ensureStopFresh`), que era lo que anulaba la ventaja.

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

## La tarjeta de una parada guardada

Dos exigencias que no caben juntas en una cabecera: enseñar **todas** las líneas
que pasan por la parada —son lo que la identifica de un vistazo— y que **todas
las tarjetas plegadas midan lo mismo**, o la lista se lee como si estuviera rota.

Entre el código, el nombre y los botones, a los distintivos les quedaban unos
90 px. La parada más concurrida de la red tiene **trece** líneas: ahí solo podían
salir cortados o con barra de desplazamiento. Por eso bajan a una **franja propia
de ancho completo**, con hueco fijo para dos filas: los trece entran con sitio de
sobra, y una parada de una sola línea ocupa exactamente lo mismo que una de
trece. Ese hueco de más es el precio de que la lista no suba y baje de escalón en
escalón.

La otra mitad del problema era el nombre. El bloque de texto reserva **dos
líneas**, que bastan para las 349 paradas de la red (la más larga son 47
caracteres y entra justa) y también para una parada renombrada, que enseña el
alias arriba y el nombre oficial debajo. Es un **mínimo, no un recorte**: en una
pantalla muy estrecha un nombre que necesite tres líneas se sigue leyendo entero,
porque plantarse en la acera equivocada es peor que una tarjeta desigual.

El botón de actualizar solo aparece **desplegada**. Plegada no se enseña ni un
tiempo, así que refrescar era pedirle a la fuente un dato que nadie iba a ver.

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

La medición **no necesita la app abierta**: dentro de la franja la lleva el mismo
servicio nativo que los avisos (ver [Funcionamiento en segundo plano](#funcionamiento-en-segundo-plano)).
La detección está portada a mano en `BusTrackingService.Monitor` con las mismas
constantes que `punctuality.ts`; `npm test` comprueba que no se separen, porque
si lo hicieran la misma parada mediría distinto según quién la estuviera mirando.

`npm run test:punctuality -- --stop 222 --line 4 --minutes 90` graba la fuente
real con el mismo parser y la misma lógica que la app, y escribe lo observado.

### Por qué a veces no se apunta ninguna hora

Una tabla vacía no dice nada de por qué está vacía, y los motivos son varios y
ninguno se ve desde fuera: la línea no figura en el panel de esa parada, la
fuente está limitando por IP, el móvil se durmió entre consulta y consulta, o el
paso **sí** se detectó pero el horario oficial no tenía ninguna salida cerca a la
que atribuirlo.

Por eso cada control lleva su **registro** (`state.monitorTrace`, desplegable en
su tarjeta). Cada consulta deja anotado lo que vio y lo que decidió con ello:
«faltan 5 min, todavía por encima de los 3 a los que se vigila», «la línea deja
de figurar, 1 de 2 consultas», «paso anotado a las 07:35, programado 07:32,
+3 min». Se guarda en disco, porque la franja se mide también con la app cerrada
y al volver a abrirla el registro es lo único que puede contar qué pasó.

Encima de eso hay un **vigilante** (`superviseMonitors`, un latido por segundo)
que hace lo que la detección de pasos no puede hacer sola, porque esa solo se
ejecuta cuando *llega* un dato:

- anota cuándo empieza y cuándo termina cada franja;
- **avisa cuando una franja abierta lleva más de 3 minutos sin una sola consulta
  buena**. Ese era el caso que dejaba la pantalla vacía sin explicación;
- sostiene una **notificación persistente mientras se mide**, con la línea, la
  parada, la hora de fin y los pasos anotados hoy. No es decorativa: declara al
  sistema que hay trabajo en curso, y sobre todo le dice a quien lleva el móvil
  por qué la app sigue despierta. La publica solo la web, y solo para los
  controles que **no** lleva el servicio nativo, que ya publica la suya.

## Funciones de seguimiento

Hay dos modalidades y las dos tienen tope, porque cada una consulta por su cuenta
una fuente que limita por IP:

Las paradas guardadas **solo se consultan cuando están desplegadas**: plegadas
enseñan sus líneas, no tiempos, así que pedir las diez guardadas para no mirar
ninguna era gastar cola contra una fuente que limita por IP.

| | Máximo creadas | Notas |
| --- | --- | --- |
| Aviso de próximo bus | 2 | notificación persistente con los minutos y a cuántas paradas viene; termina tras ver pasar los autobuses que se elijan en Ajustes (1 a 3, uno por defecto) |
| Ver por dónde viene | 2 | recorrido parada a parada, una consulta cada 20 s por parada |
| **Actualizándose a la vez** | **1 en total** | de cualquier modalidad |

Al crear una por encima del tope de su modalidad se pregunta **cuál se
sustituye**, en vez de rechazar la acción.

**Solo una función se mantiene actualizada a la vez**, sea de la modalidad que
sea. Con dos, el recorrido —ocho paradas por ciclo— y el aviso se quitaban el
turno en una cola que admite una petición cada dos segundos, y las dos llegaban
tarde. **Reanudar una pausa automáticamente la otra**: no hay nada que elegir ni
ningún error que leer, y el botón lo avisa antes de pulsarlo.

Las dos modalidades se pausan y se reanudan. Un aviso en pausa se conserva
entero —parada, línea, autobuses ya vistos— y vuelve de un toque; lo que sí
desaparece al pausarlo es **su notificación**, y por eso desaparece: una
notificación persistente que ya no se actualiza es peor que ninguna, porque se
queda enseñando una hora que dejó de ser verdad.

Se pausa solo, sin tocar nada, en tres situaciones:

| Situación | Qué sigue vivo |
| --- | --- |
| Se sale de la pestaña Seguir | solo el aviso de próximo bus que estuviera activo |
| La app pasa a segundo plano | ídem: el aviso es justo lo que tiene sentido fuera de la pantalla |
| Hay una franja de puntualidad abierta | nada: la pestaña entera se apaga |

La tercera es la más severa a propósito. Medir a qué hora pasa de verdad un
autobús exige no perderse una sola consulta de **esa** parada; un recorrido pide
ocho por ciclo. Entre las dos cosas, la que tiene una hora que perder es el
recorrido: la franja dura minutos y no se repite hasta mañana. Mientras dure, la
pestaña Seguir lo dice donde se ve y sus botones de reanudar están apagados.

## En qué parada está el autobús

**La fuente no lo dice.** La web oficial no publica posiciones ni identificadores
de vehículo: por cada parada dice «línea N, M minutos» y nada más. Lo único que
delata una presencia física es que ese contador caiga a cero o uno, o que la
fuente escriba «LLEGANDO A PARADA». Todo lo demás es deducción, y vive en
`src/services/bus-position.ts`.

La deducción es esta: se mira ese mismo indicio en las paradas **anteriores** del
recorrido —que salen de `network.json` en el orden real del trayecto, no por
cercanía geométrica— y se toma **la más avanzada** que lo cumpla.

Lo de «la más avanzada» no es un detalle de estilo. Las paradas se consultan en
serie, una cada dos segundos, así que los datos de una ventana **no son del
mismo instante**: puede quedar un «llegando» rezagado de hace medio minuto y
otro más adelante recién traído. Como un autobús solo avanza, el índice mayor es
siempre la verdad más nueva. Por eso cada parada de «ver por dónde viene» lleva
su punto de color: la diferencia de medio minuto entre dos renglones es el precio
de una fuente que no deja preguntar más deprisa, no un error.

Es **una sola implementación** para las dos funciones que cuentan paradas. Dos
acabarían situando el mismo autobús en dos sitios distintos con los mismos datos
delante.

### El aviso de próximo bus también cuenta paradas

La notificación dice, a continuación del tiempo, a cuántas paradas viene:

```
Línea 4 · En 7 min · a 4 paradas
Línea 4 · Llegando · en tu parada
```

Los minutos dicen cuándo llega; las paradas dicen si ese número se puede creer.
Un «en 2 min · a 5 paradas» avisa de que el contador va a dar un salto.

Buscar cuesta peticiones contra una fuente que solo admite una cada dos
segundos, y salen del mismo turno que necesita el tiempo de **tu** parada. Tres
reglas lo mantienen barato:

- **Se busca de tu parada hacia atrás y se para en la primera que lo tenga
  encima.** Siendo la más cercana de las que lo tienen, es la más avanzada. Ese
  orden es lo que hace la búsqueda barata: con el autobús cerca —justo cuando el
  dato sirve— se encuentra a la primera o a la segunda consulta.
- **No se mira más atrás de donde puede estar** (`routeScanDepth`): con cinco
  minutos por delante no tiene sentido consultar la parada de hace diez.
- **Por encima de 20 minutos no se busca.** El autobús puede ni haber salido, «a
  trece paradas» no cambia lo que nadie va a hacer, y costaría el máximo de
  peticiones justo cuando menos falta hace.

Un 429 **interrumpe** la búsqueda en vez de seguir hacia atrás: dar por
descartada una parada que no se ha llegado a mirar dejaría el autobús «más lejos»
de lo que está. Y la localización caduca a los dos minutos: un autobús en marcha
deja de estar donde estaba, así que se calla en vez de envejecer el número.

**Hace falta saber el sentido**, porque las paradas anteriores solo existen
dentro de un recorrido concreto, y la fuente nunca dice hacia dónde va el
autobús. Sale de dos sitios, en este orden:

1. **De la red oficial**, cuando la respuesta es única. Por el **93 %** de los
   pares parada-línea pasa un solo sentido y no hay nada que decidir. Los
   trayectos parciales no cuentan como duda: son variantes del mismo sentido.
2. **De quien crea el aviso**, cuando no lo es. En el 5 % de paradas por las que
   la línea pasa en los dos sentidos, la hoja de «Avisarme del próximo bus»
   añade el desplegable de sentido. Deducirlo ahí sería jugárselo a cara o cruz
   y mandar a mirar a la acera de enfrente; preguntarlo no cuesta nada, porque
   **quien está esperando ya sabe cuál es su autobús** —es el que quiere coger—.

Ese desplegable **solo aparece cuando hay algo que elegir**: preguntarlo en el
93 % restante sería una pregunta sin respuestas. Y el sentido elegido no filtra
el aviso, solo sirve para contar paradas: la fuente publica «Línea 4, 7 minutos»
sin decir hacia dónde va, así que la notificación suena con cualquier autobús de
la línea. La hoja lo dice donde se elige, para que nadie cuente con un filtro que
no existe.

Los avisos guardados de antes reciben el sentido al arrancar solo si no admite
duda (`backfillTrackingDirections`). Los de una parada con dos sentidos se quedan
sin él: nadie llegó a elegirlo, y ponerlo entonces sería adivinar. Se arreglan
volviendo a crear el aviso, que ya lo pregunta.

Con la app cerrada quien busca es el servicio nativo, que lleva la regla portada
a mano en `BusTrackingService.sweepRoute` (barre cada 30 s, no en cada ciclo) y
recibe el recorrido ya resuelto en `BusTracking.sync`: la red de líneas es un
JSON que solo existe en la parte web. Mientras el servicio vive, la web **no**
busca en paralelo —serían el doble de peticiones y dos recuentos capaces de
discrepar— y se limita a reflejar el suyo. `npm test` comprueba que las
constantes de las dos copias no se separen.

## Mapas (experimental)

Pestaña **apagada de fábrica**. Se enciende en Ajustes → Experimental, y apagada
no existe: no aparece en la barra, no se puede abrir aunque quedara guardada como
última pestaña, no crea ningún mapa y no pide la ubicación. Al apagarla —incluso
estando dentro— se sueltan en el acto el mapa, el `watchPosition` y lo calculado.

Dos funciones:

**Paradas cercanas.** Ubicación por `navigator.geolocation`; en Android es
Capacitor quien saca el diálogo del permiso al llamarla, así que no hace falta
plugin propio, solo `ACCESS_COARSE_LOCATION` y `ACCESS_FINE_LOCATION` en el
manifiesto. Se piden **las dos** cosas: `getCurrentPosition`, que responde
enseguida (vale incluso una lectura cacheada), y `watchPosition`, que la va
afinando. Solo con el seguimiento la primera posición puede tardar o no llegar
según el sistema y la pantalla se queda en "Buscando tu ubicación…" —pasó en las
pruebas—; solo con la lectura suelta, las "paradas más cercanas" salían de otro
barrio, porque el primer dato trae cientos de metros de error. Una posición peor
nunca pisa a una mejor, o las paradas se moverían hacia atrás en pantalla.
El mapa dibuja el punto con su círculo de precisión —enseñar un punto exacto
cuando el sistema dice "en algún sitio de estos 300 m" es mentir— y las seis
paradas más próximas numeradas.

Los dos mapas de la pestaña llevan **botón de ampliar**, igual que el del
buscador y por el mismo mecanismo: el contenedor no se mueve del árbol, solo
cambia cómo se coloca, porque moverlo obligaría a reconstruir Leaflet.

Cuando la ubicación no llega, la app **distingue qué falta y lleva hasta allí**.
El interruptor general de ubicación del teléfono y el permiso de SALBUS son dos
cosas distintas que desde la página se ven igual —la geolocalización no
responde— y se arreglan en pantallas distintas del sistema. Se le pregunta al
sistema en vez de suponerlo (`DeviceSettings.isLocationEnabled`), porque un GPS
que tarda bajo techo da exactamente el mismo error que uno apagado, y el botón
que aparece abre la pantalla concreta: los ajustes de ubicación, o la ficha de
permisos de la app. Decir «activa la ubicación» sin llevar hasta donde se activa
deja el problema donde estaba.

**Rutas.** Origen y destino se eligen entre "mi ubicación" y las paradas de la
red; no hay buscador de calles porque no hay geocodificador sin conexión. El
cálculo (`src/services/routing.ts`) es un Dijkstra sobre las paradas donde el
coste es el TIEMPO: cada arista de autobús va de la parada de subida a la de
bajada de un mismo sentido, así que el camino ya sale troceado en tramos. Hay
penalización por transbordo (cambiar de autobús cansa: sin ella el cálculo
proponía dos saltos para ganar un minuto) y tope de dos.

El tiempo dentro del autobús se **estima** con la distancia real entre paradas
del recorrido a 17 km/h más una espera por parada. El GTFS daría minutos
exactos, pero son 543.000 filas y caduca: indexarlas por trayecto encarecería el
arranque de TODA la app por una función experimental. La espera en parada sí sale
del horario cuando lo hay, como frecuencia (mediana de los huecos entre salidas
de la franja, dividida entre dos) y no como "la próxima salida a las 08:12": una
hora concreta de un feed caducado acaba siendo mentira, una frecuencia envejece
mucho mejor.

### Los paseos van por las calles

El cálculo medía los tramos a pie **en línea recta**. En una ciudad eso no es una
aproximación: entre dos puntos separados 200 m en el mapa puede haber un río, una
vía de tren o una manzana entera, y el error iba **siempre** en la misma
dirección —a menos—, porque la recta es el camino más corto que existe.

`public/data/streets.json` es el callejero peatonal de Salamanca sacado de
OpenStreetMap (`npm run data:streets`): unos 100.000 nodos y 123.000 tramos, ~2 MB.
Van en enteros de millonésimas de grado y **diferenciales** respecto al nodo
anterior, con los nodos ordenados por posición, así que casi todos los números
son de tres o cuatro cifras en vez de ocho. El JSON crudo de Overpass eran varias
decenas de megas.

**No se carga al arrancar.** Lo pide `src/services/streets.ts` la primera vez que
se entra en «Rutas», una sola vez por sesión. Que una función en pruebas
encareciera el arranque de toda la app sería lo contrario de lo que se busca. Si
el fichero no está, la ruta sale igual con la estimación en recta y lo dice: cada
tramo a pie que no se haya medido por las calles lleva la coletilla «en línea
recta».

El camino se resuelve con un **A\*** sobre listas de adyacencia planas y un
montículo binario. Con cien mil nodos, una cola que se reordena en cada inserción
convertía un cálculo de milisegundos en varios segundos con la pantalla
congelada; y la estimación (distancia en recta) nunca puede pasarse, que es la
condición para que el primer camino encontrado sea de verdad el más corto.

**El afinado se hace después de elegir la ruta, no dentro del cálculo.** Es una
cuestión de coste: el Dijkstra de `planRoute` evalúa paseos entre cientos de
pares de paradas, y resolver cada uno sobre el callejero dejaría la pantalla
parada varios segundos. Un itinerario ya elegido tiene dos o tres tramos a pie, y
esos sí se miden exactos —son los que se leen y se andan—. La contrapartida está
dicha y se compensa: como la recta se queda corta siempre, una ruta podía ganar
por medio minuto gracias a un paseo que en realidad cruzaba una manzana; por eso
`refineWalking` devuelve minutos nuevos y **se vuelve a ordenar con ellos**. Si la
alternativa pasa a ser mejor, es la alternativa la que se recomienda.

Los transbordos ya se valoraban y se siguen valorando igual: penalización fija de
4 minutos además de la espera real (cambiar de autobús cansa y se falla) y tope
de dos. Lo que cambia es que ahora el paseo del transbordo se mide por donde se
cruza de verdad.

> Lo experimental no le quita recursos a lo demás: esta pestaña **no consulta ni
> un solo tiempo de llegada**. Esa fuente limita por IP y su cola es para el
> aviso de próximo bus. La única consulta que hace es la de la ficha de una
> parada, y solo cuando se toca a propósito.

## Funcionamiento en segundo plano

Los avisos de «próximo bus» los mantiene un **servicio en primer plano** nativo
(`BusTrackingService`), no el WebView: Android congela los temporizadores de la
página al pasar a segundo plano. El servicio lleva hasta dos avisos, cada uno con
su notificación y su cuenta de autobuses, los consulta **en serie** dentro de
cada ciclo y envía los datos a la interfaz mediante el plugin `BusTracking` para
que pantalla y notificaciones digan siempre lo mismo.

La web manda siempre la **lista completa** de avisos activos (`BusTracking.sync`),
nunca altas y bajas sueltas: así las dos partes no pueden discrepar sobre cuántos
avisos hay vivos.

Un aviso detenido desde el botón «Detener» de su notificación queda anotado en
las preferencias del servicio. Al volver a abrir la app se leen esas bajas y el
aviso se retira: antes la app veía su aviso guardado, no encontraba el servicio
vivo y lo revivía, con lo que reaparecía la notificación que se acababa de
quitar.

Cuando faltan 3 minutos el móvil da una **vibración corta**, una sola vez por
autobús (se rearma cuando ese autobús pasa). Se desactiva desde Ajustes.

La notificación del aviso enseña **cinco datos y ninguno repetido**: la línea, el
tiempo que falta y a cuántas paradas viene el autobús en el título, la dirección
y la hora de la última actualización en el cuerpo. El recuento de paradas
aparece solo cuando consta (ver [En qué parada está el
autobús](#en-qué-parada-está-el-autobús)): la fuente no publica posiciones, así
que unas veces se deduce y otras no, y un hueco en blanco haría pensar que la app
se ha quedado colgada. El aviso de «ya ha pasado» lo publica **solo** el
servicio; la web se lo salta cuando el cierre viene de él (`finishTracking(id,
true)`), porque publicando los dos salían dos notificaciones idénticas.

### Puntualidad con la app cerrada

Los controles de puntualidad viajan en el mismo `BusTracking.sync`. Dentro de su
franja el servicio los consulta cada 30 s (cada 15 s con un autobús ya entrando)
y sostiene un **WakeLock parcial**: sin él el móvil se duerme entre consulta y
consulta y se pierde justo el paso que se quería medir.

Entre franja y franja el servicio **se apaga del todo**. Quedarse esperando en
primer plano agotaría el tope diario de horas que Android 15 le pone a un
servicio de tipo `dataSync`, y lo agotaría sin haber medido nada. Quien lo trae
de vuelta es una alarma (`setAndAllowWhileIdle`, sin permiso de alarma exacta)
que despierta a `BusTrackingReceiver`; ese receptor arranca el servicio dentro de
los segundos de permiso que el sistema concede al entregar la alarma, y si el
sistema se niega reprograma en lugar de tumbar la app. El mismo receptor atiende
al arranque del móvil, que se lleva por delante servicio y alarmas.

Las franjas se guardan en las preferencias del servicio, así que se siguen
midiendo aunque la app lleve días sin abrirse. Los pasos detectados se anotan
también en disco y la app los recoge con `takePasses`, que los **entrega y los
borra a la vez**: leerlos sin borrarlos los contaría otra vez en el siguiente
arranque. El emparejado con el horario programado se hace en la web, que es donde
vive el GTFS. Mientras el servicio lleva un control, la web no detecta pasos de
ese control: hacerlo en los dos sitios apuntaría el mismo autobús dos veces.

El icono pequeño de la notificación (`res/drawable/ic_stat_salbus.xml`) es una
silueta monocroma **sin fondo**: Android descarta el color y usa solo el canal
alfa, así que un icono con fondo se vería como un cuadrado blanco.

## Actualización automática

> **Qué versión tengo instalada lo dice el sistema**, no el número que Vite
> incrusta en el bundle. Ese número se queda congelado si la WebView sirve una
> copia vieja de la página, y con él la app se ofrecía a sí misma la
> actualización que acababa de instalar, en bucle. `Updater.currentVersion()`
> lee el `PackageManager`, que además delata una instalación que no llegó a
> completarse en vez de darla por buena.
>
> Y una descarga guardada **sólo vale para su versión**: el plugin lee el
> `versionCode` del propio APK con `getPackageArchiveInfo()`. Antes servía para
> cualquier release, así que quien tenía un APK a medio instalar de una versión
> anterior pulsaba «Instalar», reinstalaba la vieja, y volvía a ver el mismo
> aviso al abrir.
>
> El `versionName` sale de `package.json` y no cambia solo: dos releases seguidas
> pueden llamarse igual. Lo que las distingue siempre es la **compilación**
> (`-b1012`), y por eso la ventana de aviso y la pantalla de Ajustes la enseñan.

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
npm run data:streets   # regenera public/data/streets.json (OpenStreetMap)
npm run assets:icons   # regenera iconos y splash desde public/favicon.svg

npm run android:sync   # build + cap sync
npm run android:build  # genera el APK de depuración
npm run android:open   # abre Android Studio
```

## Mantenimiento

- **Red de líneas**: `npm run data:network` cuando cambien recorridos o paradas.
- **Callejero**: `npm run data:streets` de tanto en tanto; OpenStreetMap cambia
  poco y una calle nueva solo afecta a la pestaña experimental.
- **Horario programado**: sustituir `public/data/gtfs.zip` por un feed vigente.
- **Icono**: editar `public/favicon.svg` y `public/icon-mono.svg`, después
  `npm run assets:icons`.
