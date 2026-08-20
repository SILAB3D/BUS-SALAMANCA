/**
 * Lectura de una release de GitHub. Sin dependencias a proposito, igual que
 * `arrival-parser.ts`: es la logica que decide si se ofrece una actualizacion,
 * y tiene que poder comprobarse sin navegador ni dispositivo.
 */

export interface ReleaseInfo {
  /** Etiqueta completa, p. ej. `v4.3.0-b1007`. */
  tag: string
  versionName: string
  versionCode: number
  apkUrl: string
  publishedAt: string | null
}

export interface GitHubRelease {
  tag_name?: string
  draft?: boolean
  prerelease?: boolean
  published_at?: string
  assets?: Array<{ name?: string, browser_download_url?: string }>
}

/**
 * `v4.3.0-b1007` → { versionName: '4.3.0', versionCode: 1007 }.
 *
 * El versionCode sale de la ETIQUETA y no de un fichero adjunto porque los
 * assets de una release no se pueden leer desde JavaScript (ver el CORS en
 * `updates.ts`). La etiqueta ya viene en la respuesta de la API.
 *
 * Una etiqueta sin `-b<numero>` no sirve: sin versionCode no hay comparacion
 * posible, y ofrecer una actualizacion a ciegas es peor que no ofrecer ninguna.
 */
export function parseTag(tag: string): { versionName: string, versionCode: number } | null {
  const match = /^v?(.+)-b(\d+)$/.exec(tag.trim())
  if (!match) {
    return null
  }

  const versionCode = Number.parseInt(match[2], 10)
  return Number.isFinite(versionCode) ? { versionName: match[1], versionCode } : null
}

export function readRelease(payload: GitHubRelease | null | undefined): ReleaseInfo | null {
  if (!payload?.tag_name || payload.draft) {
    return null
  }

  const parsed = parseTag(payload.tag_name)
  if (!parsed) {
    return null
  }

  const apk = (payload.assets ?? []).find((asset) => asset.name?.toLowerCase().endsWith('.apk'))
  if (!apk?.browser_download_url) {
    return null
  }

  return {
    tag: payload.tag_name,
    versionName: parsed.versionName,
    versionCode: parsed.versionCode,
    apkUrl: apk.browser_download_url,
    publishedAt: payload.published_at ?? null,
  }
}

/**
 * Decide si la release publicada es mas nueva que la instalada. Android solo
 * acepta actualizar a un versionCode estrictamente mayor, asi que la
 * comparacion es la misma que hara el sistema.
 */
export function isNewer(release: ReleaseInfo, installedVersionCode: number): boolean {
  return release.versionCode > installedVersionCode
}
