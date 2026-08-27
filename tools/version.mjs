/**
 * Version de la aplicacion, derivada de git.
 *
 * Son dos numeros con dos trabajos distintos:
 *
 *  - El NOMBRE (v5.1) es lo que se lee. Sale del ultimo commit que lleva un
 *    nombre de version por titulo, que es como se marcan aqui las versiones:
 *    escribirlo tambien en package.json era escribir lo mismo dos veces, y las
 *    dos copias acabaron diciendo cosas distintas (los commits iban por la v5.1
 *    con package.json todavia en la 4.8.0).
 *  - El CODIGO (1018) es lo que compara Android, y sale de contar los commits,
 *    asi que sube solo y nunca retrocede. Es lo unico que decide si una release
 *    es una actualizacion: por eso cualquier version instalada, por vieja que
 *    sea, puede saltar DIRECTAMENTE a la ultima publicada. No hay cadena de
 *    actualizaciones intermedias que seguir ni nada que se pueda quedar a
 *    medias por el camino.
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

/**
 * Un titulo de commit que ES un nombre de version: "v5.1", "v5", "4.9".
 *
 * Se exige que sean solo digitos y puntos precisamente para poder distinguirlo
 * de un commit normal ("arreglar el mapa"), que no marca ninguna version.
 */
export function versionFromSubject(subject) {
  const match = /^v?(\d+(?:\.\d+)*)$/.exec(String(subject ?? '').trim())
  return match ? match[1] : null
}

/**
 * Nombre de la version: el del ultimo commit que lo lleve por titulo.
 *
 * Se mira hacia atras y no solo la punta porque despues de marcar la v5.1
 * pueden venir commits normales: la version sigue siendo la 5.1 —con un
 * versionCode mayor, que es lo que hace que la actualizacion se ofrezca— hasta
 * que un commit nuevo la renombre.
 */
export function commitVersionName(limit = 200) {
  try {
    const log = execFileSync('git', ['log', `-${limit}`, '--pretty=%s'], {
      cwd: root,
      encoding: 'utf8',
    })

    for (const line of log.split('\n')) {
      const name = versionFromSubject(line)
      if (name) {
        return name
      }
    }
  } catch {
    /* sin git: se cae a package.json */
  }

  return null
}

export function resolveVersion() {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const count = commitCount()
  // package.json es solo la red de seguridad: compilando desde un zip, sin
  // historia de git, no hay commit del que sacar el nombre.
  const versionName = commitVersionName() ?? pkg.version

  return {
    versionName,
    versionCode: VERSION_CODE_BASE + (Number.isFinite(count) ? count : 0),
    /** Etiqueta de la release; de ella saca la app el versionCode publicado. */
    tag: `v${versionName}-b${VERSION_CODE_BASE + (Number.isFinite(count) ? count : 0)}`,
  }
}
