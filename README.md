# Relight

Move the sun across a room photo and see how light falls on the walls, furniture and floor.

Relight estimates depth with Depth Anything V2 Small, runs in your browser through
`@huggingface/transformers`, and relights the photo with a WebGL shader. Nothing is uploaded.
There is no backend, no API key and no account.

## Features

- Drag the sun on the dial, or use the time-of-day slider (6 am to 10 pm).
- Sun strength, depth strength and lamp brightness.
- Click the photo to place lamps. Clear them with one button.
- Presets: Morning, Noon, Golden hour, Cozy night.
- Hold Compare (or hold Space) to see the original.
- Show the depth map.
- Export the current view as PNG.

## Run it

```bash
npm install
npm run dev
```

Open the printed URL. For a production build:

```bash
npm run build
npm run preview
```

The depth model is downloaded on first use. Relight starts the download on page load and the
browser caches it afterwards.

## Browser support

- Chrome and Edge: full experience, WebGPU when available.
- Safari and Firefox: WASM path. Some blur filters on canvas are skipped.

## Project layout

```
index.html          markup and glass surfaces
src/style.css       glass material, layout, responsive sheet
src/main.js         state, controls, render loop, presets
src/depth.js        depth model loading and inference
src/relight.js      WebGL relighting shader
src/effects.js      night tint, lamp glows, vignette, export, lamp finder
```

## Licence

MIT. See `LICENSE`.
