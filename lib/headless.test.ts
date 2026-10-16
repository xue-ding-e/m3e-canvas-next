import { describe, expect, it } from "vitest";
import { HeadlessError, MAX_PROJECT_BYTES, normalizeProject, parseProject, projectPrompt, projectShareLink } from "./headless";
import { buildPrompt } from "./prompt";
import { readShareHash } from "./share";

const minimal = () => ({ groups: [], frames: [{ id: "home", name: "Home", x: 0, y: 0 }] });

describe("headless project services", () => {
  it("normalizes legacy omissions without mutating the input", () => {
    const input = minimal();
    const before = structuredClone(input);
    const doc = normalizeProject(input);
    expect(input).toEqual(before);
    expect(doc).toMatchObject({ title: "", brief: "", frame: "phone", paletteKey: "purple" });
    expect(doc.frames).not.toBe(input.frames);
  });
  it("uses explicit language and the existing prompt engine", () => {
    for (const lang of ["en", "ja", "zh", "ko"] as const) {
      expect(projectPrompt(minimal(), { lang })).toBe(buildPrompt(normalizeProject(minimal()), {}, undefined, lang));
    }
  });
  it("preserves edited text including an empty prompt by default", () => {
    for (const promptEdit of ["Handwritten", ""]) {
      expect(projectPrompt({ ...minimal(), promptEdit })).toBe(promptEdit);
      expect(projectPrompt({ ...minimal(), promptEdit }, { mode: "generated" })).not.toBe(promptEdit);
    }
  });
  it("rejects frame selection that could silently export the whole document", () => {
    expect(() => projectPrompt(minimal(), { frameId: "home" })).toThrow(/requires generated/);
    expect(() => projectPrompt(minimal(), { frameId: "missing", mode: "generated" })).toThrow(/does not exist/);
    expect(() => projectPrompt({ ...minimal(), frame: "blank" }, { frameId: "home", mode: "generated" })).toThrow(/does not exist/);
    expect(projectPrompt(minimal(), { frameId: "home", mode: "generated" })).toContain("Home");
  });
  it("uses editor normalization for malformed optional top-level fields", () => {
    const doc = normalizeProject({ ...minimal(), title: 5, brief: null, theme: { dark: "yes", font: "unknown" }, customPalette: { primary: 42 }, promptEdit: [] });
    expect(doc).toMatchObject({ title: "", brief: "", theme: { dark: false, font: "roboto" } });
    expect(doc.customPalette).toBeUndefined();
    expect(doc.promptEdit).toBeUndefined();
    expect(projectPrompt(doc)).toContain("##");
  });
  it("reuses legacy item migrations", () => {
    const input = { ...minimal(), groups: [{ id: "g", x: 0, y: 0, axis: "x", items: [{ id: "i", kind: "fabMenu", label: "Menu", icon: null, variant: "filled" }] }] };
    expect(normalizeProject(input).groups[0].items[0]).toMatchObject({ kind: "fab", size: 56 });
    expect(input.groups[0].items[0].kind).toBe("fabMenu");
  });
  it.each([{ toggle: { label: [] } }, { src: 12 }, { action: { to: "link", transition: "none", url: 7 } }, { actions: { icon: null } }])("rejects malformed optional item fields %j", (patch) => {
    const doc = { ...minimal(), groups: [{ id: "g", x: 0, y: 0, axis: "x", items: [{ id: "i", kind: "button", label: "Save", icon: null, variant: "filled", ...patch }] }] };
    expect(() => normalizeProject(doc)).toThrow(HeadlessError);
  });
  it("rejects missing custom palette roles and malformed group positions", () => {
    expect(() => normalizeProject({ ...minimal(), paletteKey: "custom", customPalette: { primary: "#000000" } })).toThrow(/customPalette/);
    expect(() => normalizeProject({ ...minimal(), groups: [{ id: "g", x: 0, y: 0, axis: "x", free: true, pos: { i: { x: "oops", y: null } }, items: [{ id: "i", kind: "button", label: "Save", icon: null, variant: "filled" }] }] })).toThrow(/group.pos/);
  });
  it("classifies bad JSON, shape, depth, and size", () => {
    expect(() => parseProject("{" )).toThrowError(expect.objectContaining({ code: "INVALID_JSON" }));
    expect(() => normalizeProject({})).toThrow(HeadlessError);
    expect(() => parseProject(" ".repeat(MAX_PROJECT_BYTES + 1))).toThrow(/1 MiB/);
    let deep: unknown = {};
    for (let i = 0; i < 70; i++) deep = { child: deep };
    expect(() => normalizeProject({ ...minimal(), extra: deep })).toThrow(/64 levels/);
    expect(() => normalizeProject({ ...minimal(), extra: Infinity })).toThrow(HeadlessError);
  });
  it("generates a compatible share link and strips picked images and history", async () => {
    const doc = { ...minimal(), groups: [{ id: "g", x: 0, y: 0, axis: "x", items: [{ id: "i", kind: "button", label: "Save", icon: null, variant: "filled", src: "data:image/png;base64,AA", noteHistory: ["private"] }] }] };
    const link = await projectShareLink(doc, "https://example.com/editor/");
    const decoded = await readShareHash(new URL(link).hash);
    expect(decoded?.groups[0].items[0]).not.toHaveProperty("src");
    expect(decoded?.groups[0].items[0]).not.toHaveProperty("noteHistory");
  });
  it.each(["file:///tmp/app", "https://user:password@example.com/", "https://example.com/#doc=x", "https://example.com/#", "relative"])("rejects unsafe share base %s", async (base) => {
    await expect(projectShareLink(minimal(), base)).rejects.toThrow(HeadlessError);
  });
});
