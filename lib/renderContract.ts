import { RENDER_FONT_COVERAGE, RENDER_ICON_NAMES } from "./renderFonts";
import { frameLengthOf, frameSizeOf, normalizeTheme, setGlobalShape, type Doc } from "./tokens";

export class RenderError extends Error {
  readonly retryable = false;
  constructor(public readonly code: string, message: string, public readonly exitCode = 6, public readonly phase = "preflight") { super(message); this.name = "RenderError"; }
}
export type RenderOptions = {
  input: string; output: string; buildDir: string; frameId: string;
  width: number; height: number; timeoutMs: number; fontMode: "strict" | "system";
};
export function parseRenderArgs(args: string[]): RenderOptions {
  const flags: Record<string, string> = {};
  const allowed = new Set(["input", "output", "build-dir", "frame", "width", "height", "timeout", "font-mode"]);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.slice(2), value = args[i + 1];
    if (!args[i]?.startsWith("--") || !allowed.has(key) || flags[key] !== undefined || !value || value.startsWith("--")) throw new RenderError("RENDER_OPTIONS", "Expected unique render --option value pairs.", 2);
    flags[key] = value;
  }
  for (const key of ["input", "output", "build-dir", "frame", "width", "height"]) if (!flags[key]) throw new RenderError("RENDER_OPTIONS", `render requires --${key}.`, 2);
  for (const key of ["input", "output", "build-dir"]) if (flags[key] === "-" || /^[a-z][a-z0-9+.-]*:\/\//i.test(flags[key])) throw new RenderError("RENDER_OPTIONS", `${key} must be an explicit local path.`, 2);
  if (!flags.output.endsWith(".png")) throw new RenderError("RENDER_OPTIONS", "Only explicit .png output is supported.", 2);
  const number = (key: string, fallback: number, min: number, max: number) => {
    const value = flags[key] === undefined ? fallback : Number(flags[key]);
    if (!Number.isInteger(value) || value < min || value > max) throw new RenderError("RENDER_OPTIONS", `${key} must be an integer in ${min}..${max}.`, 2);
    return value;
  };
  const fontMode = flags["font-mode"] ?? "strict";
  if (fontMode !== "strict" && fontMode !== "system") throw new RenderError("RENDER_OPTIONS", "font-mode must be strict or system.", 2);
  return { input: flags.input, output: flags.output, buildDir: flags["build-dir"], frameId: flags.frame, width: number("width", 0, 1, 4096), height: number("height", 0, 1, 4096), timeoutMs: number("timeout", 30000, 1000, 120000), fontMode };
}
/** No document asset may cause a request. Raster data URLs are the only supported assets. */
export function validateRenderDoc(doc: Doc, options: RenderOptions) {
  const frame = doc.frames.find((f) => f.id === options.frameId);
  if (!frame) throw new RenderError("UNKNOWN_FRAME", "Selected frame does not exist.", 3);
  if (frameSizeOf(frame).w > options.width || frameLengthOf(frame) > options.height) throw new RenderError("RENDER_VIEWPORT", "Viewport must contain the complete selected frame; clipping is not implicit.", 2);
  const visit = (value: unknown) => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (key === "src" && item && (typeof item !== "string" || !/^data:image\/(png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(item))) throw new RenderError("RENDER_RESOURCE", "Only embedded PNG, JPEG or WebP image assets are supported; external and local-file references are forbidden.");
      visit(item);
    }
  };
  visit(doc);
  if (options.fontMode === "strict" && normalizeTheme(doc.theme).font === "system") throw new RenderError("RENDER_FONT_UNSUPPORTED", "System theme fonts are not pinned; use a bundled Roboto family or explicit --font-mode system.");
  return frame;
}

/** Match the editor’s global shape helpers as well as its React theme context. */
export function configureRenderTheme(doc: Doc, fontMode: "strict" | "system" = "strict") {
  const theme = normalizeTheme(doc.theme);
  if (fontMode === "system") theme.font = "system";
  setGlobalShape(theme.shape);
  return theme;
}

export function renderFontFamily(doc: Doc, fontMode: "strict" | "system") {
  const key = fontMode === "system" ? "system" : normalizeTheme(doc.theme).font;
  const names: Record<string, string> = { roboto: "Roboto", robotoFlex: "Roboto Flex", robotoSerif: "Roboto Serif", system: "system-ui" };
  return `${names[key]}, 'Noto Sans SC', sans-serif`;
}
/** Cmap/ligature coverage checks are not a substitute for inspecting rendered pixels. */
export function assertRenderGlyphs(doc: Doc, texts: string[], icons: string[]) {
  const ranges = RENDER_FONT_COVERAGE[normalizeTheme(doc.theme).font];
  if (!ranges) throw new RenderError("RENDER_FONT_UNSUPPORTED", "This theme font is not bundled.");
  for (const text of texts) for (const char of text) {
    const cp = char.codePointAt(0)!;
    if (/[\n\r\t]/.test(char)) continue;
    if (!ranges.some(([start, end]) => cp >= start && cp <= end)) throw new RenderError("RENDER_GLYPH_UNSUPPORTED", `Pinned font bundle does not cover U+${cp.toString(16).toUpperCase()}.`);
  }
  for (const icon of icons) if (icon && !RENDER_ICON_NAMES.has(icon)) throw new RenderError("RENDER_ICON_UNSUPPORTED", `Pinned Material Symbols font does not include icon ${icon}.`);
}
