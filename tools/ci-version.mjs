/**
 * Publica la version calculada como salidas del paso de GitHub Actions.
 *
 * Vive en un fichero y no en un `node -e` dentro del YAML para poder ejecutarlo
 * en local exactamente igual que en CI, que es la unica forma de comprobar sin
 * empujar un commit que el numero que saldra es el que se espera.
 */

import { appendFileSync } from 'node:fs'

import { resolveVersion } from './version.mjs'

const version = resolveVersion()
const apkName = `SALBUS-v${version.versionName}-b${version.versionCode}.apk`

const lines = [
  `versionName=${version.versionName}`,
  `versionCode=${version.versionCode}`,
  `tag=${version.tag}`,
  `apkName=${apkName}`,
]

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`)
  console.log(`::notice::Versión ${version.versionName}, compilación ${version.versionCode}, etiqueta ${version.tag}`)
} else {
  // Ejecutado a mano: se enseña lo mismo que veria el workflow.
  console.log(lines.join('\n'))
}
