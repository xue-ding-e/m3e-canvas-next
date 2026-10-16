import { describe, expect, it } from "vitest";
import { normalizeProject } from "../lib/headless";
import { parseRenderArgs, validateRenderDoc, RenderError, configureRenderTheme, assertRenderGlyphs, renderFontFamily } from "../lib/renderContract";

import { getShape, scaleR, setGlobalShape } from "../lib/tokens";

const args = ["--input", "design.json", "--output", "shot.png", "--build-dir", "out", "--frame", "home", "--width", "800", "--height", "900"];
const doc = () => normalizeProject({ groups: [], frames: [{ id: "home", name: "Home", x: 0, y: 0 }] });
describe("offline render contract (no browser execution)", () => {
  it("requires explicit input, frame, output, built app and viewport", () => {
    expect(parseRenderArgs(args)).toMatchObject({ input: "design.json", output: "shot.png", frameId: "home", fontMode: "strict", width: 800, height: 900 });
    expect(() => parseRenderArgs([])).toThrow(RenderError);
  });
  it.each(["--url", "--config", "--api-key", "--executable", "--no-sandbox"])("rejects unrecognized option %s", (flag) => {
    expect(() => parseRenderArgs([...args, flag, "value"])).toThrow(RenderError);
  });
  it("rejects duplicate options and non-PNG outputs", () => {
    expect(() => parseRenderArgs([...args, "--width", "500"])).toThrow(RenderError);
    expect(() => parseRenderArgs(args.map((x) => x === "shot.png" ? "shot.svg" : x))).toThrow(RenderError);
  });
  it.each(["-", "https://example.com/input.json", "file:///etc/passwd"])("rejects non-local-path input %s", (input) => {
    expect(() => parseRenderArgs(args.map((x) => x === "design.json" ? input : x))).toThrow(RenderError);
  });
  it("bounds viewport and timeout", () => {
    for (const width of ["0", "4097", "NaN", "1.2"]) expect(() => parseRenderArgs(args.map((x) => x === "800" ? width : x))).toThrow(RenderError);
    expect(() => parseRenderArgs([...args, "--timeout", "999999"])).toThrow(RenderError);
  });
  it("strict mode accepts pinned theme families but rejects unpinned system fonts", () => {
    expect(validateRenderDoc(doc(), parseRenderArgs(args)).id).toBe("home");
    const input = doc(); input.theme = { ...input.theme!, font: "system" };
    expect(() => validateRenderDoc(input, parseRenderArgs(args))).toThrow(/not pinned/);
  });
  it("covers common Chinese and Latin text with pinned SC fallback", () => {
    for (const font of ["roboto", "robotoFlex", "robotoSerif"] as const) {
      const input = doc(); input.theme = { ...input.theme!, font };
      expect(() => assertRenderGlyphs(input, ["Hello 你好世界 中文设计"], ["home", "menu", "settings"])).not.toThrow();
      expect(renderFontFamily(input, "strict")).toContain("Noto Sans SC");
    }
  });
  it("does not allow cmap glyphs excluded by the corresponding CSS unicode range", () => {
    for (const font of ["robotoFlex", "robotoSerif"] as const) {
      const input = doc(); input.theme = { ...input.theme!, font };
      for (const glyph of ["∋", "≅"]) expect(() => assertRenderGlyphs(input, [glyph], [])).toThrow(/does not cover/);
    }
  });
  it("rejects uncovered glyphs and unknown icon ligatures rather than silently falling back", () => {
    expect(() => assertRenderGlyphs(doc(), [String.fromCodePoint(0x10ffff)], [])).toThrow(/U\+10FFFF/);
    expect(() => assertRenderGlyphs(doc(), [], ["not_a_real_icon_123"])).toThrow(/does not include icon/);
  });
  it("supports explicit fallback and selected frame without mutating document", () => {
    const input = doc(), before = structuredClone(input);
    expect(validateRenderDoc(input, parseRenderArgs([...args, "--font-mode", "system"])).id).toBe("home");
    expect(input).toEqual(before);
  });
  it("does not silently clip long screens or fall back to another frame", () => {
    const options = parseRenderArgs([...args, "--font-mode", "system"]);
    expect(() => validateRenderDoc(doc(), { ...options, frameId: "unknown" })).toThrow(/does not exist/);
    const input = doc(); input.frames[0].length = 1200;
    expect(() => validateRenderDoc(input, options)).toThrow(/complete selected frame/);
  });
  it.each(["https://example.com/p.png", "file:///tmp/p.png", "/local.png", "data:image/svg+xml;base64,AA=="])("rejects unsafe/unbounded image source %s", (src) => {
    const input = doc();
    (input as unknown as Record<string, unknown>).extra = { src };
    expect(() => validateRenderDoc(input, parseRenderArgs([...args, "--font-mode", "system"]))).toThrow(/Only embedded/);
  });
  it("allows embedded raster assets without fetching", () => {
    const input = doc();
    (input as unknown as Record<string, unknown>).extra = { src: "data:image/png;base64,AA==" };
    expect(validateRenderDoc(input, parseRenderArgs([...args, "--font-mode", "system"])).id).toBe("home");
  });
  it("synchronizes square/full/rounded shape helpers before real component rendering", () => {
    try {
      for (const [shape, radius] of [["square", 7], ["full", 32], ["rounded", 20]] as const) {
        const input = doc(); input.theme = { ...input.theme!, shape };
        expect(configureRenderTheme(input)).toMatchObject({ shape, font: "roboto" });
        expect(configureRenderTheme(input, "system")).toMatchObject({ shape, font: "system" });
        expect(getShape()).toBe(shape); expect(scaleR(20)).toBe(radius);
      }
    } finally { setGlobalShape("rounded"); }
  });
  it("render errors carry non-retryable phase and exit code", () => {
    expect(new RenderError("RENDER_UNAVAILABLE", "denied", 6, "browser_launch")).toMatchObject({ retryable: false, exitCode: 6, phase: "browser_launch" });
  });
});
