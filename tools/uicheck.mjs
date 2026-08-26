/**
 * Utilidad de desarrollo: abre la app en Chrome headless mediante el protocolo
 * DevTools para hacer capturas y comprobar la maquetacion en distintos tamanos.
 *
 * Uso:
 *   node tools/uicheck.mjs                       # captura todas las pantallas
 *   node tools/uicheck.mjs --overflow            # informa de desbordes horizontales
 *   node tools/uicheck.mjs --stability           # comprueba que el refresco no destruye la interfaz
 *   node tools/uicheck.mjs --url http://...      # otra direccion
 *   node tools/uicheck.mjs --wait 30000          # mas margen para el arranque
 *   node tools/uicheck.mjs --maps                # enciende la pestana experimental
 */

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
]

const require = createRequire(import.meta.url)
/** El tour se abre una vez por version: sin darlo por visto taparia cada captura. */
const appVersion = `v${require('../package.json').version}`

const args = process.argv.slice(2)
const url = valueOf('--url') ?? 'http://localhost:5177/'
const outDir = valueOf('--out') ?? path.join(os.tmpdir(), 'salbus-ui')
const width = Number.parseInt(valueOf('--width') ?? '412', 10)
const height = Number.parseInt(valueOf('--height') ?? '915', 10)
const onlyOverflow = args.includes('--overflow')
/** Espera tras cargar la pagina. El GTFS son 4,8 MB y en una maquina lenta no
    da tiempo a que la app termine de arrancar antes de la captura. */
const waitMs = Number.parseInt(valueOf('--wait') ?? '', 10)
const checkStability = args.includes('--stability')
/** La pestana Mapas viene apagada de fabrica, asi que hay que pedirla a mano. */
const withMaps = args.includes('--maps')

function valueOf(flag) {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

async function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    try {
      await fs.access(candidate)
      return candidate
    } catch {
      /* siguiente */
    }
  }
  throw new Error('No se encontro Chrome ni Edge.')
}

class Cdp {
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      const resolver = this.pending.get(message.id)
      if (resolver) {
        this.pending.delete(message.id)
        message.error ? resolver.reject(new Error(message.error.message)) : resolver.resolve(message.result)
      }
    })
  }

  send(method, params = {}) {
    const id = this.nextId++
    this.socket.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? 'error de evaluación')
    }
    return result.result.value
  }
}

async function main() {
  const chrome = await findChrome()
  const port = 9333
  const profile = path.join(os.tmpdir(), `salbus-cdp-${Date.now()}`)
  await fs.mkdir(outDir, { recursive: true })

  const child = spawn(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      `--window-size=${width},${height}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  try {
    const target = await waitForTarget(port)
    const socket = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true })
      socket.addEventListener('error', reject, { once: true })
    })

    const cdp = new Cdp(socket)
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 2,
      mobile: true,
    })

    if (args.includes('--seed')) {
      // Paradas reales muy transitadas, para ver la interfaz con datos de
      // verdad. La 350 esta ahi por su nombre: es el mas largo de la red
      // ("C/ Licenciado Vidriera, s/n (Frente residencia)", 47 caracteres) y
      // solo se distingue de la 344 por el final, asi que es el caso que dice
      // si la tarjeta esta recortando nombres.
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `
          localStorage.setItem('salbus.tourVersion', '${appVersion}');
          // Tres autobuses por aviso. No es un capricho: con el ajuste por
          // defecto (uno) el aviso sembrado TERMINA solo en cuanto pasa el
          // primer autobus, y la captura se encontraba la tarjeta ya retirada.
          localStorage.setItem('salbus.settings', JSON.stringify({
            vibrateOnApproach: true, trackingBusTarget: 3,
            experimentalMaps: ${withMaps ? 'true' : 'false'}
          }));
          localStorage.setItem('salbus.favourites', JSON.stringify([
            { stopId: '222', alias: null, addedAt: Date.now() },
            { stopId: '301', alias: 'Casa', addedAt: Date.now() },
            { stopId: '36', alias: null, addedAt: Date.now() },
            { stopId: '350', alias: null, addedAt: Date.now() },
            { stopId: '344', alias: 'Trabajo', addedAt: Date.now() }
          ]));
          // Dos avisos, uno activo y otro en pausa: es el tope, y ensena de una
          // vez la tarjeta trabajando (con su recorrido y su recuento de
          // paradas) y la de reposo. La 222 con la linea 4 tiene un solo
          // sentido completo, asi que el sentido se resuelve sin ambiguedad.
          localStorage.setItem('salbus.trackings', JSON.stringify([
            { id: '222|4', stopId: '222', stopName: 'C/ Gran Vía, 38', lineId: '4',
              directionKey: '4|dos', active: true, startedAt: Date.now(),
              lastMinutes: null, lastNotifiedAt: 0, armed: false, missingStreak: 0,
              busesSeen: 0, warnedAt3: false },
            { id: '301|4', stopId: '301', stopName: 'C/ Gran Vía, 45', lineId: '4',
              directionKey: '4|uno', active: false, startedAt: Date.now() - 60000,
              lastMinutes: null, lastNotifiedAt: 0, armed: false, missingStreak: 0,
              busesSeen: 0, warnedAt3: false }
          ]));
          localStorage.setItem('salbus.monitors', JSON.stringify([
            { id: '222|4|4|dos|420|480', stopId: '222', stopName: 'C/ Gran Vía, 38',
              lineId: '4', directionKey: '4|dos', startMinutes: 420, endMinutes: 480,
              createdAt: Date.now() }
          ]));

          // Pasos ya observados, para ver la tabla de puntualidad con datos.
          const day = (offset) => {
            const date = new Date();
            date.setDate(date.getDate() - offset);
            return date;
          };
          const key = (date) => date.getFullYear() + '-' +
            String(date.getMonth() + 1).padStart(2, '0') + '-' +
            String(date.getDate()).padStart(2, '0');
          const pass = (offset, slot, minutes) => {
            const date = day(offset);
            date.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
            return {
              at: date.getTime(), date: key(date), dayType: 'weekday', minutes,
              slot, delta: slot ? minutes - (Number(slot.slice(0, 2)) * 60 + Number(slot.slice(3))) : null,
              reason: 'jump'
            };
          };
          localStorage.setItem('salbus.monitorPasses', JSON.stringify({
            '222|4|4|dos|420|480': [
              pass(7, '07:15', 437), pass(7, '07:25', 446), pass(7, '07:32', 455),
              pass(4, '07:15', 438), pass(4, '07:25', 444), pass(4, '07:42', 463),
              pass(1, '07:15', 435), pass(1, '07:25', 447), pass(1, null, 470)
            ]
          }));
        `,
      })
    }

    await cdp.send('Page.navigate', { url })
    // Margen para el splash (1,5 s) y para que la cola de peticiones traiga datos.
    await delay(Number.isFinite(waitMs) ? waitMs : args.includes('--seed') ? 16000 : 3500)

    const screens = [
      { tab: 'inicio', name: 'inicio' },
      { tab: 'buscar', name: 'buscar' },
      { tab: 'seguimiento', name: 'seguimiento' },
      { tab: 'monitor', name: 'puntualidad' },
      { tab: 'ajustes', name: 'ajustes' },
    ]

    if (withMaps) {
      // Va antes de Ajustes en la barra, pero se captura al final: entrar en
      // ella pide la ubicacion, y el dialogo del permiso taparia lo demas.
      screens.splice(screens.length - 1, 0, { tab: 'mapas', name: 'mapas' })
    }

    for (const screen of screens) {
      await cdp.evaluate(
        `document.querySelector('[data-action="tab"][data-tab="${screen.tab}"]')?.click(); true`,
      )
      await delay(700)

      const overflow = await cdp.evaluate(`(() => {
        const vw = document.documentElement.clientWidth;
        const offenders = [];
        for (const el of document.querySelectorAll('*')) {
          const r = el.getBoundingClientRect();
          if (r.width > vw + 1 || r.right > vw + 1) {
            offenders.push(el.tagName.toLowerCase() + '.' + String(el.getAttribute('class') || '').split(' ')[0] +
              ' w=' + Math.round(r.width) + ' right=' + Math.round(r.right));
          }
        }
        return JSON.stringify({
          vw,
          docWidth: document.documentElement.scrollWidth,
          offenders: offenders.slice(0, 12)
        });
      })()`)

      const report = JSON.parse(overflow)
      const status = report.docWidth <= report.vw + 1 ? 'ok  ' : 'WIDE'
      console.log(`${status} ${screen.name.padEnd(13)} vw=${report.vw} doc=${report.docWidth}`)
      for (const offender of report.offenders) {
        console.log(`       ↳ ${offender}`)
      }

      if (!onlyOverflow) {
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
        await fs.writeFile(path.join(outDir, `${screen.name}.png`), Buffer.from(shot.data, 'base64'))
      }
    }

    if (!onlyOverflow) {
      console.log(`\nCapturas en ${outDir}`)
    }

    if (checkStability) {
      console.log('\nEstabilidad del refresco (el repintado no debe destruir la interfaz)')

      // Pantalla con desplegables reales.
      await cdp.evaluate(`document.querySelector('[data-action="tab"][data-tab="buscar"]')?.click(); true`)
      await delay(400)
      await cdp.evaluate(`document.querySelector('[data-action="search-mode"][data-mode="linea"]')?.click(); true`)
      await delay(600)

      await cdp.evaluate(`(() => {
        const sel = document.querySelector('[data-action="pick-search-line"]');
        sel.value = sel.options[1].value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`)
      await delay(700)

      await cdp.evaluate(`(() => {
        window.__sel = document.querySelector('select.select');
        window.__selValue = window.__sel ? window.__sel.value : null;
        window.__card = document.querySelector('.card');
        return true;
      })()`)

      // Cuatro ciclos de refresco: mas que de sobra para que el fallo aparezca.
      await delay(4000)

      const stable = JSON.parse(await cdp.evaluate(`(() => JSON.stringify({
        sameSelect: window.__sel === document.querySelector('select.select'),
        connected: Boolean(window.__sel && window.__sel.isConnected),
        sameValue: window.__sel ? window.__sel.value === window.__selValue : false,
        sameCard: window.__card === document.querySelector('.card')
      }))()`))

      report('el desplegable sobrevive al refresco automático', stable.sameSelect && stable.connected)
      report('el desplegable conserva su valor', stable.sameValue)
      report('las tarjetas no se recrean en cada refresco', stable.sameCard)

      // Escritura en el buscador: foco y cursor deben sobrevivir.
      await cdp.evaluate(`document.querySelector('[data-action="search-mode"][data-mode="nombre"]')?.click(); true`)
      await delay(600)
      await cdp.evaluate(`(() => {
        const input = document.querySelector('#stop-query');
        input.focus();
        input.value = 'gran';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.setSelectionRange(2, 2);
        return true;
      })()`)

      await delay(3000)

      const typing = JSON.parse(await cdp.evaluate(`(() => {
        const input = document.querySelector('#stop-query');
        return JSON.stringify({
          focused: document.activeElement === input,
          value: input.value,
          caret: input.selectionStart
        });
      })()`))

      // El mapa lo pinta Leaflet dentro del DOM: el repintado no debe tocarlo.
      await cdp.evaluate(`document.querySelector('[data-action="search-mode"][data-mode="mapa"]')?.click(); true`)
      await delay(2500)

      // Sin linea ni sentido elegidos el mapa NO se queda vacio: enseña las 349
      // paradas de la red para poder tocar directamente la que se busca.
      const allStops = JSON.parse(await cdp.evaluate(`(() => JSON.stringify({
        pins: document.querySelectorAll('#stop-map .map-pin').length,
        plain: document.querySelectorAll('#stop-map .map-pin.is-plain').length,
        lines: document.querySelectorAll('#stop-map path.leaflet-interactive').length
      }))()`))

      report('sin linea elegida el mapa enseña toda la red', allStops.pins > 300,
        `${allStops.pins} chinchetas`)
      report('esas chinchetas van sin numero de orden', allStops.plain === allStops.pins)
      report('sin recorrido elegido no se traza ninguna linea', allStops.lines === 0)

      await cdp.evaluate(`(() => {
        const select = document.querySelector('[data-action="pick-search-direction"]');
        select.value = select.options[1].value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`)
      await delay(1200)

      await cdp.evaluate(`(() => { window.__map = document.querySelector('#stop-map'); return true; })()`)
      await delay(4000)

      const leaflet = JSON.parse(await cdp.evaluate(`(() => {
        const el = document.querySelector('#stop-map');
        return JSON.stringify({
          same: window.__map === el,
          leafletClass: Boolean(el && el.classList.contains('leaflet-container')),
          tiles: document.querySelectorAll('#stop-map img.leaflet-tile').length,
          route: document.querySelectorAll('#stop-map path.leaflet-interactive').length,
          pins: document.querySelectorAll('#stop-map .map-pin').length
        });
      })()`))

      report('el contenedor del mapa no se recrea', leaflet.same)
      report('Leaflet conserva sus clases en el contenedor', leaflet.leafletClass)
      report('el mapa mantiene sus teselas y su trazado', leaflet.tiles > 0 && leaflet.route > 0,
        `teselas ${leaflet.tiles} · trazado ${leaflet.route}`)
      report('las paradas se dibujan con chinchetas visibles', leaflet.pins > 0, `chinchetas ${leaflet.pins}`)

      // El mapa a pantalla completa reutiliza el MISMO nodo: si se recreara,
      // Leaflet perderia teselas y marcadores en cada apertura.
      await cdp.evaluate(`(() => {
        window.__mapBefore = document.querySelector('#stop-map');
        const select = document.querySelector('[data-action="pick-search-direction"]');
        select.value = select.options[1].value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`)
      await delay(1200)

      const full = JSON.parse(await cdp.evaluate(`(() => {
        const shell = document.querySelector('.map-shell');
        const node = document.querySelector('#stop-map');
        const rect = shell ? shell.getBoundingClientRect() : null;
        return JSON.stringify({
          expanded: Boolean(shell && shell.classList.contains('is-expanded')),
          sameNode: window.__mapBefore === node,
          coversViewport: Boolean(rect && rect.height > window.innerHeight - 4),
          hasClose: Boolean(document.querySelector('[data-action="collapse-map"]')),
          tiles: document.querySelectorAll('#stop-map img.leaflet-tile').length
        });
      })()`))

      report('elegir sentido abre el mapa a pantalla completa', full.expanded)
      report('el mapa a pantalla completa no reconstruye Leaflet', full.sameNode && full.tiles > 0,
        `teselas ${full.tiles}`)
      report('el mapa ampliado ocupa toda la pantalla', full.coversViewport)
      report('el mapa ampliado ofrece un botón de cierre', full.hasClose)

      // El globo de la parada: nombre y lineas, sin salir del mapa.
      await cdp.evaluate(`document.querySelector('#stop-map .map-pin')?.closest('.leaflet-marker-icon')?.click(); true`)
      await delay(700)

      const popup = JSON.parse(await cdp.evaluate(`(() => {
        const body = document.querySelector('.map-popup-body');
        return JSON.stringify({
          open: Boolean(body),
          name: body ? (body.querySelector('.map-popup-name')?.textContent || '').trim() : '',
          lines: body ? body.querySelectorAll('.line-chip').length : 0
        });
      })()`))

      report('pulsar una parada abre su ficha emergente', popup.open)
      report('la ficha emergente muestra el nombre de la parada', popup.name.length > 0, popup.name)
      report('la ficha emergente muestra las líneas de la parada', popup.lines > 0, `líneas ${popup.lines}`)

      await cdp.evaluate(`document.querySelector('[data-action="collapse-map"]')?.click(); true`)
      await delay(600)

      const collapsed = await cdp.evaluate(
        `Boolean(document.querySelector('.map-shell') && !document.querySelector('.map-shell').classList.contains('is-expanded'))`,
      )
      report('el botón de cierre devuelve el mapa a su tamaño', collapsed)

      report('el cuadro de búsqueda mantiene el foco', typing.focused)
      report('mantiene el texto escrito', typing.value === 'gran', typing.value)
      report('mantiene la posición del cursor', typing.caret === 2, String(typing.caret))
    }

    socket.close()
  } finally {
    child.kill()
  }
}

function report(label, condition, detail = '') {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}${detail && !condition ? ` — ${detail}` : ''}`)
  if (!condition) {
    process.exitCode = 1
  }
}

async function waitForTarget(port) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      const targets = await response.json()
      const page = targets.find((item) => item.type === 'page')
      if (page?.webSocketDebuggerUrl) {
        return page
      }
    } catch {
      /* aun arrancando */
    }
    await delay(250)
  }
  throw new Error('Chrome no expuso el puerto de depuración.')
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

await main()
