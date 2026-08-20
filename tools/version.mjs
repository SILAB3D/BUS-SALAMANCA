/**
 * Version de la aplicacion, derivada de git y de package.json.
 *
 * La MISMA formula vive en android/app/build.gradle. Tiene que ser identica: la
 * app compara su propio versionCode con el de la ultima release publicada, y si
 * los dos numeros no se calculan igual, o se ofrece una actualizacion que ya
 * esta instalada, o no se ofrece ninguna nunca.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Las versiones anteriores a la publicacion automatica llegaron a mano hasta el
 * 430, muy por encima del numero de commits. Sin esta base la primera release
 * automatica saldria por debajo de lo ya instalado y Android no la aceptaria.
 */
export const VERSION_CODE_BASE = 1000

export function commitCount() {
  try {
    return Number.parseInt(
      execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      10,
    )
  } catch {
    // Sin git (compilando desde un zip) la version sale como la base.
    return 0
  }
}

export function resolveVersion() {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const count = commitCount()

  return {
    versionName: pkg.version,
    versionCode: VERSION_CODE_BASE + (Number.isFinite(count) ? count : 0),
    /** Etiqueta de la release; de ella saca la app el versionCode publicado. */
    tag: `v${pkg.version}-b${VERSION_CODE_BASE + (Number.isFinite(count) ? count : 0)}`,
  }
}
