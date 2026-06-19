# Asset generation

The game's 2D art is generated with Google's Gemini image model
("Nano Banana", `gemini-2.5-flash-image`) and committed into `public/assets/`.

## Two surfaces, one Google account

| Need | Use | Why |
|------|-----|-----|
| Batch sprite set (parts, planets, UI), repeatable | **Gemini API** via this script | Scriptable; **free tier ~500 images/day**, no credit card |
| Hero art (title splash, planet vistas), highest fidelity | **Google AI Pro app + Whisk** | Interactive, best quality; that's what the Pro sub is for |

The API key and the Pro subscription both come from the **same Google login** —
they're just two different doors. This script uses the API door.

## Run it

```bash
# 1. Free key (your Google login): https://aistudio.google.com/apikey
cp .env.example .env        # then paste the key into .env
npm run gen-assets          # generate everything missing
npm run gen-assets -- --force   # regenerate all
npm run gen-assets -- terra luna   # just named assets
```

Output lands in `public/assets/<name>.png` and is served at `/assets/<name>.png`.

## Editing the set

- `style.md` — the shared art-direction preamble prepended to every prompt
  (keeps the set visually coherent). Tune it once, regenerate all.
- `manifest.json` — the list of assets + their individual prompts. Add an entry,
  run `npm run gen-assets -- <name>`.

## Note

The current renderer is vector-based (it draws the rocket and planets with
canvas primitives), so the game runs with **zero** generated assets. These PNGs
are the art target for the next visual pass — drop-in replacements for the vector
placeholders, starting with part icons in the Vehicle Assembly.
