/**
 * Comprobaciones automaticas de la logica pura (parser, red oficial, horario).
 * No necesita navegador ni dispositivo.
 *
 * Uso:  node tools/selftest.mjs           (usa fixtures locales)
 *       node tools/selftest.mjs --live    (ademas consulta la fuente oficial)
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')

let passed = 0
let failed = 0

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function section(title) {
  console.log(`\n${title}`)
}

/* ------------------------------------------------------------------ *
 * Parser de la version 3.4 (solo para la prueba de regresion)          *
 * ------------------------------------------------------------------ */

/**
 * Recorria el HTML con una unica expresion global y perezosa que saltaba desde
 * `<b>Linea N:</b>` hasta el siguiente `… minutos`. Las filas "LLEGANDO A PARADA"
 * no llevan minutos, asi que se emparejaban con el tiempo de la fila siguiente:
 * desaparecian los autobuses inminentes y los tiempos se corrian de linea.
 */
function parseLegacy(html) {
  const normalized = html.replace(/\s+/g, ' ')
  const regex = /<b>\s*L[ií]nea\s*([^:<]+?)\s*:\s*<\/b>.*?<span[^>]*class="right"[^>]*>\s*(\d+)\s*minutos?/gi

  const rows = []
  let match = null
  while ((match = regex.exec(normalized)) !== null) {
    rows.push({ lineId: match[1].trim(), minutesUntil: Number.parseInt(match[2], 10) })
  }
  return rows
}

/* ------------------------------------------------------------------ *
 * Fixtures sinteticos                                                  *
 * ------------------------------------------------------------------ */

function buildRow(lineId, value) {
  return `<div class="arrival_times_results_row">
    <div><b>Línea ${lineId}:</b></div>
    <div><span class="right">${value}</span></div>
</div>`
}

function buildPage(stopId, stopName, rows) {
  return `<div id="arrival_times_results">
    <p>Próximos autobuses que pasarán por la parada ${stopId}, <b>${stopName}</b></p><br />
    ${rows.join('\n')}
</div></div>`
}

async function main() {
  // Se compilan los modulos reales de la app: las pruebas se hacen contra el
  // codigo que se ejecuta, no contra una copia paralela.
  const build = await compileSources([
    'arrival-parser.ts',
    'punctuality.ts',
    'network.ts',
    'schedule.ts',
    'release-parser.ts',
    'routing.ts',
  ])

  const { parseStopFeed } = await import(pathToUrl(path.join(build, 'arrival-parser.js')))

  section('1 · Parser de llegadas')

  {
    const html = buildPage('103', 'Pº. Canalejas, 12', [
      buildRow('4', '4 minutos'),
      buildRow('13', '12 minutos'),
      buildRow('92', '28 minutos'),
    ])
    const feed = parseStopFeed('103', html)
    check('lee una parada normal', feed.status === 'ok' && feed.arrivals.length === 3)
    check('extrae el nombre oficial de la parada', feed.stopName === 'Pº. Canalejas, 12', feed.stopName ?? 'null')
    check(
      'asigna cada tiempo a su línea',
      feed.arrivals[0].lineId === '4' && feed.arrivals[0].minutesUntil === 4,
      JSON.stringify(feed.arrivals[0]),
    )
  }

  {
    // Caso real de la parada 222: dos buses "LLEGANDO A PARADA" seguidos de tiempos.
    const html = buildPage('222', 'C/ Gran Vía, 38', [
      buildRow('9', 'LLEGANDO A PARADA'),
      buildRow('1', 'LLEGANDO A PARADA'),
      buildRow('4', '1 minutos'),
      buildRow('4', '6 minutos'),
      buildRow('3', '9 minutos'),
    ])

    const feed = parseStopFeed('222', html)
    check('no pierde los buses "LLEGANDO A PARADA"', feed.arrivals.length === 5, `${feed.arrivals.length} filas`)
    check(
      'marca los inminentes con estado "arriving"',
      feed.arrivals.filter((item) => item.status === 'arriving').length === 2,
    )
    check(
      'la línea 4 conserva su tiempo real (1 min)',
      feed.arrivals.some((item) => item.lineId === '4' && item.minutesUntil === 1),
    )

    const legacy = parseLegacy(html)
    check(
      'el parser anterior fallaba (regresión cubierta)',
      legacy.length === 3 && legacy[0].lineId === '9' && legacy[0].minutesUntil === 1,
      `parser v3.4 devolvió ${JSON.stringify(legacy)}`,
    )
  }

  {
    const html = buildPage('212', 'Avda. Aldehuela de los Guzmanes, s/n', [])
      .replace('<br />', '<br /><p>No hay datos actuales de líneas que circulen por la parada seleccionada.</p>')
    const feed = parseStopFeed('212', html)
    check('distingue "sin servicio" de un error', feed.status === 'empty' && feed.arrivals.length === 0)
  }

  {
    const feed = parseStopFeed('1', '<html><body>Error 500</body></html>')
    check('marca como error una respuesta sin panel de llegadas', feed.status === 'error')
  }

  {
    const html = buildPage('9', 'Prueba', [buildRow('1', '1 minuto'), buildRow('2', 'En parada')])
    const feed = parseStopFeed('9', html)
    check('acepta el singular "1 minuto"', feed.arrivals.some((item) => item.lineId === '1' && item.minutesUntil === 1))
    check('acepta "En parada"', feed.arrivals.some((item) => item.lineId === '2' && item.status === 'arriving'))
  }

  section('2 · Red oficial')

  const network = JSON.parse(await fs.readFile(path.join(projectRoot, 'public', 'data', 'network.json'), 'utf8'))

  check('se han descargado las 27 líneas', network.lines.length === 27, `${network.lines.length}`)
  check('todas las líneas tienen al menos un sentido', network.lines.every((line) => line.directions.length > 0))

  const bidirectional = network.lines.filter((line) => {
    const ways = new Set(line.directions.map((direction) => direction.way))
    return ways.has('ida') && ways.has('vuelta')
  })
  // 91 y 92 son circulares nocturnas y solo tienen un sentido por definición.
  check(
    'todas las líneas no circulares tienen ida y vuelta',
    bidirectional.length === network.lines.length - 2,
    `${bidirectional.length} de ${network.lines.length}`,
  )

  check(
    'ningún sentido está vacío',
    network.lines.every((line) => line.directions.every((direction) => direction.stops.length >= 2)),
  )

  check(
    'todas las paradas tienen coordenadas válidas',
    Object.values(network.stopsById).every(
      (stop) => Number.isFinite(stop.lat) && Number.isFinite(stop.lon) && Math.abs(stop.lat - 40.96) < 0.3,
    ),
  )

  check(
    'origen y destino declarados en cada sentido',
    network.lines.every((line) =>
      line.directions.every((direction) => direction.origin.length > 0 && direction.destination.length > 0),
    ),
  )

  // La ida y la vuelta deben ser recorridos distintos, no el mismo repetido.
  const mirrored = network.lines.filter((line) => {
    const forward = line.directions.find((direction) => direction.way === 'ida' && !direction.partial)
    const backward = line.directions.find((direction) => direction.way === 'vuelta' && !direction.partial)
    if (!forward || !backward) {
      return true
    }
    return forward.stops[0].stopId !== backward.stops[backward.stops.length - 1].stopId
      ? false
      : true
  })
  check(
    'la vuelta termina donde empieza la ida en la mayoría de líneas',
    mirrored.length >= network.lines.length - 6,
    `${mirrored.length} de ${network.lines.length}`,
  )

  section('3 · Cobertura parada ↔ línea')

  const stopIds = Object.keys(network.stopsById)
  check('la red cubre las 349 paradas del GTFS', stopIds.length === 349, `${stopIds.length}`)
  check(
    'toda parada pertenece al menos a una línea',
    stopIds.every((stopId) => (network.linesByStopId[stopId] ?? []).length > 0),
  )

  const ambiguous = stopIds.filter((stopId) => {
    const lines = network.linesByStopId[stopId] ?? []
    return lines.some((lineId) => {
      const line = network.lines.find((item) => item.lineId === lineId)
      const through = line.directions.filter(
        (direction) => !direction.partial && direction.stops.some((stop) => stop.stopId === stopId),
      )
      return through.length > 1
    })
  })
  console.log(
    `  info paradas donde una línea pasa en ambos sentidos: ${ambiguous.length} (se muestra el nombre de la línea, no un destino inventado)`,
  )

  section('4 · Iconografía')

  const mono = await fs.readFile(path.join(projectRoot, 'public', 'icon-mono.svg'), 'utf8')
  check('el icono de notificación no tiene fondo', !/<rect[^>]*width="24"[^>]*height="24"[^>]*fill="(?!none)/.test(mono))

  const drawable = await fs.readFile(
    path.join(projectRoot, 'android', 'app', 'src', 'main', 'res', 'drawable', 'ic_stat_salbus.xml'),
    'utf8',
  )
  check('existe el drawable monocromo de Android', drawable.includes('<vector') && drawable.includes('pathData'))

  const css = await fs.readFile(path.join(projectRoot, 'src', 'style.css'), 'utf8')
  const splashDuration = css.match(/animation:\s*splash-out[^;]*?([\d.]+)s\s+forwards/)
  check('la animación de carga dura 1,5 s', css.includes('1.5s'), splashDuration?.[0] ?? 'no encontrada')

  section('5 · Puntualidad')

  const { observe, matchSlot, ARM_MINUTES } = await import(pathToUrl(path.join(build, 'punctuality.js')))

  // Un recorrido tipico: el autobus se acerca, entra y aparece el siguiente.
  const minute = 60_000
  const t0 = new Date('2026-08-18T07:30:00').getTime()

  function feedSequence(values, options = {}) {
    const step = options.stepMs ?? 30_000
    let runtime
    const passes = []

    values.forEach((minutes, index) => {
      const at = t0 + index * step
      const detection = observe(runtime, { minutes, at })
      runtime = detection.runtime
      if (detection.passAt !== null) {
        passes.push({ at: detection.passAt, reason: detection.reason })
      }
    })

    return { runtime, passes }
  }

  check(
    'se detecta el paso cuando el contador salta a la siguiente expedicion',
    feedSequence([6, 5, 3, 2, 1, 8, 7]).passes.length === 1,
  )

  check(
    'se detecta el paso en una linea frecuente (el siguiente bus ya viene a 4 min)',
    feedSequence([5, 3, 1, 4, 4, 3]).passes.length === 1,
    'la regla anterior exigia un salto hasta 6 min y no registraba nada',
  )

  check(
    'se detecta el paso cuando la linea desaparece del panel',
    feedSequence([4, 2, 1, null, null]).passes.length === 1,
  )

  check(
    'no se inventa un paso si el autobus nunca llego a acercarse',
    feedSequence([12, 10, 9, null, null]).passes.length === 0,
  )

  check(
    'el ruido de un minuto arriba o abajo no cuenta como paso',
    feedSequence([3, 2, 3, 2, 3, 2]).passes.length === 0,
  )

  check(
    'un mismo autobus no se cuenta dos veces',
    feedSequence([2, 1, null, null, null, null]).passes.length === 1,
  )

  check(
    `se arma con ${ARM_MINUTES} minutos o menos`,
    feedSequence([ARM_MINUTES]).runtime.armed === true && feedSequence([ARM_MINUTES + 1]).runtime.armed === false,
  )

  // La hora del paso sale del contador, no del instante en que se nota: si la
  // última consulta vio "1 min" y la siguiente llega dos minutos después, el
  // autobús pasó al principio de ese hueco, no al final.
  const estimated = feedSequence([5, 1, null], { stepMs: 2 * minute }).passes[0]
  check(
    'la hora del paso se estima con el contador, no con el momento de detectarlo',
    estimated.at === t0 + 3 * minute,
    `estimado ${new Date(estimated.at).toISOString()} · detectado ${new Date(t0 + 4 * minute).toISOString()}`,
  )

  check('un paso se asocia a la salida programada mas cercana', matchSlot(7 * 60 + 34, ['07:30', '07:45']).slot === '07:30')
  check('el desvio sale con signo', matchSlot(7 * 60 + 34, ['07:30']).delta === 4)
  check('un paso adelantado da desvio negativo', matchSlot(7 * 60 + 28, ['07:30']).delta === -2)
  check('sin ninguna salida cerca no se inventa emparejamiento', matchSlot(7 * 60 + 34, ['09:00']).slot === null)
  check('sin salidas programadas devuelve null', matchSlot(450, []).slot === null)

  section('6 · Horario programado por sentido')

  const { buildNetwork } = await import(pathToUrl(path.join(build, 'network.js')))
  const { loadSchedule, currentDayType } = await import(pathToUrl(path.join(build, 'schedule.js')))

  const server = await serveDirectory(path.join(projectRoot, 'public'))
  try {
    const net = buildNetwork(
      JSON.parse(await fs.readFile(path.join(projectRoot, 'public', 'data', 'network.json'), 'utf8')),
    )
    const schedule = await loadSchedule(net, `${server.origin}/data/gtfs.zip`)

    check('el horario declara su rango de validez', Boolean(schedule.validFrom && schedule.validTo),
      `${schedule.validFrom} → ${schedule.validTo}`)
    check('se detecta que el GTFS incluido esta caducado', schedule.stale === true, `caduca ${schedule.validTo}`)

    // Parada con los dos sentidos de una misma linea: es donde el horario sin
    // filtrar mezclaba idas y vueltas y el desvio salia siempre "en hora".
    let sample = null
    for (const line of net.lines) {
      for (const stop of line.directions[0]?.stops ?? []) {
        const through = net.getDirectionsThroughStop(stop.stopId, line.lineId).filter((item) => !item.partial)
        if (through.length < 2) continue
        const all = schedule.getScheduledTimes(stop.stopId, line.lineId, 'weekday')
        const one = schedule.getScheduledTimes(stop.stopId, line.lineId, 'weekday', through[0].key)
        if (all.length > 0 && one.length > 0 && one.length < all.length) {
          sample = { stopId: stop.stopId, lineId: line.lineId, all, one, key: through[0].key }
          break
        }
      }
      if (sample) break
    }

    check('el horario se puede acotar a un solo sentido', sample !== null,
      sample ? `parada ${sample.stopId} L${sample.lineId}: ${sample.all.length} → ${sample.one.length} salidas` : 'sin caso')

    if (sample) {
      check(
        'el sentido filtrado es un subconjunto del total',
        sample.one.every((clock) => sample.all.includes(clock)),
      )
    }

    const times = schedule.getScheduledTimes('222', '4', 'weekday')
    check('hay horario programado de la linea 4 en la parada 222', times.length > 0, `${times.length} salidas`)
    check('las horas vienen en formato HH:MM ordenadas', times.every((clock) => /^\d{2}:\d{2}$/.test(clock))
      && times.join() === [...times].sort().join())
    check('el tipo de dia actual es uno de los tres', ['weekday', 'saturday', 'sunday'].includes(currentDayType()))
  } finally {
    await server.close()
  }

  if (process.argv.includes('--live')) {
    section('7 · Fuente oficial en vivo')

    const userAgent =
      'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'

    const withUa = await fetch('https://salamancadetransportes.com/tiempos-de-llegada/?ref=103', {
      headers: { 'User-Agent': userAgent },
    })
    check('la fuente responde 200 con User-Agent de navegador', withUa.status === 200, `HTTP ${withUa.status}`)

    const feed = parseStopFeed('103', await withUa.text())
    check('la respuesta real se parsea', feed.status === 'ok' || feed.status === 'empty', feed.status)
    console.log(`  info parada 103 → ${feed.arrivals.map((item) => `L${item.lineId}:${item.minutesUntil}`).join(' ')}`)

    await new Promise((resolve) => setTimeout(resolve, 2500))

    const withoutUa = await fetch('https://salamancadetransportes.com/tiempos-de-llegada/?ref=103', {
      headers: { 'User-Agent': '' },
    })
    check('sin User-Agent de navegador la fuente rechaza', withoutUa.status === 403, `HTTP ${withoutUa.status}`)
  }

  section('7 · Canal de actualización')

  const { parseTag, readRelease, isNewer } = await import(
    pathToUrl(path.join(build, 'release-parser.js'))
  )
  const { resolveVersion, VERSION_CODE_BASE } = await import(
    pathToUrl(path.join(projectRoot, 'tools', 'version.mjs'))
  )

  const version = resolveVersion()

  // La formula del versionCode vive por duplicado (tools/version.mjs y
  // android/app/build.gradle) porque Gradle no puede importar JavaScript. Si
  // las dos se separan, la app compara su versionCode contra otro numero y el
  // canal falla EN SILENCIO: o se ofrece una actualizacion ya instalada, o no
  // se ofrece ninguna nunca.
  const gradle = await fs.readFile(
    path.join(projectRoot, 'android', 'app', 'build.gradle'),
    'utf8',
  )

  check('Gradle declara la misma base de versionCode que tools/version.mjs',
    gradle.includes('ext.VERSION_CODE_BASE = ' + VERSION_CODE_BASE),
    String(VERSION_CODE_BASE))
  check('Gradle cuenta los commits para el versionCode',
    gradle.includes("'rev-list', '--count', 'HEAD'"))
  check('Gradle toma el versionName de package.json',
    gradle.includes('readPackageVersion(rootProject.projectDir)'))

  // Las versiones anteriores a este sistema llegaron a mano hasta la 430: por
  // debajo de ese numero el movil no reconoceria la release como actualizacion.
  check('el versionCode calculado supera al ultimo publicado a mano',
    version.versionCode > 430, String(version.versionCode))

  check('la etiqueta combina version y compilacion',
    version.tag === `v${version.versionName}-b${version.versionCode}`, version.tag)
  check('la etiqueta se lee de vuelta sin perder nada',
    parseTag(version.tag)?.versionCode === version.versionCode
      && parseTag(version.tag)?.versionName === version.versionName)
  check('una etiqueta sin compilacion se descarta', parseTag('v4.3.0') === null)
  check('una etiqueta vacia se descarta', parseTag('') === null)

  const release = {
    tag_name: 'v4.4.0-b1010',
    published_at: '2026-08-20T10:00:00Z',
    assets: [
      { name: 'notas.txt', browser_download_url: 'https://x/notas.txt' },
      { name: 'SALBUS-v4.4.0-b1010.apk', browser_download_url: 'https://x/app.apk' },
    ],
  }

  check('se elige el asset .apk y no otro adjunto',
    readRelease(release)?.apkUrl === 'https://x/app.apk')
  check('la release publicada aporta su versionCode',
    readRelease(release)?.versionCode === 1010)
  check('un borrador no se ofrece', readRelease({ ...release, draft: true }) === null)
  check('una release sin APK no se ofrece',
    readRelease({ ...release, assets: [{ name: 'n.txt', browser_download_url: 'https://x/n' }] }) === null)

  const parsed = readRelease(release)
  check('solo se ofrece un versionCode estrictamente mayor', isNewer(parsed, 1009) === true)
  check('un versionCode igual no se ofrece', isNewer(parsed, 1010) === false)
  check('un versionCode menor no se ofrece', isNewer(parsed, 1011) === false)

  const mainSourceForUpdates = await fs.readFile(
    path.join(projectRoot, 'src', 'main.ts'), 'utf8')

  // El plugin nativo y el permiso son la otra mitad: sin ellos la app
  // detectaria la actualizacion pero no podria instalarla.
  const manifest = await fs.readFile(
    path.join(projectRoot, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'),
    'utf8',
  )
  check('el manifiesto pide REQUEST_INSTALL_PACKAGES',
    manifest.includes('android.permission.REQUEST_INSTALL_PACKAGES'))
  check('el manifiesto declara el FileProvider que expone la APK',
    manifest.includes('.fileprovider'))

  const filePaths = await fs.readFile(
    path.join(projectRoot, 'android', 'app', 'src', 'main', 'res', 'xml', 'file_paths.xml'),
    'utf8',
  )
  check('el FileProvider cubre la cache, que es donde se descarga la APK',
    filePaths.includes('cache-path'))

  const mainActivity = await fs.readFile(
    path.join(projectRoot, 'android', 'app', 'src', 'main', 'java', 'com', 'icuas',
      'salbus', 'MainActivity.java'),
    'utf8',
  )
  check('UpdaterPlugin esta registrado en MainActivity',
    mainActivity.includes('registerPlugin(UpdaterPlugin.class)'))

  // La version instalada la dice el SISTEMA, no el numero incrustado en el
  // bundle: ese numero se congela si la WebView sirve una copia vieja de la
  // pagina, y con el la app se ofrecia a si misma lo que acababa de instalar.
  const updater = await fs.readFile(
    path.join(projectRoot, 'android', 'app', 'src', 'main', 'java', 'com', 'icuas',
      'salbus', 'UpdaterPlugin.java'),
    'utf8',
  )
  const updatesSource = await fs.readFile(
    path.join(projectRoot, 'src', 'services', 'updates.ts'), 'utf8')

  check('la version instalada se lee del sistema, no del bundle',
    updater.includes('public void currentVersion(PluginCall call)')
      && updatesSource.includes('await Updater.currentVersion()')
      && /const installed = await readInstalledVersion\(\)/.test(updatesSource))

  // Una descarga guardada solo vale para SU version: reutilizarla para otra
  // reinstalaba la anterior, y al abrir la app volvia a ofrecerse lo mismo.
  check('la descarga guardada dice a que compilacion pertenece',
    updater.includes('getPackageArchiveInfo')
      && updatesSource.includes('pendingUpdate(): Promise<{ ready: boolean, path: string | null } & VersionInfo>'))
  check('una descarga que no corresponde se tira en vez de instalarse',
    updater.includes('public void clearPending(PluginCall call)')
      && mainSourceForUpdates.includes('pending.versionCode === versionCode')
      && mainSourceForUpdates.includes('await Updater.clearPending()'))

  // Android no dice si una instalacion salio bien: la app se va al instalador y,
  // al volver, solo puede mirar que version hay. Sin dejar anotado que se
  // intento, una instalacion que no cuaja vuelve a ofrecerse en silencio, una y
  // otra vez: es asi como se llega a un bucle sin explicacion.
  const stateSourceForUpdates = await fs.readFile(
    path.join(projectRoot, 'src', 'state.ts'), 'utf8')

  check('queda anotado que compilacion se mando instalar',
    stateSourceForUpdates.includes('export function writeInstallAttempt(')
      && mainSourceForUpdates.includes('writeInstallAttempt(update.release.versionCode)'))
  check('una instalacion que no se completa se avisa, no se repite en silencio',
    mainSourceForUpdates.includes('function reviewInstallAttempt()')
      && mainSourceForUpdates.includes('La instalación anterior no llegó a completarse'))
  check('tras un intento fallido la descarga se rehace desde cero',
    /reviewInstallAttempt\(\)[\s\S]*?Updater\.clearPending\(\)/.test(mainSourceForUpdates))

  // El runner tiene que cumplir el requisito de Node del CLI de Capacitor. Con
  // una version por debajo, `cap sync` aborta antes de copiar nada y el build
  // falla sin haber llegado a Gradle.
  const workflow = await fs.readFile(
    path.join(projectRoot, '.github', 'workflows', 'release.yml'),
    'utf8',
  )
  const capacitorCli = JSON.parse(await fs.readFile(
    path.join(projectRoot, 'node_modules', '@capacitor', 'cli', 'package.json'),
    'utf8',
  ))

  const requiredNode = Number(/(\d+)/.exec(capacitorCli.engines?.node ?? "")?.[1] ?? 0)
  const workflowNode = Number(/node-version:\s*(\d+)/.exec(workflow)?.[1] ?? 0)

  check('el workflow usa una version de Node valida para el CLI de Capacitor',
    workflowNode >= requiredNode && requiredNode > 0,
    `workflow ${workflowNode} · Capacitor exige ${capacitorCli.engines?.node}`)
  check('el workflow clona la historia entera para poder contar los commits',
    workflow.includes('fetch-depth: 0'))

  /* ---------------------------------------------------------------- *
   * El nombre                                                          *
   * ---------------------------------------------------------------- */

  // build.gradle ya se leyo arriba, para las comprobaciones del versionCode.
  const capacitorConfig = await fs.readFile(
    path.join(projectRoot, 'capacitor.config.ts'), 'utf8')
  const pkg = JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8'))

  // El applicationId ES la identidad de la app instalada. Cambiarlo por
  // com.icuas.salbus dejaria a quien ya la tiene sin ruta de actualizacion y sin
  // sus paradas guardadas: se veria como una app distinta.
  check('el applicationId sigue siendo el de la app ya instalada',
    /applicationId "com\.icuas\.bussalamanca"/.test(gradle)
      && capacitorConfig.includes("appId: 'com.icuas.bussalamanca'"),
    'cambiarlo rompe la actualizacion de todo el mundo')

  // El resto del proyecto si se llama SALBUS.
  check('el codigo nativo vive en el paquete com.icuas.salbus',
    /namespace = "com\.icuas\.salbus"/.test(gradle)
      && mainActivity.includes('package com.icuas.salbus;'))
  check('el nombre de la app es SALBUS en todas partes',
    pkg.name === 'salbus'
      && capacitorConfig.includes("appName: 'SALBUS'")
      && (await fs.readFile(path.join(projectRoot, 'android', 'app', 'src', 'main', 'res',
        'values', 'strings.xml'), 'utf8')).includes('<string name="app_name">SALBUS</string>'))

  // Perder la clave de firma rompe el canal para siempre; publicarla es peor.
  const ignored = await fs.readFile(path.join(projectRoot, '.gitignore'), 'utf8')
  check('la clave de firma esta excluida de git',
    ignored.includes('*.jks') && ignored.includes('android/keystore.properties'))

  /* ---------------------------------------------------------------- *
   * 8 · Segundo plano y notificaciones                                 *
   * ---------------------------------------------------------------- */

  section('8 · Segundo plano y notificaciones')

  const style = await fs.readFile(path.join(projectRoot, 'src', 'style.css'), 'utf8')
  const zIndexOf = (selector) => {
    const block = new RegExp(`\\${selector}\\s*\\{[^}]*\\}`).exec(style)?.[0] ?? ''
    return Number(/z-index:\s*(\d+)/.exec(block)?.[1] ?? 0)
  }

  // La hoja de "Avisos" se abre DESDE la ficha de la parada (la que sale al
  // tocar una parada en el mapa): por debajo de ella no se ve.
  check('la hoja de avisos se dibuja por encima de la ficha de parada',
    zIndexOf('.sheet') > zIndexOf('.modal') && zIndexOf('.sheet-backdrop') > zIndexOf('.modal-backdrop'),
    `hoja ${zIndexOf('.sheet')} · ficha ${zIndexOf('.modal')}`)

  const service = await fs.readFile(
    path.join(projectRoot, 'android', 'app', 'src', 'main', 'java', 'com', 'icuas',
      'salbus', 'BusTrackingService.java'),
    'utf8',
  )

  // El aviso se queda en linea + tiempo (titulo) y direccion + hora (cuerpo).
  // Repetir la parada o el contador "Autobús 1 de 1" solo alargaba el texto.
  check('el aviso de proximo bus no repite datos en el cuerpo',
    !service.includes('private String progress(Job job)')
      && service.includes('private String body(Job job)'))
  check('el aviso lleva la hora de actualizacion en hh:mm',
    service.includes('new SimpleDateFormat("HH:mm"'))

  const mainSource = await fs.readFile(path.join(projectRoot, 'src', 'main.ts'), 'utf8')

  // El servicio ya publica su aviso de "completado": publicar otro desde la web
  // dejaba dos notificaciones identicas cada vez que pasaba el autobus.
  check('el cierre de un aviso no duplica la notificacion del servicio',
    /async function finishTracking\(id: string, alreadyNotified = false\)/.test(mainSource)
      && mainSource.includes('finishTracking(update.jobId, true)'))

  // Puntualidad en segundo plano: sin esto, medir exigia dejar la app delante
  // durante toda la franja.
  check('el servicio recibe tambien los controles de puntualidad',
    service.includes('EXTRA_MONITORS') && service.includes('private void applyMonitors('))
  check('la app manda los controles al servicio',
    /monitors: monitors\.map\(/.test(mainSource))
  check('el servicio mantiene el movil despierto dentro de la franja',
    service.includes('PowerManager.PARTIAL_WAKE_LOCK') && service.includes('acquireWakeLock()'))
  check('el servicio despierta solo al empezar la siguiente franja',
    service.includes('setAndAllowWhileIdle') && service.includes('ACTION_TICK'))
  check('el manifiesto concede el permiso de WakeLock',
    manifest.includes('android.permission.WAKE_LOCK'))

  // La deteccion nativa es un porte a mano de src/services/punctuality.ts: si
  // los numeros dejan de coincidir, la misma parada mediria distinto segun
  // quien la estuviera observando.
  const punctuality = await fs.readFile(
    path.join(projectRoot, 'src', 'services', 'punctuality.ts'), 'utf8')
  const constantOf = (source, name, pattern) => Number(pattern.exec(source)?.[1] ?? -1)

  check('el servicio se arma con los mismos minutos que la web',
    constantOf(service, 'ARM', /ARM_MINUTES = (\d+)/)
      === constantOf(punctuality, 'ARM', /ARM_MINUTES = (\d+)/))
  check('el salto que delata el paso es el mismo en las dos partes',
    constantOf(service, 'JUMP', /JUMP_MINUTES = (\d+)/)
      === constantOf(punctuality, 'JUMP', /JUMP_MINUTES = (\d+)/))
  check('las consultas seguidas sin ver la linea son las mismas',
    constantOf(service, 'MISS', /MISSING_STREAK_TO_PASS = (\d+)/)
      === constantOf(punctuality, 'MISS', /MISSING_STREAK = (\d+)/))

  // Los pasos se entregan y se borran de una vez: leerlos sin borrarlos los
  // contaria otra vez en el siguiente arranque.
  check('los pasos medidos se recogen una sola vez',
    service.includes('static JSONArray takePasses(Context context)')
      && mainSource.includes('await BusTracking.takePasses()'))
  check('con el servicio midiendo, la web no detecta pasos por su cuenta',
    mainSource.includes('if (nativeMonitorIds.has(monitor.id)) {'))

  // Entre franja y franja el servicio se apaga: un servicio dataSync tiene un
  // tope diario de horas en Android 15, y esperar despierto lo agotaria.
  const receiver = await fs.readFile(
    path.join(projectRoot, 'android', 'app', 'src', 'main', 'java', 'com', 'icuas',
      'salbus', 'BusTrackingReceiver.java'),
    'utf8',
  )
  check('el servicio se apaga entre franjas en lugar de esperar despierto',
    service.includes('stopForeground(Service.STOP_FOREGROUND_REMOVE)')
      && service.includes('private void goIdle()'))
  check('el despertador esta declarado en el manifiesto',
    manifest.includes('.BusTrackingReceiver')
      && manifest.includes('com.icuas.salbus.TRACKING_WAKE'))
  check('el despertador vuelve a programarse tras reiniciar el movil',
    receiver.includes('Intent.ACTION_BOOT_COMPLETED')
      && manifest.includes('android.intent.action.BOOT_COMPLETED'))
  check('las franjas sobreviven a que la app se cierre',
    service.includes('static String[] readStoredMonitors(Context context)')
      && service.includes('storeMonitors(this, incoming)'))

  /* ---------------------------------------------------------------- *
   * 9 · Mapas: cercanas y rutas (experimental)                         *
   * ---------------------------------------------------------------- */

  section('9 · Mapas: paradas cercanas y rutas')

  const routing = await import(pathToUrl(path.join(build, 'routing.js')))

  // Distancia conocida: la Plaza Mayor de Salamanca y la Catedral Nueva estan a
  // unos 400 m. Un error en la formula se ve enseguida con un caso real.
  {
    const plaza = { lat: 40.9650, lon: -5.6640 }
    const catedral = { lat: 40.9613, lon: -5.6647 }
    const meters = routing.distanceMeters(plaza, catedral)
    check('la distancia entre dos puntos conocidos es la real',
      meters > 380 && meters < 460, Math.round(meters) + ' m')
    check('la distancia de un punto a si mismo es cero',
      routing.distanceMeters(plaza, plaza) < 0.001)
  }

  // Red de juguete: una linea recta de cinco paradas separadas ~500 m, y una
  // segunda linea que la cruza. Con datos inventados el resultado esperado se
  // puede calcular a mano, que es lo que hace util la prueba.
  const stopAt = (id, index) => ({
    stopId: id,
    stopName: 'Parada ' + id,
    lat: 40.96 + index * 0.0045,
    lon: -5.66,
  })

  const lineA = {
    key: 'A|uno',
    slot: 'uno',
    way: 'ida',
    partial: false,
    circular: false,
    label: 'A1 > A5',
    origin: 'A1',
    destination: 'Norte',
    stopCount: 5,
    stops: ['A1', 'A2', 'A3', 'A4', 'A5'].map(stopAt),
  }

  // Cruza en A3 y se aleja hacia el este.
  const lineB = {
    key: 'B|uno',
    slot: 'uno',
    way: 'ida',
    partial: false,
    circular: false,
    label: 'A3 > B3',
    origin: 'A3',
    destination: 'Este',
    stopCount: 3,
    stops: [
      lineA.stops[2],
      { stopId: 'B2', stopName: 'Parada B2', lat: 40.969, lon: -5.6535 },
      { stopId: 'B3', stopName: 'Parada B3', lat: 40.969, lon: -5.647 },
    ],
  }

  const fixedWait = () => 5

  {
    // De la primera parada a la ultima de la misma linea: sin transbordos.
    const plan = routing.planRoute({
      origin: lineA.stops[0],
      destination: lineA.stops[4],
      originName: 'Origen',
      destinationName: 'Destino',
      directions: [lineA, lineB],
      waitMinutes: fixedWait,
    })

    check('encuentra la ruta directa de una sola linea',
      plan.status === 'ok' && plan.best.transfers === 0
        && plan.best.legs.filter((leg) => leg.kind === 'bus').length === 1,
      plan.status)

    const bus = plan.status === 'ok' ? plan.best.legs.find((leg) => leg.kind === 'bus') : null
    check('el tramo en autobus va de la parada de subida a la de bajada',
      bus?.from.stopId === 'A1' && bus?.to.stopId === 'A5' && bus?.stops.length === 5)

    // Origen y destino SON paradas: no debe colarse ningun paseo de cero metros.
    check('no aparecen paseos de cero metros',
      plan.status === 'ok'
        && plan.best.legs.every((leg) => leg.kind !== 'walk' || leg.meters >= 30))
  }

  {
    // Cruzando de la linea A a la B: obliga a un transbordo en A3.
    const plan = routing.planRoute({
      origin: lineA.stops[0],
      destination: lineB.stops[2],
      originName: 'Origen',
      destinationName: 'Destino',
      directions: [lineA, lineB],
      waitMinutes: fixedWait,
    })

    check('resuelve una ruta con transbordo',
      plan.status === 'ok' && plan.best.transfers === 1, plan.status)

    const lines = plan.status === 'ok'
      ? plan.best.legs.filter((leg) => leg.kind === 'bus').map((leg) => leg.lineId)
      : []
    check('usa las dos lineas en el orden correcto',
      lines.join('-') === 'A-B', lines.join('-'))
  }

  {
    // Dos puntos pegados: proponer un autobus para cruzar la calle es absurdo.
    const plan = routing.planRoute({
      origin: { lat: 40.96, lon: -5.66 },
      destination: { lat: 40.9615, lon: -5.66 },
      originName: 'Origen',
      destinationName: 'Destino',
      directions: [lineA, lineB],
      waitMinutes: fixedWait,
    })
    check('para dos manzanas propone ir andando', plan.status === 'walk', plan.status)
  }

  {
    // Un destino en mitad del campo, sin ninguna parada cerca.
    const plan = routing.planRoute({
      origin: lineA.stops[0],
      destination: { lat: 41.5, lon: -5.0 },
      originName: 'Origen',
      destinationName: 'Destino',
      directions: [lineA, lineB],
      waitMinutes: fixedWait,
    })
    check('dice claramente que no se puede llegar', plan.status === 'unreachable', plan.status)
  }

  {
    // La espera se inyecta: el modulo no puede inventarsela.
    const conWait = (minutes) => routing.planRoute({
      origin: lineA.stops[0],
      destination: lineA.stops[4],
      originName: 'Origen',
      destinationName: 'Destino',
      directions: [lineA, lineB],
      waitMinutes: () => minutes,
    })

    const corta = conWait(2)
    const larga = conWait(20)
    check('la espera en parada cuenta en el total',
      corta.status === 'ok' && larga.status === 'ok'
        && Math.round(larga.best.totalMinutes - corta.best.totalMinutes) === 18,
      corta.status === 'ok' && larga.status === 'ok'
        ? Math.round(larga.best.totalMinutes - corta.best.totalMinutes) + ' min'
        : 'sin ruta')
  }

  // Paradas cercanas: orden y corte por distancia.
  {
    const here = { lat: 40.96, lon: -5.66 }
    const nearby = routing.nearestStops(here, lineA.stops, 3, 900)
    check('las paradas cercanas salen de menor a mayor distancia',
      nearby.length === 2 && nearby[0].stop.stopId === 'A1' && nearby[1].stop.stopId === 'A2',
      nearby.map((n) => n.stop.stopId).join(','))
    check('una parada lejana no se cuela entre las cercanas',
      nearby.every((entry) => entry.meters <= 900))
    check('cada parada cercana trae su tiempo andando',
      nearby[0].minutes >= 0 && nearby[1].minutes > nearby[0].minutes)
  }

  // La red REAL: es la prueba que de verdad protege, porque el calculo corre
  // sobre 80 sentidos y 349 paradas, no sobre el juguete de arriba.
  {
    const payload = JSON.parse(
      await fs.readFile(path.join(projectRoot, 'public', 'data', 'network.json'), 'utf8'),
    )
    const realDirections = payload.lines.flatMap((line) => line.directions)
    const from = payload.stopsById['309']
    const to = payload.stopsById['326']

    const started = Date.now()
    const plan = routing.planRoute({
      origin: from,
      destination: to,
      originName: from.stopName,
      destinationName: to.stopName,
      directions: realDirections,
    })
    const elapsed = Date.now() - started

    check('cruza la ciudad real de punta a punta',
      plan.status === 'ok' && plan.best.legs.some((leg) => leg.kind === 'bus'), plan.status)
    check('el calculo sobre la red real es instantaneo',
      elapsed < 1500, elapsed + ' ms')

    if (plan.status === 'ok') {
      const signature = (itinerary) => itinerary.legs
        .filter((leg) => leg.kind === 'bus')
        .map((leg) => leg.lineId)
        .join('-')

      check('las alternativas no repiten la ruta recomendada',
        plan.alternatives.every((alt) => signature(alt) !== signature(plan.best)))
      check('no hay dos tramos a pie seguidos',
        plan.best.legs.every((leg, index) =>
          !(leg.kind === 'walk' && plan.best.legs[index + 1]?.kind === 'walk')))
      check('el total es la suma de sus partes',
        Math.abs(plan.best.totalMinutes
          - (plan.best.walkMinutes + plan.best.rideMinutes + plan.best.waitMinutes)) < 0.001)
    }
  }

  // La pestana es experimental: apagada no puede existir ni dejar rastro.
  {
    const stateSource = await fs.readFile(path.join(projectRoot, 'src', 'state.ts'), 'utf8')
    const viewsSource = await fs.readFile(path.join(projectRoot, 'src', 'views.ts'), 'utf8')
    const mainSource = await fs.readFile(path.join(projectRoot, 'src', 'main.ts'), 'utf8')

    check('la pestana Mapas viene apagada de fabrica',
      /experimentalMaps: false/.test(stateSource))
    check('apagada no aparece en la barra de pestanas',
      viewsSource.includes('if (!state.settings.experimentalMaps)')
        && viewsSource.includes('function visibleTabs()'))
    check('una pestana Mapas guardada no revive al arrancar',
      /const valid: TabId\[\] = \['inicio', 'buscar', 'monitor', 'seguimiento', 'ajustes'\]/
        .test(stateSource))
    check('al salir de la pestana se suelta el mapa y la ubicacion',
      mainSource.includes('function closeMaps()')
        && mainSource.includes("if (previous === 'mapas' && tab !== 'mapas')")
        && mainSource.includes('function stopWatchingLocation()'))
    check('el manifiesto pide los permisos de ubicacion',
      manifest.includes('android.permission.ACCESS_COARSE_LOCATION')
        && manifest.includes('android.permission.ACCESS_FINE_LOCATION'))

    // La ubicacion se pide por partida doble: una lectura suelta que llega
    // enseguida y un seguimiento que la afina. Solo con el seguimiento, la
    // primera posicion puede no llegar nunca y la pantalla se queda "buscando".
    check('la ubicacion se pide con lectura rapida Y seguimiento',
      mainSource.includes('navigator.geolocation.getCurrentPosition(acceptPosition')
        && mainSource.includes('navigator.geolocation.watchPosition(acceptPosition'))
    check('una posicion peor no pisa a una mejor',
      mainSource.includes('accuracy <= known.accuracy'))
    // Tocar "Mi ubicacion" antes de que el sistema sepa donde estas dejaba el
    // buscador abierto sin hacer nada: habia que volver a tocarlo a ciegas.
    check('"Mi ubicacion" rellena el campo en cuanto llega la posicion',
      mainSource.includes('let pendingLocationField')
        && mainSource.includes('pendingLocationField && state.maps.picking === pendingLocationField'))
  }

  // Solo se consulta la parada desplegada: pedir las diez guardadas dejaba sin
  // turno al aviso de proximo bus contra una fuente que limita por IP.
  check('en Inicio solo se actualiza la parada desplegada',
    /if \(state\.tab === 'inicio' && state\.expandedStopId\) \{/.test(mainSourceForUpdates)
      && !/for \(const favourite of state\.favourites\) \{\s*\n\s*add\(favourite\.stopId/
        .test(mainSourceForUpdates))

  console.log(`\n${passed} correctas · ${failed} fallidas`)
  process.exitCode = failed > 0 ? 1 : 0
}

/* ------------------------------------------------------------------ *
 * Utilidades de la prueba                                              *
 * ------------------------------------------------------------------ */

/** Compila modulos de `src/services` a JavaScript para poder importarlos aqui. */
async function compileSources(files) {
  // Dentro del proyecto: desde el temporal del sistema, Node no encontraría
  // 'jszip' ni 'papaparse' al resolver los import del módulo compilado.
  const outDir = path.join(projectRoot, 'node_modules', '.salbus-selftest')
  await fs.rm(outDir, { recursive: true, force: true })

  // Se invoca el compilador por su script de Node: en Windows, lanzar el .cmd
  // desde execFile falla con EINVAL.
  await run(
    process.execPath,
    [
      path.join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      ...files.map((file) => path.join('src', 'services', file)),
      '--outDir', outDir,
      '--module', 'esnext',
      '--target', 'es2022',
      '--moduleResolution', 'bundler',
      '--skipLibCheck',
    ],
    { cwd: projectRoot },
  )

  // El compilador conserva la estructura de carpetas del codigo fuente.
  return path.join(outDir, 'services')
}

function pathToUrl(filePath) {
  return `file:///${filePath.replace(/\\/g, '/')}`
}

/** Servidor minimo para poder cargar el GTFS con `fetch`, como hace la app. */
async function serveDirectory(root) {
  const server = http.createServer(async (request, response) => {
    try {
      const file = path.join(root, decodeURIComponent(new URL(request.url, 'http://x').pathname))
      response.writeHead(200)
      response.end(await fs.readFile(file))
    } catch {
      response.writeHead(404)
      response.end()
    }
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

await main()
