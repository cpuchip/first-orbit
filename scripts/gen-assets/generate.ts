// Asset generator — turns scripts/gen-assets/manifest.json into PNGs under
// public/assets/ using Google's Gemini image model ("Nano Banana",
// gemini-2.5-flash-image). The free Google AI Studio tier allows ~500 images/day
// at no cost, which is plenty for a 2D game's sprite set.
//
//   1. Get a free key at https://aistudio.google.com/apikey  (your Google login).
//   2. Copy .env.example to .env and paste the key.
//   3. npm run gen-assets            # generate everything missing
//      npm run gen-assets -- --force # regenerate all
//      npm run gen-assets -- logo    # generate just named assets
//
// For one-off hero art (planet vistas, the title splash) the Google AI Pro app +
// Whisk give the highest fidelity — generate there by hand and drop the PNG in.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..')
const MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image'

// Minimal .env loader (no dependency).
function loadEnv(): void {
  const envPath = path.join(ROOT, '.env')
  if (!fs.existsSync(envPath)) return
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}

interface Manifest {
  outDir: string
  assets: { name: string; prompt: string }[]
}

async function generateOne(apiKey: string, style: string, prompt: string): Promise<Buffer> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`
  const body = {
    contents: [{ parts: [{ text: `${style}\n\nGenerate this asset:\n${prompt}` }] }],
    generationConfig: { responseModalities: ['IMAGE'] },
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const json = (await res.json()) as {
    candidates?: { content?: { parts?: { inlineData?: { data?: string } }[] } }[]
  }
  const parts = json.candidates?.[0]?.content?.parts ?? []
  const img = parts.find((p) => p.inlineData?.data)?.inlineData?.data
  if (!img) throw new Error('no image in response (check model/quota/responseModalities)')
  return Buffer.from(img, 'base64')
}

async function main(): Promise<void> {
  loadEnv()
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    console.error('GEMINI_API_KEY not set. Copy .env.example to .env and paste a key from https://aistudio.google.com/apikey')
    process.exit(1)
  }

  const args = process.argv.slice(2)
  const force = args.includes('--force')
  const only = args.filter((a) => !a.startsWith('--'))

  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8')) as Manifest
  const style = fs.readFileSync(path.join(__dirname, 'style.md'), 'utf8')
  const outDir = path.join(ROOT, manifest.outDir)
  fs.mkdirSync(outDir, { recursive: true })

  let made = 0
  for (const asset of manifest.assets) {
    if (only.length && !only.includes(asset.name)) continue
    const file = path.join(outDir, `${asset.name}.png`)
    if (fs.existsSync(file) && !force) {
      console.log(`skip  ${asset.name} (exists; --force to redo)`)
      continue
    }
    try {
      process.stdout.write(`gen   ${asset.name} … `)
      const png = await generateOne(apiKey, style, asset.prompt)
      fs.writeFileSync(file, png)
      console.log(`ok (${(png.length / 1024).toFixed(0)} KB)`)
      made++
      await new Promise((r) => setTimeout(r, 1200)) // be gentle on the free tier
    } catch (e) {
      console.log(`FAIL — ${(e as Error).message}`)
    }
  }
  console.log(`\n${made} asset(s) written to ${path.relative(ROOT, outDir)}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
