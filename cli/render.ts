import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFile, realpath, stat, open, unlink } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";
import { createRequire } from "node:module";
import { parseProject, MAX_PROJECT_BYTES } from "../lib/headless";
import { parseRenderArgs, validateRenderDoc, RenderError } from "../lib/renderContract";
import { RENDER_FONT_FILES, RENDER_FONT_BUNDLE_SHA256, RENDER_FONT_FAMILIES } from "../lib/renderFonts";
export { RenderError } from "../lib/renderContract";

const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".woff": "font/woff", ".png": "image/png", ".svg": "image/svg+xml" };
/** Explicit built files only; never runs Next, installs dependencies, or reads app configuration. */
export async function runRenderCommand(args: string[]): Promise<void> {
  const options = parseRenderArgs(args);
  const input = resolve(options.input), output = resolve(options.output), manifestPath = output + ".manifest.json";
  if (input === output || input === manifestPath) throw new RenderError("RENDER_OPTIONS", "Output must not replace input.", 2);
  const info = await stat(input);
  if (!info.isFile() || info.size > MAX_PROJECT_BYTES) throw new RenderError("RENDER_INPUT", "Input must be a regular Doc JSON file of at most 1 MiB.", 4);
  const raw = await readFile(input, "utf8"), doc = parseProject(raw);
  const frame = validateRenderDoc(doc, options);
  // Refuse replacement so a previous image can never be mistaken for this run's success.
  for (const path of [output, manifestPath]) {
    try { await stat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    throw new RenderError("RENDER_OUTPUT_EXISTS", "Output or manifest already exists; choose fresh paths.", 4);
  }
  const root = await realpath(resolve(options.buildDir));
  let html: string;
  try {
    const page = await realpath(resolve(root, "render/index.html"));
    if (!page.startsWith(root + sep)) throw new Error("Page escapes build directory.");
    html = await readFile(page, "utf8");
  } catch { throw new RenderError("RENDER_BUILD_MISSING", "Expected an already-built Next static export with render/index.html.", 4); }
  if (/\b(?:src|href)=["'][^"']+\/_next\/static\//.test(html)) throw new RenderError("RENDER_BUILD_INCOMPATIBLE", "Build with empty NEXT_PUBLIC_BASE_PATH for offline rendering.", 4);
  // Load only pinned public font bytes. A missing/corrupt font fails before browser launch.
  const fontAssets = new Map<string, Buffer>();
  for (const [name, expected] of Object.entries(RENDER_FONT_FILES)) {
    try {
      const file = await realpath(resolve(root, "render-fonts", name));
      if (!file.startsWith(root + sep)) throw new Error("Font path escapes build root.");
      const info = await stat(file);
      if (!info.isFile() || info.size !== expected.bytes) throw new Error("Font size mismatch.");
      const bytes = await readFile(file);
      if (hash(bytes) !== expected.sha256) throw new Error("Font hash mismatch.");
      fontAssets.set("/render-fonts/" + name, bytes);
    } catch { throw new RenderError("RENDER_FONTS_MISSING", `Missing or corrupt pinned font asset: ${name}. Rebuild the static export.`, 4); }
  }
  // The shared layout contains web-font links for interactive use. The offline renderer removes
  // these before navigation, rather than downloading fonts or silently claiming they loaded.
  html = html.replace(/<link\b[^>]*>/gi, (tag) => /\brel=["']stylesheet["']/.test(tag) && /\bhref=["']\/_next\/static\//.test(tag) ? tag : "");
  html = html.replace("</head>", '<link rel="icon" href="data:," /><link rel="stylesheet" href="/render-fonts/fonts.css" /></head>');
  let chromium;
  try { chromium = createRequire(__filename)("playwright").chromium; }
  catch { throw new RenderError("RENDER_UNAVAILABLE", "Install the optional official playwright package and its Chromium runtime before rendering.", 6, "browser_dependency"); }
  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src data:; font-src 'self'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'");
      if (path === "/render/") { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(html); return; }
      if (fontAssets.has(path)) { res.setHeader("Content-Type", MIME[extname(path)]); res.end(fontAssets.get(path)); return; }
      // Static JS/CSS plus the exact pinned font whitelist only. No server endpoints, arbitrary public files, source maps or config.
      if (!/^\/_next\/static\/[a-zA-Z0-9_./-]+\.(js|css)$/.test(path) || path.includes("..")) { res.writeHead(404); res.end(); return; }
      const file = await realpath(resolve(root, "." + path));
      if (!file.startsWith(root + sep)) { res.writeHead(403); res.end(); return; }
      res.setHeader("Content-Type", MIME[extname(file)] ?? "application/octet-stream");
      res.end(await readFile(file));
    } catch { res.writeHead(404); res.end(); }
  });
  let browser: any;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let phase = "local_server";
  let imageWritten = false;
  let manifestWritten = false;
  const controller = new AbortController();
  const checkCancelled = () => { if (controller.signal.aborted) throw new RenderError("RENDER_TIMEOUT", "Render deadline exceeded.", 6, phase); };
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing loopback server address.");
    const origin = `http://127.0.0.1:${address.port}`;
    timer = setTimeout(() => { controller.abort(); void browser?.close().catch(() => {}); }, options.timeoutMs);
    const operation = (async () => {
      phase = "browser_launch";
      browser = await chromium.launch({ headless: true, chromiumSandbox: true, timeout: options.timeoutMs, env: { PATH: process.env.PATH ?? "", LANG: "C.UTF-8", TZ: "UTC" } });
      if (controller.signal.aborted) { await browser.close(); checkCancelled(); }
      const context = await browser.newContext({ viewport: { width: options.width, height: options.height }, deviceScaleFactor: 1, locale: "en-US", timezoneId: "UTC", reducedMotion: "reduce", colorScheme: "light", serviceWorkers: "block", acceptDownloads: false });
      const blocked: string[] = [];
      await context.route("**/*", async (route: any) => {
        const url = new URL(route.request().url());
        if (url.origin === origin && (url.pathname === "/render/" || fontAssets.has(url.pathname) || /^\/_next\/static\/[a-zA-Z0-9_./-]+\.(js|css)$/.test(url.pathname))) await route.continue();
        else { blocked.push(url.protocol + "//" + url.host + url.pathname); await route.abort(); }
      });
      await context.addInitScript((payload: unknown) => {
        // Date pickers default to today. Freeze wall-clock time without pausing timers/RAF.
        const NativeDate = Date;
        const epoch = NativeDate.parse("2024-01-01T00:00:00.000Z");
        window.Date = new Proxy(NativeDate, {
          construct(target, values) { return Reflect.construct(target, values.length ? values : [epoch]); },
          apply() { return new NativeDate(epoch).toString(); },
          get(target, key, receiver) { return key === "now" ? () => epoch : Reflect.get(target, key, receiver); },
        });
        (window as any).__M3E_RENDER_INPUT__ = payload;
      }, { doc, frameId: frame.id, fontMode: options.fontMode });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error: Error) => errors.push(error.message));
      page.on("console", (message: any) => { if (message.type() === "error") errors.push(message.text()); });
      page.on("requestfailed", () => errors.push("A render resource request failed."));
      page.on("response", (response: any) => { if (response.status() >= 400) errors.push("A render resource returned HTTP " + response.status()); });
      phase = "page_ready";
      await page.goto(origin + "/render/", { waitUntil: "load", timeout: options.timeoutMs });
      await page.waitForFunction(() => (window as any).__M3E_RENDER_STATE__?.status !== undefined && (window as any).__M3E_RENDER_STATE__.status !== "loading", null, { timeout: options.timeoutMs });
      const state = await page.evaluate(() => (window as any).__M3E_RENDER_STATE__);
      if (state.status !== "ready" || errors.length || blocked.length) throw new RenderError("RENDER_RESOURCE", state.error ?? errors[0] ?? "Unexpected network request was blocked.", 6, phase);
      phase = "screenshot";
      const bytes: Buffer = await page.screenshot({ type: "png", animations: "disabled", caret: "hide", timeout: options.timeoutMs });
      if (bytes.length < 24 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" || bytes.readUInt32BE(16) !== options.width || bytes.readUInt32BE(20) !== options.height) throw new RenderError("RENDER_INVALID_OUTPUT", "Browser returned an invalid PNG or dimensions.", 6, phase);
      const manifest = { schemaVersion: 1, status: "rendered", visualAcceptance: "not-reviewed", frameId: frame.id, renderer: "ExportFrame/M3Static", browserVersion: browser.version(), inputSha256: hash(raw), normalizedDocSha256: hash(JSON.stringify(doc)), outputSha256: hash(bytes), buildPageSha256: hash(html), format: "png", viewport: { width: options.width, height: options.height, deviceScaleFactor: 1 }, locale: "en-US", timezone: "UTC", fixedTime: "2024-01-01T00:00:00.000Z", network: "loopback-static-only", fontMode: options.fontMode, fontBundleSha256: RENDER_FONT_BUNDLE_SHA256, fontFamilies: RENDER_FONT_FAMILIES, resourceWarnings: ["Pinned Noto Sans SC fallback uses Simplified Chinese glyph forms; it may differ from the editor online/host/JP/KR fallback.", ...(options.fontMode === "system" ? ["System text font is OS-dependent; pixel equivalence is not claimed."] : [])], measuredWidths: state.measuredWidths, output };
      phase = "output";
      checkCancelled();
      const imageHandle = await open(output, "wx"); imageWritten = true;
      try { checkCancelled(); await imageHandle.writeFile(bytes); } finally { await imageHandle.close(); }
      checkCancelled();
      const manifestHandle = await open(manifestPath, "wx"); manifestWritten = true;
      try { checkCancelled(); await manifestHandle.writeFile(JSON.stringify(manifest, null, 2) + "\n"); } finally { await manifestHandle.close(); }
      checkCancelled();
      process.stdout.write(JSON.stringify({ output, manifest: manifestPath, sha256: manifest.outputSha256, visualAcceptance: manifest.visualAcceptance }) + "\n");
    })();
    // Wait for cancellation to settle before removing owned output files. Returning from a
    // Promise.race here would allow a late write/launch to escape cleanup.
    await operation;
  } catch (error) {
    const cleanupFailures: string[] = [];
    for (const path of [...(imageWritten ? [output] : []), ...(manifestWritten ? [manifestPath] : [])]) {
      try { await unlink(path); } catch (cleanupError) { if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") cleanupFailures.push(path); }
    }
    if (cleanupFailures.length) throw new RenderError("RENDER_CLEANUP_FAILED", "Render failed and incomplete owned artifacts could not be removed: " + cleanupFailures.join(", "), 4, "cleanup");
    if (error instanceof RenderError) throw error;
    if (controller.signal.aborted) throw new RenderError("RENDER_TIMEOUT", "Render deadline exceeded; no successful artifact is reported.", 6, phase);
    throw new RenderError(phase === "browser_launch" ? "RENDER_UNAVAILABLE" : "RENDER_FAILED", error instanceof Error ? error.message : "Render failed.", 6, phase);
  } finally {
    if (timer) clearTimeout(timer);
    await browser?.close().catch(() => {});
    server.closeAllConnections();
    await new Promise<void>((resolve) => { if (!server.listening) resolve(); else server.close(() => resolve()); });
  }
}
