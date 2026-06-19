// Downscale generated assets to game-appropriate sizes (Nano Banana emits ~1024px
// PNGs at ~1 MB each; that's far too heavy to ship). Run after `npm run gen-assets`:
//
//   npm i -D sharp && node scripts/gen-assets/downscale.mjs && npm un sharp
//
// sharp is a temporary dev dependency on purpose — it's only needed for this
// one-off and we keep it out of package.json so the runtime image stays lean.

import { readdirSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import sharp from 'sharp'

const DIR = join(process.cwd(), 'public', 'assets')

// Target max dimension by asset name prefix.
function targetFor(name) {
  if (name === 'logo.png') return 448
  if (name === 'terra.png' || name === 'luna.png') return 384
  if (name === 'launchpad.png') return 640
  if (name.startsWith('part-')) return 256
  return 384
}

const files = readdirSync(DIR).filter((f) => f.endsWith('.png'))
let before = 0
let after = 0
for (const f of files) {
  const path = join(DIR, f)
  before += statSync(path).size
  const size = targetFor(f)
  const buf = await sharp(path)
    .resize(size, size, { fit: 'inside', withoutEnlargement: true })
    .png({ compressionLevel: 9, quality: 90 })
    .toBuffer()
  await sharp(buf).toFile(path)
  after += statSync(path).size
  console.log(`${basename(f).padEnd(22)} -> ${size}px  ${(statSync(path).size / 1024).toFixed(0)} KB`)
}
console.log(`\ntotal ${(before / 1024 / 1024).toFixed(1)} MB -> ${(after / 1024).toFixed(0)} KB`)
