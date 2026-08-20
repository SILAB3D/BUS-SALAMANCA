# Autoactualización de una app Capacitor por releases de GitHub

Descripción del sistema implementado en Skippify, escrita para poder rehacerlo
en otro proyecto. No depende de nada específico de esta app más allá de que sea
una APK de Capacitor distribuida fuera de Play Store.

## Qué resuelve

Que un `git push` acabe convertido en una actualización instalada en el móvil,
sin que nadie descargue un APK a mano ni entre en ninguna web.

## Qué NO puede hacer (y conviene asumir desde el principio)

**Android no permite que una app normal instale nada en silencio.** La
instalación silenciosa exige ser *device owner* o app de sistema. Todo lo demás
—comprobar, descargar, preparar— sí puede ser automático, pero el último paso es
un diálogo del sistema que el usuario confirma con un toque.

Si esa condición no sirve para tu caso, la única alternativa real es actualizar
sólo la parte web del bundle (Capgo y similares), que **no** cubre cambios en
código nativo, permisos ni dependencias Gradle.

## Arquitectura

```
git push a main
      │
      ▼
GitHub Actions (windows-latest)
      │  compila y FIRMA la APK
      ▼
GitHub Release   tag: v<versionName>-b<versionCode>
      │          assets: la APK (+ un latest.json informativo)
      ▼
La app, al arrancar
      │  1. GET api.github.com/.../releases/latest      (JavaScript, con CORS)
      │  2. compara versionCode con el suyo
      │  3. descarga la APK                              (Java, sin CORS)
      │  4. lanza el instalador del sistema
      ▼
1 toque del usuario → instalada, datos intactos
```

El reparto entre JavaScript y Java no es casual: está explicado más abajo, en
*La trampa del CORS*.

## Las cinco piezas

| Pieza | Papel |
|---|---|
| Clave de firma (`.jks`) | Que todas las APK se firmen igual; es el cimiento |
| Workflow de Actions | Compila, firma y publica en cada push |
| Plugin nativo (`UpdaterPlugin.java`) | Descarga la APK e invoca al instalador |
| Composable (`useAppUpdate.js`) | Consulta la release y compara versiones |
| Aviso en la interfaz | Enseña la novedad, las instrucciones y el progreso |

---

## 1. La clave de firma

Android identifica una app por **applicationId + firma**. Una APK firmada con
otra clave no se considera una actualización sino una app distinta, y la
instalación falla con `INSTALL_FAILED_UPDATE_INCOMPATIBLE`.

Por defecto Capacitor compila en *debug*, firmado con el keystore de debug de
cada máquina. Eso basta mientras compiles siempre en el mismo ordenador y no
sirve en cuanto entra CI: hay que generar un keystore de release propio.

```powershell
keytool -genkeypair -keystore skippify-release.jks -alias skippify `
  -keyalg RSA -keysize 2048 -validity 10950 -storetype PKCS12 `
  -storepass <contraseña> -keypass <contraseña> -dname "CN=..., C=ES"
```

Reglas que no admiten excepción:

- El `.jks` **fuera de git** y con copia de seguridad fuera del proyecto.
- Si se pierde, ningún dispositivo con la app instalada podrá actualizarse nunca
  más: habría que desinstalar y reinstalar, perdiendo los datos locales.
- En CI viaja como secret en base64 y se reconstruye en el runner.

Con Capacitor, la carpeta `android/` suele estar en `.gitignore` porque se
regenera. Eso obliga a **reinyectar la configuración de firma en cada build**, no
a editar `build.gradle` una vez. En Skippify lo hace el propio script de build:
escribe un `android/keystore.properties` y parchea `build.gradle` para leerlo.

## 2. El versionado

Android sólo acepta actualizar a un `versionCode` **estrictamente mayor**. La
tentación es derivarlo de la versión semántica de `package.json`, pero entonces
hay que acordarse de subirla en cada push o el canal deja de funcionar en
silencio.

La solución adoptada: **`versionCode` = número de commits**.

```powershell
$versionCode = git rev-list --count HEAD
```

- Crece solo con cada push, sin intervención.
- `versionName` sigue saliendo de `package.json`, que es lo que ve el usuario.
- La etiqueta de la release combina ambos: `v3.4.0-b23`.

**Contrapartida:** no se puede reescribir la historia de la rama principal. Un
`rebase` o un `push --force` que reduzca el número de commits deja las releases
nuevas por debajo de lo ya instalado, y dejan de verse como actualizaciones.

También conviene comprobar en el script que el valor calculado supera al
`versionCode` de la última APK publicada antes de este sistema; si no, el fallo
es mudo.

## 3. El workflow

Un detalle de diseño que ahorró mucho trabajo: **el workflow corre en
`windows-latest` y ejecuta el mismo script de build que se usa en local.**

En un proyecto Capacitor maduro, el script de build no sólo compila: parchea el
`AndroidManifest.xml`, copia las fuentes nativas, registra plugins, ajusta el
SDK. Portar todo eso a bash para el runner habría duplicado lógica delicada en
dos sitios que se desincronizan. Los runners de Windows cuestan el doble de
minutos, pero en un repositorio público los minutos son gratis.

Esqueleto:

```yaml
on:
  push:
    branches: [main]
    paths-ignore: ['**.md']
  workflow_dispatch:

concurrency:
  group: release-apk
  cancel-in-progress: true    # un push nuevo cancela el anterior

jobs:
  build:
    runs-on: windows-latest
    permissions:
      contents: write          # necesario para crear la release
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0       # el versionCode necesita la historia entera
      - uses: actions/setup-node@v5
      - uses: actions/setup-java@v5
      - name: Restaurar y comprobar el keystore
        ...
      - name: Compilar APK firmada
        run: .\scripts\build-apk.ps1
      - uses: softprops/action-gh-release@v2
        with:
          tag_name: v${{ steps.meta.outputs.versionName }}-b${{ steps.meta.outputs.versionCode }}
          body: ${{ github.event.head_commit.message }}
          files: dist/*.apk
```

`fetch-depth: 0` es obligatorio: el checkout por defecto es superficial y
`git rev-list --count HEAD` devolvería 1.

## 4. El plugin nativo

Dos responsabilidades, ambas imposibles desde JavaScript.

**Descargar.** Se hace en Java y no con `fetch`, por dos motivos: pasar una APK
de varios megas por el puente de Capacitor obliga a codificarla en base64 (un
tercio más de memoria, y en el hilo principal), y porque la descarga desde
JavaScript chocaría con el CORS. En Java es un stream directo a disco con
progreso real, en un hilo propio.

**Instalar.** Requiere:

- El permiso `REQUEST_INSTALL_PACKAGES` en el manifiesto.
- Un `FileProvider` para exponer la APK descargada como `content://` (Capacitor
  ya declara uno con authority `${applicationId}.fileprovider`; si el fichero se
  guarda en `getCacheDir()`, el `file_paths.xml` por defecto ya lo cubre).
- Un `Intent.ACTION_VIEW` con tipo
  `application/vnd.android.package-archive` y los flags
  `FLAG_GRANT_READ_URI_PERMISSION` y `FLAG_ACTIVITY_NEW_TASK`.

Conviene exponer además `canRequestPackageInstalls()` y un atajo a
`Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES`: en Android 8+ el permiso de
«instalar apps desconocidas» se concede por app y el usuario tiene que darlo una
vez.

## 5. La trampa del CORS

Este es el error que costó una versión entera de depuración, y el que más
probablemente repetirás.

La app corre en una WebView cuyo origen es `localhost`, así que **cualquier
`fetch` está sujeto a CORS**:

| Petición | ¿Manda `Access-Control-Allow-Origin`? |
|---|---|
| `api.github.com/repos/.../releases/latest` | **Sí**, `*` |
| La URL de descarga de un asset de release | **No** (redirige a `release-assets.githubusercontent.com`) |

Es decir: la API se puede consultar desde JavaScript, pero **los assets de una
release no se pueden leer desde JavaScript**. Si publicas un `latest.json` con
los metadatos y lo lees con `fetch`, la WebView cancela la petición.

Por eso el `versionCode` sale de la **etiqueta** de la release
(`v3.4.0-b23` → 23), que ya viene en la respuesta de la API. Una petición menos
y ningún problema de origen. La APK sí se descarga del asset, pero eso lo hace
el código nativo, que no pasa por CORS.

## 6. El aviso

El aviso enseña lo mínimo: que hay versión nueva, cuál es, qué va a pasar al
instalar, y los botones. Nada de notas de la versión ni tamaño del descargable:
son datos que nadie lee en un modal y que sólo alargan la decisión.

Lo único que sí merece el espacio son **las instrucciones**. Al instalar fuera
de Play Store, Android enseña una pantalla con tono de advertencia y un botón
poco evidente; ese es el momento exacto en que la gente cancela. Anticiparlo
—«pulsa *Instalar de todos modos*, es segura, va firmada con la misma clave»—
convierte un susto en un trámite.

El botón principal absorbe los estados en su propia etiqueta en vez de añadir
elementos: `Actualizar` → `Descargando… 45 %` → `Instalar` → `Reintentar`.

### El permiso se concede fuera de la app

En Android 8+ el permiso de «instalar apps desconocidas» se da por aplicación, en
una pantalla de ajustes del sistema. Eso tiene una consecuencia fácil de pasar
por alto: **nada dentro de la app avisa de que el permiso ha cambiado**.

Si el aviso se limita a mostrar «Conceder permiso» cuando la instalación falla,
se quedará mostrándolo para siempre, incluso después de que el usuario lo haya
concedido. Hay que releer el estado al volver al primer plano:

```js
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') recheckInstallPermission()
})
```

Y como la APK ya está descargada de la vez anterior, al recuperar el permiso el
botón vuelve directamente a `Instalar`, sin repetir la descarga.

## 7. El fallo silencioso

La comprobación automática del arranque debe callar sus errores: sin cobertura,
o si GitHub responde 403 por límite de peticiones, la app tiene que seguir
funcionando sin molestar.

El precio de ese diseño es que **un fallo real se ve exactamente igual que «no
hay novedades»**. Fue justo lo que pasó con el CORS: durante toda una versión la
app no vio ninguna release y desde fuera parecía que simplemente estaba al día.

Por eso el sistema incluye una comprobación **manual** en la pantalla de ajustes
que sí cuenta lo que ocurre: versión encontrada, ya al día, o el error exacto.
No es un adorno; es la única forma de distinguir «no hay nada» de «está roto».

---

## Puesta en marcha en un proyecto nuevo

1. **Repositorio público.** La app consulta la API sin credenciales. En uno
   privado recibiría un 404 y no ofrecería nada nunca. Meter un token en la app
   no es una opción.
2. **Generar el keystore** y crear cuatro secrets en
   *Settings → Secrets and variables → Actions*, pestaña **Secrets** (no
   *Variables*): el `.jks` en base64, la contraseña del almacén, el alias y la
   contraseña de la clave.
3. **Adaptar el script de build**: firma de release y `versionCode` desde git.
4. **Copiar el plugin nativo** y registrarlo en `MainActivity`.
5. **Copiar el composable y el aviso**, cambiando la constante del repositorio.
6. **Añadir `REQUEST_INSTALL_PACKAGES`** al manifiesto.
7. **Instalar a mano una vez** la primera APK firmada con la clave nueva. A
   partir de ahí el canal se sostiene solo.

## Errores concretos que dieron problemas

Ninguno de estos es teórico; todos ocurrieron.

| Síntoma | Causa |
|---|---|
| El workflow falla en el paso del keystore | Secrets creados en la pestaña *Variables* en vez de *Secrets*, o base64 pegado truncado |
| `INSTALL_FAILED_UPDATE_INCOMPATIBLE` | La instalación previa iba firmada con otra clave (la de debug) |
| La app no ofrece nunca una actualización | El `fetch` a un asset de release, cancelado por CORS |
| `no suitable method found for reject(String,Throwable)` | `PluginCall.reject` de Capacitor acepta `Exception`, no `Throwable` |
| El `versionCode` sale 1 en CI | Falta `fetch-depth: 0` en el checkout |
| El aviso sigue pidiendo el permiso ya concedido | El permiso se da fuera de la app; hay que releerlo al volver al primer plano |

Y una recomendación de método: **los logs de Actions exigen autenticación, pero
las anotaciones de un repositorio público se leen por la API sin credenciales.**
Emitir el diagnóstico como `::notice::` y `::error::` desde el workflow permite
depurar un fallo de CI desde fuera, sin acceso al repositorio ni copiar logs a
mano. Fue así como se localizó el secret truncado.

## Coste

Cero. Runners gratuitos en repositorio público, releases sin límite práctico de
tamaño para una APK, y ningún servicio de terceros.
