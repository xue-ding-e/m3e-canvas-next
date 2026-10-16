import { isHex } from "./color";
import { isLang, type Lang } from "./i18n";
import { migrateGroups } from "./migrate";
import { isProject } from "./project";
import { buildPrompt } from "./prompt";
import { constrainModalRails } from "./rail";
import { shareLink } from "./share";
import { COLOR_TOKENS, PALETTES, TRANSITIONS, VARIANTS, normalizeTheme, paletteOf, type Doc } from "./tokens";

export type HeadlessErrorCode = "INVALID_JSON" | "INVALID_PROJECT" | "INVALID_OPTIONS" | "UNKNOWN_FRAME";
export const MAX_PROJECT_BYTES = 1024 * 1024;
export const MAX_PROJECT_DEPTH = 64;
export class HeadlessError extends Error {
  constructor(public readonly code: HeadlessErrorCode, message: string) {
    super(message);
    this.name = "HeadlessError";
  }
}

/** Import a file without browser state. Legacy omissions use fresh-editor defaults.
 * Keep the editor's shape validator and migrations as the single source of truth. */
export function normalizeProject(value: unknown): Doc {
  assertJsonProject(value);
  if (!isProject(value)) throw new HeadlessError("INVALID_PROJECT", "Expected an M3E Canvas project with valid groups and frames.");
  assertOptionalFields(value);
  try {
    // Clone before migration so callers can safely reuse the supplied document.
    const doc = structuredClone(value);
    const normalized: Doc = {
      ...doc,
      groups: constrainModalRails(migrateGroups(doc.groups, doc.frames)),
      title: typeof doc.title === "string" ? doc.title : "",
      brief: typeof doc.brief === "string" ? doc.brief : "",
      frame: doc.frame === "blank" ? "blank" : "phone",
      paletteKey: typeof doc.paletteKey === "string" && doc.paletteKey ? doc.paletteKey : "purple",
      customPalette: doc.customPalette && typeof doc.customPalette.primary === "string" ? paletteOf("custom", doc.customPalette) : undefined,
      dynamicColor: typeof doc.dynamicColor === "boolean" ? doc.dynamicColor : false,
      theme: normalizeTheme(doc.theme),
      promptEdit: typeof doc.promptEdit === "string" ? doc.promptEdit : undefined,
    };
    // The editor validator is deliberately permissive. Fail safely if a future
    // optional field reaches an engine path that cannot process it.
    buildPrompt(normalized, {}, undefined, "en");
    return normalized;
  } catch {
    throw new HeadlessError("INVALID_PROJECT", "The project could not be normalized.");
  }
}

/** Guard optional runtime fields the editor's minimal import check does not cover.
 * These are type checks, not a replacement for the component/layout rules. */
function assertOptionalFields(doc: Doc) {
  const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  const optional = (v: unknown, check: (v: unknown) => boolean) => v === undefined || check(v);
  const string = (v: unknown) => typeof v === "string";
  const strings = (v: unknown) => Array.isArray(v) && v.every(string);
  const boolean = (v: unknown) => typeof v === "boolean";
  const colorToken = (v: unknown) => COLOR_TOKENS.some((token) => token.key === v);
  const action = (v: unknown) => record(v) && string(v.to) && TRANSITIONS.some((t) => t.key === v.transition) && optional(v.url, string);
  const check = (valid: boolean, field: string) => {
    if (!valid) throw new HeadlessError("INVALID_PROJECT", `Invalid optional project field: ${field}.`);
  };
  for (const frame of doc.frames) {
    check(optional(frame.bg, colorToken) && optional(frame.noteHistory, strings), "frame");
    check(optional(frame.swipe, (v) => record(v) && Object.values(v).every(string)), "frame.swipe");
  }
  for (const group of doc.groups) {
    check(optional(group.free, boolean), "group.free");
    check(optional(group.pos, (v) => record(v) && Object.values(v).every((p) => record(p) && Number.isFinite(p.x) && Number.isFinite(p.y))), "group.pos");
    for (const item of group.items) {
      check(optional(item.icon2, (v) => v === null || string(v)) && optional(item.src, string) && optional(item.fill, colorToken) && optional(item.iconFill, (v) => v === "none" || colorToken(v)), "item appearance");
      check([item.switch, item.noImage, item.checked, item.wavy, item.contained, item.bold].every((v) => optional(v, boolean)), "item flags");
      check(optional(item.noteHistory, strings), "item.noteHistory");
      check(optional(item.action, action), "item.action");
      check(optional(item.actions, (v) => record(v) && Object.values(v).every(action)), "item.actions");
      check(optional(item.toggle, (v) => record(v) && optional(v.icon, (x) => x === null || string(x)) && optional(v.label, string) && optional(v.variant, (x) => VARIANTS.some((variant) => variant.key === x))), "item.toggle");
    }
  }
  if (doc.customPalette && typeof doc.customPalette.primary === "string") {
    const palette = doc.customPalette as unknown as Record<string, unknown>;
    // Old palettes may omit only secondary; paletteOf supplies that migration.
    check(Object.keys(PALETTES[0]).filter((key) => key !== "secondary" && key !== "seed").every((key) => string(palette[key])), "customPalette roles");
    check(optional(palette.secondary, string) && optional(palette.seed, string), "customPalette");
    // These roles reach CSS backgrounds. A string type alone admits url(...)
    // and can turn an otherwise local import into an arbitrary network request.
    for (const key of [...Object.keys(PALETTES[0]).filter((key) => key !== "key" && key !== "label" && key !== "seed"), "seed"]) {
      check(optional(palette[key], (v) => typeof v === "string" && isHex(v)), `customPalette.${key}`);
    }
  }
}

function assertJsonProject(value: unknown) {
  const visit = (part: unknown, depth: number): void => {
    if (depth > MAX_PROJECT_DEPTH) throw new Error("depth");
    if (part === undefined || part === null || typeof part === "string" || typeof part === "boolean") return;
    if (typeof part === "number" && Number.isFinite(part)) return;
    if (typeof part !== "object") throw new Error("non-JSON value");
    for (const child of Object.values(part)) visit(child, depth + 1);
  };
  try {
    visit(value, 0);
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_PROJECT_BYTES) throw new Error("size");
  } catch {
    throw new HeadlessError("INVALID_PROJECT", "Project must be JSON data, at most 1 MiB and 64 levels deep.");
  }
}

export function parseProject(text: string): Doc {
  if (new TextEncoder().encode(text).byteLength > MAX_PROJECT_BYTES) throw new HeadlessError("INVALID_PROJECT", "Project input exceeds 1 MiB.");
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new HeadlessError("INVALID_JSON", "Input must be valid JSON."); }
  return normalizeProject(value);
}

export type PromptOptions = { lang?: Lang; frameId?: string; mode?: "generated" | "effective" };

/** Empty widths use the engine's estimates; this does not measure browser fonts. */
export function projectPrompt(value: unknown, options: PromptOptions = {}): string {
  const { lang = "en", frameId, mode = "effective" } = options;
  if (!isLang(lang) || !["generated", "effective"].includes(mode) || (frameId !== undefined && (typeof frameId !== "string" || !frameId))) {
    throw new HeadlessError("INVALID_OPTIONS", "Use lang ja/en/zh/ko, mode generated/effective, and a nonempty frame ID.");
  }
  if (frameId !== undefined && mode === "effective") throw new HeadlessError("INVALID_OPTIONS", "Frame selection requires generated mode; edited prompts cover the entire project.");
  const doc = normalizeProject(value);
  if (frameId !== undefined && (doc.frame !== "phone" || !doc.frames.some((frame) => frame.id === frameId))) {
    throw new HeadlessError("UNKNOWN_FRAME", "The selected frame does not exist in this project's screen mode.");
  }
  if (mode === "effective" && doc.promptEdit !== undefined) return doc.promptEdit;
  try { return buildPrompt(doc, {}, frameId, lang); }
  catch { throw new HeadlessError("INVALID_PROJECT", "The project contains fields the prompt engine cannot process."); }
}

/** Only generate a URL locally. Never fetch the base or transmit the project. */
export async function projectShareLink(value: unknown, base: string): Promise<string> {
  let url: URL;
  try { url = new URL(base); }
  catch { throw new HeadlessError("INVALID_OPTIONS", "Share base must be an absolute HTTP(S) app URL."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash || base.includes("#")) {
    throw new HeadlessError("INVALID_OPTIONS", "Share base must be HTTP(S), without credentials or a fragment.");
  }
  return shareLink(normalizeProject(value), url.href);
}
