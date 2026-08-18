# Revisión funcional de SALBUS

Revisión de la versión 3.4 (carpeta `SALBUS - VB`) funcionalidad por funcionalidad,
con el problema detectado y la solución aplicada en la versión 4.0.

Cada punto marcado como **verificado** tiene una comprobación automática en
`tools/selftest.mjs` (`npm test`) o en `tools/uicheck.mjs` (`npm run ui:check`).

---

## 1. Llegadas en tiempo real

### 1.1 Los autobuses inminentes desaparecían y los tiempos se desplazaban de línea

- **Problema.** El parser usaba una expresión regular global que saltaba desde
  `<b>Línea N:</b>` hasta el siguiente `<span class="right">… minutos</span>`. Las
  filas «LLEGANDO A PARADA» no llevan minutos, así que la expresión perezosa las
  emparejaba con el tiempo de la fila siguiente.
- **Efecto real.** En la parada 222 la web mostraba `L9 LLEGANDO`, `L1 LLEGANDO`,
  `L4 1 min`. La app mostraba **«Línea 9 · 1 min»**: ocultaba los dos autobuses que
  estaban entrando y atribuía a la línea 9 el tiempo de la línea 4.
- **Solución.** Parseo fila a fila (troceando por `arrival_times_results_row`), cada
  fila resuelta de forma independiente, con estado `arriving` para los inminentes.
- **Verificado.** Pruebas «no pierde los buses LLEGANDO A PARADA», «la línea 4
  conserva su tiempo real» y una que reproduce el fallo del parser anterior.

### 1.2 No se distinguía «sin servicio» de «error»

- **Problema.** Cualquier respuesta sin llegadas devolvía una lista vacía y se
  registraba como fallo de tiempo real, llenando el registro de errores falsos
  por las noches.
- **Solución.** Cuatro estados explícitos: `ok`, `empty` (la web dice «No hay datos
  actuales de líneas»), `throttled` (429) y `error`. Cada uno con su mensaje.
- **Verificado.**

### 1.3 Los minutos envejecían en pantalla sin descontarse

- **Problema.** El valor recibido es una foto del instante de la consulta. Con la
  app abierta y sin refrescar, un «5 min» de hace dos minutos seguía diciendo 5.
- **Solución.** La función `liveMinutes()` descuenta el tiempo transcurrido desde
  el momento de la observación, y cada tarjeta indica la antigüedad del dato.

### 1.4 Solo se toleraba el plural «minutos»

- **Problema.** La expresión exigía `minutos`; la web emite también `1 minuto`.
- **Solución.** El patrón acepta singular y plural, además de «LLEGANDO A PARADA»
  y «En parada». **Verificado.**

---

## 2. Bloqueos de la fuente y tiempos de espera

### 2.1 Las peticiones se lanzaban en paralelo (causa real del bloqueo)

- **Problema.** La función que refrescaba varias paradas usaba `Promise.all`: con
  10 paradas guardadas se disparaban **10 peticiones simultáneas**. El límite de la
  fuente son 6–8, así que casi todos los refrescos terminaban en 429.
- **Solución.** Cola única serializada; nunca hay dos peticiones a la vez.

### 2.2 El cooldown de 25 s era un parche, no la causa

Medición realizada el 2026-08-17 contra `?ref=<parada>`:

| Patrón de peticiones | Resultado |
| --- | --- |
| 10 seguidas sin pausa | 6 correctas, luego 429 |
| 20 paradas distintas sin pausa | 6 correctas, luego 429 (el límite es por IP) |
| 1 cada 1,0 s | 8 correctas, 9 bloqueadas, luego recuperación |
| 1 cada 1,5 s | 14 correctas, ningún bloqueo |
| **1 cada 2,0 s** | **15 correctas, ningún bloqueo** |

Se comporta como un cubo de fichas: capacidad de 6–8 y reposición de aproximadamente
1 ficha cada 1,2 s. La recuperación tras un 429 es de 6–10 s.

- **Solución.** Espaciado mínimo de **2 s**, que es el mínimo seguro sostenible. Se
  elimina el bloqueo global de 25 s: ahora se puede actualizar una parada concreta
  al instante, porque el ritmo se controla en la cola y no en la interfaz.
- **Añadido.** Caché por parada (frescura objetivo de 15 s para la parada en
  pantalla y 45 s para el resto), agrupación de peticiones simultáneas a la misma
  parada, y espera progresiva (8 s → 60 s) ante un 429 conservando el último dato
  bueno en lugar de vaciar la pantalla.

### 2.3 Faltaba el `User-Agent` (403 silencioso)

- **Problema.** Sin `User-Agent` de navegador la fuente responde **403**. Se
  manifestaba como «sin datos», sin explicación posible para quien usa la app.
- **Solución.** Cabecera de navegador en las tres vías: `CapacitorHttp` en Android,
  proxy de Vite en navegador y el servicio nativo. **Verificado en vivo.**

### 2.4 En navegador no funcionaba por CORS

- **Problema.** `CapacitorHttp` en web cae a `fetch` y la fuente no envía cabeceras
  CORS, así que `npm run dev` nunca llegó a mostrar llegadas.
- **Solución.** Proxy en `vite.config.ts` que además inyecta el `User-Agent`.
  Verificado: HTTP 200 y contenido parseable.

---

## 3. Información de rutas (ambos sentidos)

### 3.1 Los sentidos se adivinaban y se perdían recorridos

- **Problema.** Los sentidos salían de agrupar `trip_headsign` del GTFS y quedarse
  con **los dos con más paradas**. Se descartaban variantes reales de recorrido y
  el rótulo mostrado era el letrero del vehículo, no el trayecto.
- **Solución.** Fuente oficial: la página de líneas incrusta, por cada línea, los
  atributos `data-paradas-trayecto-{uno..cuatro}` con la secuencia **ordenada** de
  paradas de cada sentido, con nombre y coordenadas. El generador
  `tools/fetch-official-network.mjs` produce `public/data/network.json`.
- **Resultado.** **27 líneas, 80 sentidos y 349 paradas**, todas con coordenadas y
  con origen y destino oficiales. Cobertura completa de la red.
- **Verificado.** Todas las líneas no circulares tienen ida y vuelta; ningún
  sentido queda vacío; las 349 paradas del GTFS están cubiertas; ninguna parada
  carece de coordenadas.

### 3.2 Las líneas circulares 91 y 92 quedaban sin destino

- **Problema.** El rótulo del servicio nocturno no tiene el formato
  «origen > destino», así que el destino resultaba vacío.
- **Solución.** Se detectan y se marcan como circulares; la interfaz muestra
  «… · circular» en lugar de una flecha hacia ninguna parte. **Verificado.**

### 3.3 El destino mostrado podía ser inventado

- **Problema.** Se asignaba el primer `headsign` de la línea aunque por esa parada
  pasaran los dos sentidos.
- **Solución.** Si por la parada pasa un solo sentido se muestra «Hacia X»; si
  pasan varios (ocurre en 30 paradas de la red) se muestra el nombre de la línea.
  La fuente de llegadas no indica el sentido, así que la app no afirma lo que no
  puede saber.

---

## 4. Segundo plano y notificaciones

### 4.1 El seguimiento se congelaba al salir de la app

- **Problema.** El bucle de actualización era un `setInterval` del WebView. Android
  lo congela al pasar a segundo plano, así que la notificación se quedaba con el
  último valor y seguía anunciando «3 min» indefinidamente.
- **Solución.** Servicio en primer plano nativo (`BusTrackingService`) que consulta
  la parada cada 30 s (15 s cuando el autobús está a 2 minutos o menos), reescribe
  la misma notificación en cada ciclo y envía las actualizaciones a la interfaz
  mediante el plugin `BusTracking`.
- **Añadido.** `START_REDELIVER_INTENT` para recuperarse si el sistema mata el
  servicio, acción «Detener» en la propia notificación, y reconciliación al reabrir
  la app para que pantalla y notificación nunca se contradigan.

### 4.2 La notificación sonaba en cada actualización

- **Problema.** Se reprogramaba sin canal propio ni `onlyAlertOnce`.
- **Solución.** Canal con importancia baja, sin sonido ni vibración, con
  `setOnlyAlertOnce` y `ongoing`. Se actualiza en el sitio, sin apilarse ni
  interrumpir.

### 4.3 El icono de la notificación se veía como un cuadrado blanco

- **Problema.** No existía un icono monocromo: se usaba el de la aplicación, que
  tiene fondo. Android descarta el color del icono pequeño y usa solo el canal
  alfa, de modo que un icono con fondo aparece como un bloque sólido.
- **Solución.** `res/drawable/ic_stat_salbus.xml`, silueta sin fondo, declarada
  como `smallIcon` en todas las notificaciones.
- **Verificado.** El SVG fuente no tiene rectángulo de fondo (39,6 % de cobertura
  opaca) y el drawable está presente en el APK generado.

---

## 5. Interfaz

### 5.1 Menú lateral en una aplicación de móvil

- **Problema.** Toda la navegación estaba tras un menú hamburguesa: dos toques para
  cambiar de sección y ningún indicador de en qué sección estabas.
- **Solución.** Barra inferior de seis secciones, siempre visible y con la actual
  resaltada. Rediseño completo con tokens de color, tema claro y oscuro, y una
  jerarquía tipográfica en la que los minutos son el elemento más grande.

### 5.2 Errores de maquetación corregidos durante la revisión

- Los SVG en línea no tenían `width` ni `height` y se estiraban hasta romper el
  ancho de la página. Corregido con dimensiones explícitas.
- La rejilla del cascarón se dimensionaba al contenido más ancho (la barra de
  pestañas) y toda la aplicación desbordaba hacia la derecha. Corregido con
  `minmax(0, 1fr)`.
- El contenedor de pantalla es un flex en columna: sus hijos se comprimían y las
  tarjetas altas aparecían recortadas y solapadas. Corregido con `flex: none`.
- Los elementos de las fichas de resultado quedaban en línea y el texto se
  entremezclaba. Corregido apilándolos.
- **Verificado.** `npm run ui:check` comprueba que ninguna de las seis pantallas
  desborda horizontalmente a 412 px de ancho.

### 5.3 El refresco automático expulsaba del cuadro de búsqueda

- **Problema.** El render reescribía todo el HTML cada segundo, de modo que se
  perdían el foco, la posición del cursor y el desplazamiento.
- **Solución.** El repintado conserva foco, posición del cursor y desplazamiento.

### 5.4 Reemplazo de monitorizaciones mediante `window.prompt`

- **Problema.** Al llegar a dos monitorizaciones se pedía por `prompt` un número
  para elegir cuál reemplazar. Inusable y ajeno al resto de la aplicación.
- **Solución.** Se elimina el límite artificial; cada control se borra desde su
  propia tarjeta. Los renombrados también usan una hoja inferior, no `prompt`.

### 5.5 Estados vacíos y de error mudos

- **Problema.** «Sin llegadas» sin explicar por qué ni qué hacer a continuación.
- **Solución.** Cada estado vacío explica la causa y ofrece la acción siguiente;
  las tarjetas muestran una píldora con el origen y la antigüedad del dato, y los
  lotes largos anuncian su duración estimada («Actualizando 7 paradas · ~12 s»).

---

## 6. Puntualidad (antes «monitorización»)

### 6.1 El horario programado estaba caducado y no se avisaba

- **Problema.** El archivo `calendar_dates.txt` del GTFS solo cubre del
  **2026-03-16 al 2026-03-31**, con un identificador de servicio distinto por fecha.
  Fuera de ese rango, la resolución de servicios activos devolvía **todos** los
  servicios, de manera que las «próximas salidas» mezclaban laborables, sábados y
  domingos como si todos fueran válidos ese día.
- **Solución.** El GTFS se usa **solo** como horario teórico en la pantalla de
  puntualidad, nunca como tiempo de llegada. La app detecta la caducidad y la
  advierte en pantalla y en el registro.

### 6.2 La media no decía si el autobús llega tarde o pronto

- **Problema.** Solo se mostraba la media observada, obligando a compararla a ojo
  con la hora programada.
- **Solución.** Columna de desvío con signo y color (tarde, pronto o en hora), y el
  número de muestras junto a la media.

---

## 7. Limpieza del proyecto

- **Problema.** Tres copias del proyecto (`SALBUS - BACKUP`, `SALBUS - VA` y
  `SALBUS - VB`) con APK antiguos, `node_modules` duplicados y salidas de
  compilación versionadas.
- **Solución.** `SALBUS - VB` (la más reciente y la única con historial de git) se
  ha promovido a la carpeta madre; las otras dos se han eliminado junto con los
  artefactos de compilación.
- **Código muerto retirado.** `server/realtime-proxy.mjs` y `services/realtime.ts`
  ya no los usaba nadie: la aplicación llamaba directamente a la web. Con ellos
  desaparecen las dependencias `express`, `cors` y `gtfs-realtime-bindings`.
- **Nota.** No hay ningún almacén de claves en el proyecto; todos los APK
  encontrados eran de depuración o sin firmar. Para publicar habrá que crear uno.

---

# Versión 4.1

Dos fallos encontrados en uso real sobre la 4.0.

## 8. La interfaz se refrescaba destruyéndose entera

- **Problema.** `paint()` hacía `appRoot.innerHTML = renderApp()` una vez por
  segundo. `innerHTML` no actualiza: **destruye y vuelve a crear todos los nodos**.
  Un `<select>` desplegado dejaba de existir a mitad de la interacción, así que el
  desplegable se cerraba solo y era imposible elegir nada (tipo de día, línea,
  sentido, modo de búsqueda). El parche anterior —restaurar foco, cursor y
  desplazamiento a mano después de repintar— tapaba una parte del síntoma, pero no
  podía devolver a la vida un elemento que ya no existía.
- **Solución.** Repintado incremental en `src/dom.ts`: se genera el HTML nuevo en
  un `<template>` y se compara con el DOM vivo, tocando solo lo que ha cambiado.
  Si un subárbol es idéntico, sus nodos no se rozan.
  - `data-morph="skip"` para lo que gestiona Leaflet; antes el mapa se reconstruía
    entero cada segundo.
  - `data-key` para dar identidad estable a los elementos de una lista.
  - Los campos con el foco no se sobrescriben nunca; el resto sincroniza `value`,
    `checked` y la opción elegida, que viven en propiedades y no en atributos.
  - Ya no hace falta el rescate manual de foco, cursor y desplazamiento: el nodo
    es el mismo de antes y nunca los pierde.
- **Verificado.** `npm run ui:stability` abre Chrome, marca el `<select>` y una
  tarjeta, escribe en el buscador y, tras cuatro ciclos de refresco, comprueba que
  siguen siendo **los mismos elementos**, con su valor, su foco, su texto y la
  posición del cursor.

## 9. La puntualidad no registraba nada

Cinco causas encadenadas; cualquiera de ellas bastaba para dejar la tabla vacía.

### 9.1 La regla de detección no se cumplía en las líneas frecuentes

- **Problema.** Un paso solo se daba por bueno si el contador pasaba de **≤ 2** a
  **≥ 6** minutos. En la línea 4 por Gran Vía, cuando un autobús se va el siguiente
  ya figura a 4 o 5 minutos: el salto nunca llegaba a 6 y **no se registraba
  ningún paso**. Justo las líneas que interesa medir eran las que no se medían.
- **Solución.** Regla por *salto relativo*: estando armado, una subida de 3 minutos
  o más sobre la última lectura significa que lo que se ve ya es la expedición
  siguiente. Se arma a 3 minutos (antes 2), y la desaparición de la línea sigue
  valiendo como confirmación.

### 9.2 Un 429 se interpretaba como «el autobús ya no está»

- **Problema.** `evaluateMonitors` no miraba el estado del feed. Un bloqueo de la
  fuente o un error de red llegaba con la lista de llegadas vacía, se contaba como
  «la línea ha desaparecido» y, con dos seguidos, se **inventaba un paso** que no
  había ocurrido.
- **Solución.** Solo `ok` y `empty` cuentan como observación de la parada.

### 9.3 La hora del paso era la de detectarlo, no la del paso

- **Problema.** Se guardaba `new Date()` en el momento de darse cuenta, que con
  consultas cada 30-60 s llega sistemáticamente tarde. El desvío medido salía
  inflado hacia «llega tarde» sin que el autobús tuviera culpa.
- **Solución.** Al armarse se anota `ahora + minutos que faltan`; esa es la hora
  que se guarda, acotada para que nunca quede por delante de la detección ni más
  de cinco minutos por detrás.

### 9.4 Las observaciones sin hora programada cercana se tiraban

- **Problema.** Si no había ninguna salida a menos de 20 minutos, el paso se
  descartaba con una línea en el registro. Y el emparejado buscaba entre **todas**
  las salidas del día, no entre las de la franja: un paso de las 08:02 en un
  control de 07:00 a 08:00 se atribuía a la salida de las 08:05, que no aparece en
  la tabla, así que la muestra se perdía igualmente.
- **Solución.** El emparejado se limita a las salidas **de la franja y del sentido**
  del control (±15 min) y los pasos sin salida cercana **se guardan igual** y se
  muestran aparte. Son la señal más clara de que el horario oficial se ha quedado
  atrás, que es justo lo que la pantalla quiere enseñar.

### 9.5 El horario mezclaba los dos sentidos de la parada

- **Problema.** `getScheduledTimes` devolvía las salidas de todos los trayectos de
  la línea por esa parada. En las 30 paradas donde una línea pasa en ambos
  sentidos, las salidas quedaban a 4-5 minutos unas de otras y cualquier paso
  encontraba una «hora programada» a uno o dos minutos: el desvío salía siempre
  «en hora» y la medición no significaba nada.
- **Solución.** Cada `route_id` del GTFS es en realidad un sentido, y su
  `route_long_name` es el mismo rótulo que publica la red oficial
  («Cementerio (295) > Puente Ladrillo (309)»). Emparejando por ese rótulo se
  identifican los **80 sentidos**; los 29 trayectos que el GTFS trae de más se
  asignan por destino. El control guarda su sentido y el horario se filtra por él.
  Si un control antiguo no lo tiene, la tarjeta lo avisa en pantalla.

### 9.6 Otras correcciones de la misma pantalla

- El estado de detección (`armed`) **se persiste** y se olvida al salir de la
  franja; antes se perdía al reiniciar la app y un autobús a punto de pasar dejaba
  de contarse.
- Con un autobús ya entrando, la parada se consulta cada 15 s en vez de cada 30:
  es el momento en que se decide si ha pasado.
- Mientras un control está dentro de su franja se sigue consultando aunque la
  pantalla no esté en primer plano (en Android, mientras el sistema no congele el
  WebView).
- La tarjeta ya no se limita a una tabla muda: dice si está observando, si hay un
  autobús entrando, cuántos pasos lleva registrados y en cuántos días, y explica
  qué hace falta para que se llene.
- Se conserva el **dato en bruto** (`salbus.monitorPasses`): cada paso con su hora,
  su fecha, su salida asociada y la regla que lo detectó. La tabla se calcula a
  partir de ahí, no al revés. Los datos del formato anterior se migran solos.

### 9.7 Comprobación en la calle

`npm run test:punctuality -- --stop 222 --line 4 --minutes 90`, ejecutado el
**2026-08-18 de 20:37 a 22:07** contra la fuente real con el parser y la lógica de
la app:

- **180 consultas**, todas con respuesta correcta (ningún 429 con 30 s de
  separación).
- **6 pasos detectados**, todos por la regla del salto y todos emparejados con su
  salida programada:

| Paso observado | Programado | Desvío |
| --- | --- | --- |
| 20:42 | 20:42 | en hora |
| 20:53 | 20:52 | +1 min |
| 21:36 | 21:32 | +4 min |
| 21:44 | 21:42 | +2 min |
| 21:55 | 21:52 | +3 min |
| 22:03 | 22:02 | +1 min |

- **Ningún falso positivo.** Entre las 21:01 y las 21:08 el contador de la fuente
  saltó de 7 a 29, bajó a 12 y volvió a 23 (en esa parada la línea 4 pasa en los
  dos sentidos y el panel los mezcla). Como no había armado, no se registró nada.
- Con la lógica anterior, de esos 6 pasos **no se habría registrado ninguno**: en
  los seis casos el autobús siguiente aparecía a menos de 6 minutos.

## 10. El parser dejó de estar duplicado

`tools/selftest.mjs` llevaba una **copia** del parser de llegadas: las pruebas
podían pasar con el código real roto. Ahora el parser vive en
`src/services/arrival-parser.ts` (sin red ni Capacitor) y tanto las pruebas como el
registrador en vivo compilan e importan **el módulo real**.

---

## Comprobaciones ejecutadas

| Comando | Resultado |
| --- | --- |
| `npm test` | 43 comprobaciones (parser real, red oficial, cobertura, iconos, puntualidad, horario por sentido) |
| `npm run test:live` | Añade la fuente en vivo: 200 con User-Agent, 403 sin él |
| `npm run ui:check` | Las seis pantallas sin desbordes a 412 px |
| `npm run ui:stability` | El refresco no destruye desplegables, tarjetas, foco ni cursor |
| `npm run test:punctuality` | Graba la fuente real y detecta los pasos con la lógica de la app |
| `npx tsc --noEmit` | Sin errores de tipos |
| `gradlew assembleDebug` | APK v4.1 (versionCode 410) generado |
