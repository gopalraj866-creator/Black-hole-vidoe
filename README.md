# Falling Into a Black Hole — Three.js video rendered on GitHub Actions

An 8-minute (1920×1080, 30 fps) documentary: 12 scenes, a ray-bending black-hole shader, English voice-over, synthesized score and sound effects, burned-in subtitles and a sidecar `.srt`.

## How it works

| Piece | File |
|---|---|
| Scene plan, narration, camera path, labels | `data/timeline.json` |
| Black hole: Schwarzschild null-geodesic ray marching, Keplerian accretion disk with Doppler and gravitational shift, procedural Milky Way / galaxy / stars | `web/blackhole.frag.glsl` |
| Camera, cockpit HUD, clocks, tidal stretch, observer view, labels, subtitles | `web/main.js` |
| Headless frame renderer (Puppeteer, SwiftShader WebGL, piped into ffmpeg with bloom and film grain) | `render.mjs` |
| Neural TTS (edge-tts), music, whooshes, impacts, hum, ticks, subtitle timing | `scripts/audio.py` |
| Concatenate shards, duck music under voice, mux | `scripts/assemble.sh` |
| Pipeline | `.github/workflows/render-video.yml` |

## Run it

1. Push this folder to a GitHub repository.
2. **Actions → Render black hole video → Run workflow.**
3. First run: leave `preview_only` ticked. It renders 14 still frames (`preview-stills` artifact) so you can check exposure and look in a few minutes.
4. Happy? Run again with `preview_only` unticked. 14,400 frames are split into parallel shards (300 frames each, up to 20 at once), then assembled. Download `falling-into-a-black-hole` (MP4 + SRT) from the run's artifacts.

GitHub runners have no GPU, so WebGL runs on software rendering; expect each shard to take roughly 30–90 minutes. Lower `frames_per_shard` for more parallelism.

## Textures

All surfaces are procedural, physically motivated textures (noise-driven turbulent plasma, blackbody colours, dust lanes, stellar grain). Nothing flat-coloured or cartoonish.

To use a real photographic star map instead, pass a public-domain equirectangular JPG (for example from NASA's Scientific Visualization Studio "Deep Star Maps") as the `sky_texture_url` input, or commit it as `assets/textures/sky.jpg`. The shader switches to it automatically.

## Tuning

- Brightness: `?exposure=` in the page URL, or the `exposure` values per scene in `timeline.json`.
- Local test (needs Chrome): `npm install && npm run snap`, then look in `build/snaps/`.
- Voice: change the `voice` input (any edge-tts voice, e.g. `en-GB-RyanNeural`).

## Honest limits

- The tidal-force scene uses an illustrative linearised stretch model, not a full simulation. The cockpit and HUD are stylized overlays.
- The interior view (scenes 9–10) is an artistic approximation; physics there is genuinely unresolved, as the narration says.
- I couldn't run the browser render in my own sandbox, so the preview job is your first real test. If a shader or layout problem appears, send me the failing log or a still and I'll fix it.

Sources: NASA — Anatomy of a Black Hole; NASA — What Happens When Something Gets Too Close?
