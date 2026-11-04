/** Generate Web installation icons from the LabScriptAI mark. */
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Source SVG for the browser and installation icons. */
export const TILE_SOURCE = fileURLToPath(new URL('../public/brand-mark.svg', import.meta.url))
/** Output directory for installation icons. */
export const ICON_OUTPUT_DIRECTORY = fileURLToPath(new URL('../public/', import.meta.url))
/** Keep the maskable artwork within the circular safe area. */
export const MASKABLE_ARTWORK_SCALE = 0.68
/** Minimum guaranteed safe radius relative to the full icon. */
export const MASKABLE_SAFE_RADIUS_RATIO = 0.4

/** An installation image and its intended use. */
export interface AppIconVariant {
  readonly file: string
  readonly size: number
  readonly kind: 'tile' | 'maskable'
}

/** Images referenced by the manifest and Apple touch icon. */
export const APP_ICON_VARIANTS: readonly AppIconVariant[] = [
  { file: 'icon-192.png', size: 192, kind: 'tile' },
  { file: 'icon-512.png', size: 512, kind: 'tile' },
  { file: 'icon-maskable-512.png', size: 512, kind: 'maskable' },
  { file: 'apple-touch-icon.png', size: 180, kind: 'tile' },
]

/** Place the supplied SVG on an opaque background for installation. */
export function tileDocument(source: string): string {
  if (!/^\s*<svg\b/u.test(source) || !source.includes('viewBox="0 0 512 512"')) throw new Error('app icons: invalid LabScriptAI mark')
  return source.replace(/(<svg\b[^>]*>)/u, '$1<rect width="512" height="512" fill="#fff"/>')
}

/** Scale artwork inside the maskable icon's safe area. */
export function maskableDocument(source: string): string {
  const tile = tileDocument(source)
  return tile.replace('<rect width="512" height="512" fill="#fff"/>', `<rect width="512" height="512" fill="#fff"/><g transform="translate(256 256) scale(${MASKABLE_ARTWORK_SCALE}) translate(-256 -256)">`).replace('</svg>', '</g></svg>')
}

/** Render each declared installation image from the supplied mark. */
export async function renderAppIcons(source: string): Promise<readonly { variant: AppIconVariant; png: Buffer }[]> {
  const { default: sharp } = await import('sharp')
  return Promise.all(APP_ICON_VARIANTS.map(async variant => ({
    variant,
    png: await sharp(Buffer.from(variant.kind === 'maskable' ? maskableDocument(source) : tileDocument(source)), { density: 288 })
      .resize(variant.size, variant.size, { kernel: 'lanczos3' }).png().toBuffer(),
  })))
}

async function main(): Promise<void> {
  const source = await readFile(TILE_SOURCE, 'utf8')
  const icons = await renderAppIcons(source)
  await Promise.all(icons.map(({ variant, png }) => writeFile(resolve(ICON_OUTPUT_DIRECTORY, variant.file), png)))
  console.info(`app icons: wrote ${icons.map(icon => icon.variant.file).join(', ')}`)
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) await main()
