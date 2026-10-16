# Offline screenshot rendering (experimental)

The `render` command consumes a local Doc JSON and an **already built** Next static
export. It never edits through UI selectors. Its page and the editor's PNG export
share `ExportFrame` and the production `M3Static` components. Output is the selected
frame's complete static content, including long-screen content, not a navigation
simulation or interactive preview.

```sh
npm run build:headless
# Build with empty NEXT_PUBLIC_BASE_PATH for this local-only export.
npm run build
# Optional official dependency; install separately in a supported environment.
npm install --no-save playwright
npx playwright install chromium
node dist-headless/cli/main.js render \
  --input design.json --build-dir out --frame home \
  --output /explicit/output/home.png --width 800 --height 1200 \
  --font-mode strict --timeout 30000
```

The command never installs packages, downloads browsers, builds Next, expands
permissions or falls back to an unsandboxed browser. Chromium's sandbox is enabled.
Do not retry a denied launch using unsafe flags or an alternate access route.

## Current limitations and acceptance status

- **Not browser-accepted:** type checks and contract tests do not prove that
  Chromium rendered successfully. The development cloud's Chromium launch was
  blocked by `socket: Operation not permitted`; no real screenshot was accepted.
  No fake image or SVG reconstruction is substituted.
- `strict` is the default: pinned Roboto, Roboto Flex or Roboto Serif with a
  pinned Noto Sans SC fallback and original Google Material Symbols Rounded.
  All shape, contrast and light/dark theme settings use the shared renderer.
  An unpinned `system` theme is rejected in strict mode.
- Chinese text uses the fixed **Simplified Chinese** Noto glyph forms. This may
  differ from the interactive editor's online/host/JP/KR font fallback. Rare
  characters, unsupported scripts and unknown icon names fail strict coverage
  checks. Cmap/ligature coverage is not proof of correct visual shaping.
- Explicit `--font-mode system` uses OS text fonts plus the pinned SC and icon
  fonts. Text remains OS-dependent; pixel equivalence is not claimed.
- Only embedded PNG/JPEG/WebP data URLs are accepted for images. External URLs,
  file URLs, SVG data URLs and relative paths are rejected. Explicit local-asset
  import remains future work.
- Screenshots do not validate hit targets, gestures, scroll interactions,
  navigation state machines, undo/redo or external-link behavior.
- English locale, UTC timezone, wall-clock time 2024-01-01T00:00:00Z (including
  unconfigured date pickers) and device scale 1 are fixed. Required integer
  width/height values range from 1 to 4096 CSS pixels and must contain the full
  frame. No clipping or scaling is implicit. Nonempty Next base paths are rejected.

## Security and readiness contract

All of `--input`, `--build-dir`, `--frame`, `--output`, `--width` and `--height`
are required. Only `.png` is supported. stdin and remote URLs are not. The input
uses the existing 1 MiB/depth-limited Doc parser and project migrations.

An ephemeral `127.0.0.1` server serves only `/render/` and built
`/_next/static/*.js`/`*.css` files and the exact pinned `/render-fonts/` whitelist. Realpath confinement blocks symlink escapes.
The fresh, nonpersistent browser context blocks service workers and every other
request. CSP also forbids remote fonts, connections, frames and external images.
Font/CSS bytes are hash-verified before launch and served from memory. Missing
or corrupt assets return `RENDER_FONTS_MISSING`, never a fallback success.
No model credentials, saved editor document, user browser profile or app config
is read. The build is trusted executable app code: do not select an untrusted
static export. The shared layout's normal Google font links are removed offline.

The real component page explicitly loads required families/weights and verifies
font loading, then waits for `document.fonts.ready`, measures the same label
content as the editor, waits for image decoding, freezes animations and waits two
animation frames before reporting structured readiness. Console/page errors,
failed resource requests, invalid PNG output and timeouts fail the run. Decoded
images are limited to 8192 pixels per side and 32 million pixels total; this
post-decode check does not prevent initial decompression memory use. Default
timeout is 30 seconds, bounded to 1–120 seconds. Cancellation waits for operations
to settle before cleanup; it does not leave a background writer after timeout.

PNG signature and dimensions are checked before exclusive creation of the image
and `<output>.manifest.json`. Existing outputs are refused. Failures remove only
files created by the run. Cleanup failures are explicitly reported with affected
paths. stdout reports success only after both outputs finish writing.

Success manifests record input, normalized Doc, render HTML and PNG SHA-256
hashes; selected frame; viewport; browser version; environment; measured widths;
resource warnings; pinned font bundle hash/families; shared renderer; and `visualAcceptance: "not-reviewed"`.
A vision-capable reviewer must inspect the real PNG before visual acceptance.
Hashes establish artifact identity, not cross-machine pixel reproducibility.
The HTML hash does not fingerprint every JS/CSS chunk.

Render errors expose `code`, `phase`, `retryable: false` and normally exit 6.
Usage is exit 2, invalid project/frame 3, preflight I/O 4. Missing Playwright is
`RENDER_UNAVAILABLE` at `browser_dependency`; denied Chromium launch uses
`browser_launch`. These do not create a PNG.

## Outstanding verification

`npm test -- tests/render-contract.test.ts` checks contracts only, without a
browser. A supported environment must run real fixtures for populated/empty
frames, connected runs, free groups, long frames, embedded images and themes;
inspect the PNGs and manifests; and inject browser/page/resource/output failures.
Pinned fonts remove online font dependencies; real screenshot review remains
required and equivalence to a changing online font service is not promised.

## Font provenance and size

Runtime assets total **10,522,246 bytes** (123 WOFF2/CSS files). See
`public/render-fonts/manifest.json` for all versions, source URLs, registry
SHA-512 integrity values, and per-file SHA-256 hashes. Original font binaries
are unchanged; CSS aliases match app family names, URLs are local, and display
is blocking. Copyright/license texts and a notice ship alongside the assets.

- `@fontsource-variable/roboto`, `roboto-flex`, `roboto-serif`: 5.3.0, OFL-1.1
- `@fontsource-variable/noto-sans-sc`: 5.3.1, OFL-1.1
- Google `material-design-icons` commit
  `49d4db35df873165d6bd6ba09b063c7dafbac2f4`: original full Rounded variable font,
  Apache-2.0. The differently licensed third-party Fontsource Symbols package
  was not included.

Sources: [Fontsource Roboto](https://fontsource.org/fonts/roboto/about),
[Roboto Flex](https://fontsource.org/fonts/roboto-flex/about),
[Roboto Serif](https://fontsource.org/fonts/roboto-serif/about),
[Noto Sans SC](https://fontsource.org/fonts/noto-sans-sc/about), and
[Google's original Symbols source](https://github.com/google/material-design-icons/tree/49d4db35df873165d6bd6ba09b063c7dafbac2f4/variablefont).

Coverage metadata in `lib/renderFonts.ts` was generated from fontTools 4.61.1
`getBestCmap()` (Brotli 1.2.0 decoding), intersected with each face’s CSS
`unicode-range` before unioning theme/fallback coverage and collapsing ranges.
The original Google `.codepoints` file supplies icon ligature names. Coverage
checks run on actual exported text/icon nodes after component rendering, not on
nonvisual notes or unrelated frame content. Asset tests verify source files;
browser visual acceptance remains a separate, outstanding check.
