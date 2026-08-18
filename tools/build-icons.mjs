/**
 * Genera los recursos de icono a partir de `public/favicon.svg`.
 *
 *   resources/icon.png            -> fuente para `npx capacitor-assets generate`
 *   resources/splash.png          -> pantalla de arranque nativa (fondo + marca)
 *   resources/icon-foreground.png -> capa adaptativa Android (con margen seguro)
 *   resources/icon-background.png -> capa de fondo Android
 *
 * Uso:  node tools/build-icons.mjs
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import sharp from 'sharp'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const resourcesDir = path.join(projectRoot, 'resources')

const BRAND_BACKGROUND = '#0d47c8'

async function main() {
  await fs.mkdir(resourcesDir, { recursive: true })

  const iconSvg = await fs.readFile(path.join(projectRoot, 'public', 'favicon.svg'))
  const monoSvg = await fs.readFile(path.join(projectRoot, 'public', 'icon-mono.svg'))

  // Icono principal 1024x1024.
  await sharp(iconSvg, { density: 512 })
    .resize(1024, 1024, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(path.join(resourcesDir, 'icon.png'))
  console.log('[icons] resources/icon.png')

  // Capa de primer plano adaptativa: el sistema recorta hasta un 33 %, asi que la
  // marca solo puede ocupar el circulo seguro central (~66 % del lienzo).
  const foregroundMark = await sharp(iconSvg, { density: 512 })
    .resize(660, 660, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer()

  await sharp({
    create: { width: 1024, height: 1024, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: foregroundMark, gravity: 'center' }])
    .png()
    .toFile(path.join(resourcesDir, 'icon-foreground.png'))
  console.log('[icons] resources/icon-foreground.png')

  await sharp({
    create: { width: 1024, height: 1024, channels: 4, background: BRAND_BACKGROUND },
  })
    .png()
    .toFile(path.join(resourcesDir, 'icon-background.png'))
  console.log('[icons] resources/icon-background.png')

  // Splash nativo 2732x2732 con la marca centrada.
  const splashMark = await sharp(iconSvg, { density: 512 })
    .resize(720, 720, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer()

  await sharp({
    create: { width: 2732, height: 2732, channels: 4, background: BRAND_BACKGROUND },
  })
    .composite([{ input: splashMark, gravity: 'center' }])
    .png()
    .toFile(path.join(resourcesDir, 'splash.png'))
  console.log('[icons] resources/splash.png')

  await sharp({
    create: { width: 2732, height: 2732, channels: 4, background: BRAND_BACKGROUND },
  })
    .composite([{ input: splashMark, gravity: 'center' }])
    .png()
    .toFile(path.join(resourcesDir, 'splash-dark.png'))
  console.log('[icons] resources/splash-dark.png')

  // PWA / favicon rasterizado para navegadores que no aceptan SVG.
  for (const size of [192, 512]) {
    await sharp(iconSvg, { density: 512 })
      .resize(size, size)
      .png()
      .toFile(path.join(projectRoot, 'public', `icon-${size}.png`))
    console.log(`[icons] public/icon-${size}.png`)
  }

  // Comprobacion: la silueta monocroma debe ser transparente salvo el trazo.
  const monoStats = await sharp(monoSvg, { density: 512 }).resize(96, 96).png().stats()
  const opaqueRatio = monoStats.channels[3] ? monoStats.channels[3].mean / 255 : 1
  console.log(`[icons] icon-mono.svg cobertura opaca: ${(opaqueRatio * 100).toFixed(1)} % (debe ser < 100 %)`)
}

await main()
