/**
 * Registrador de puntualidad en vivo, fuera de la app.
 *
 * Consulta la fuente oficial con la misma cadencia y el mismo parser que SALBUS,
 * pasa cada observacion por la MISMA logica de deteccion de pasos
 * (`src/services/punctuality.ts`) y escribe lo que ocurre. Sirve para comprobar
 * sobre la calle, y no solo con datos sinteticos, que la medicion funciona.
 *
 * Uso:
 *   node tools/punctuality-live.mjs --stop 222 --line 4
 *   node tools/punctuality-live.mjs --stop 222 --line 4 --minutes 90 --interval 30
 *
 * Salida: una linea por consulta en la consola y un JSON con todo lo observado
 * en `--out` (por defecto `tools/.punctuality-live.json`).
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')

const args = process.argv.slice(2)
const stopId = valueOf('--stop') ?? '222'
const lineId = valueOf('--line') ?? '4'
const directionKey = valueOf('--direction') ?? null
const intervalMs = Number.parseInt(valueOf('--interval') ?? '30', 10) * 1000
const durationMs = Number.parseInt(valueOf('--minutes') ?? '90', 10) * 60_000
const outFile = valueOf('--out') ?? path.join(__dirname, '.punctuality-live.json')

const USER_AGENT =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'

function valueOf(flag) {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

function clock(at = Date.now()) {
  return new Date(at).toLocaleTimeString('es-ES', { hour12: false })
}

/** Compila los modulos reales de la app para poder usarlos desde Node. */
async function compileSources(files) {
  const outDir = path.join(projectRoot, 'node_modules', '.salbus-live')
  await fs.rm(outDir, { recursive: true, force: true })

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

  return path.join(outDir, 'services')
}

function pathToUrl(filePath) {
  return `file:///${filePath.replace(/\\/g, '/')}`
}

/** El horario se carga con `fetch`, igual que en la app. */
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

const build = await compileSources(['arrival-parser.ts', 'punctuality.ts', 'network.ts', 'schedule.ts'])
const { parseStopFeed } = await import(pathToUrl(path.join(build, 'arrival-parser.js')))
const { observe, matchSlot, minutesToClock } = await import(pathToUrl(path.join(build, 'punctuality.js')))
const { buildNetwork } = await import(pathToUrl(path.join(build, 'network.js')))
const { loadSchedule, currentDayType } = await import(pathToUrl(path.join(build, 'schedule.js')))

const server = await serveDirectory(path.join(projectRoot, 'public'))
const network = buildNetwork(
  JSON.parse(await fs.readFile(path.join(projectRoot, 'public', 'data', 'network.json'), 'utf8')),
)
const schedule = await loadSchedule(network, `${server.origin}/data/gtfs.zip`)
await server.close()

const dayType = currentDayType()
const slots = schedule.getScheduledTimes(stopId, lineId, dayType, directionKey)
const stopName = network.stopById.get(stopId)?.stopName ?? `parada ${stopId}`

console.log(`SALBUS · registrador de puntualidad en vivo`)
console.log(`  parada     ${stopId} · ${stopName}`)
console.log(`  linea      ${lineId}${directionKey ? ` · sentido ${directionKey}` : ' · todos los sentidos'}`)
console.log(`  cadencia   ${intervalMs / 1000} s durante ${durationMs / 60_000} min`)
console.log(`  horario    ${slots.length} salidas programadas hoy (${dayType})`)
console.log(`  archivo    ${outFile}`)
console.log('')

const startedAt = Date.now()
const observations = []
const passes = []
let runtime

while (Date.now() - startedAt < durationMs) {
  const at = Date.now()
  let feed = null

  try {
    const response = await fetch(
      `https://salamancadetransportes.com/tiempos-de-llegada/?ref=${encodeURIComponent(stopId)}`,
      { headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' } },
    )

    feed = response.status === 429
      ? { status: 'throttled', arrivals: [] }
      : parseStopFeed(stopId, await response.text())
  } catch (error) {
    feed = { status: 'error', arrivals: [], message: String(error) }
  }

  // Igual que la app: un 429 o un error de red no son observaciones de la parada.
  if (feed.status === 'ok' || feed.status === 'empty') {
    const arrival = feed.arrivals.filter((item) => item.lineId === lineId).sort(
      (left, right) => left.minutesUntil - right.minutesUntil,
    )[0]

    const minutes = arrival ? arrival.minutesUntil : null
    const detection = observe(runtime, { minutes, at })
    runtime = detection.runtime

    observations.push({ at, minutes, armed: runtime.armed, status: feed.status })

    const others = feed.arrivals
      .filter((item) => item.lineId !== lineId)
      .slice(0, 4)
      .map((item) => `L${item.lineId}:${item.minutesUntil}`)
      .join(' ')

    let note = ''

    if (detection.passAt !== null) {
      const passDate = new Date(detection.passAt)
      const observedMinutes = passDate.getHours() * 60 + passDate.getMinutes()
      const match = matchSlot(observedMinutes, slots)

      passes.push({
        at: detection.passAt,
        clock: minutesToClock(observedMinutes),
        reason: detection.reason,
        slot: match.slot,
        delta: match.delta,
      })

      note = `  ◄ PASO ${clock(detection.passAt)} (${detection.reason})${
        match.slot
          ? ` · programado ${match.slot} · ${match.delta > 0 ? '+' : ''}${match.delta} min`
          : ' · sin salida programada cerca'
      }`
    }

    console.log(
      `${clock(at)}  L${lineId} ${minutes === null ? '  —' : String(minutes).padStart(3)} min` +
        `${runtime.armed ? ' [entrando]' : '          '}  ${others}${note}`,
    )
  } else {
    console.log(`${clock(at)}  (${feed.status})`)
  }

  await fs.writeFile(
    outFile,
    JSON.stringify({ stopId, stopName, lineId, directionKey, dayType, slots, observations, passes }, null, 2),
  )

  const elapsed = Date.now() - at
  await new Promise((resolve) => setTimeout(resolve, Math.max(2000, intervalMs - elapsed)))
}

console.log('')
console.log(`Fin. ${observations.length} consultas · ${passes.length} pasos detectados.`)
for (const pass of passes) {
  console.log(
    `  ${pass.clock}  ${pass.slot ? `programado ${pass.slot} · ${pass.delta > 0 ? '+' : ''}${pass.delta} min` : 'sin salida programada cerca'} (${pass.reason})`,
  )
}
