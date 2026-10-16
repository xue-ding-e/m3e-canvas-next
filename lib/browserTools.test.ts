import { describe, expect, it, vi } from "vitest";
import { canvasTools, registerCanvasTools, validateCanvasCandidate, type CanvasState } from "./browserTools";
import { normalizeProject } from "./headless";
import { effectivePrompt } from "./prompt";

const seed = () => normalizeProject({ groups: [{ id: "g", x: 0, y: 0, axis: "x", items: [{ id: "i", kind: "button", label: "Save", icon: null, variant: "filled" }] }], frames: [{ id: "home", name: "Home", x: 0, y: 0 }] });
const json = (v: unknown) => JSON.parse(JSON.stringify(v));
const setup = () => {
  const state: CanvasState = { doc: seed(), widths: { i: 777 }, lang: "en", editable: true };
  const propose = vi.fn();
  const tools = canvasTools(() => state, propose);
  const call = (name: string, input: unknown = {}) => tools.find((tool) => tool.name === name)!.execute(input);
  const revision = () => (call("get_canvas_document") as { revision: string }).revision;
  return { state, propose, tools, call, revision };
};

describe("live canvas browser tools (contract tests, not a host compatibility test)", () => {
  it("exposes only reads and preview, never approval, files, settings or network", () => {
    expect(setup().tools.map((tool) => tool.name)).toEqual(["get_canvas_document", "get_canvas_prompt", "preview_canvas_document"]);
  });
  it("reads live state each time and returns an independent document", () => {
    const { state, call } = setup();
    const result = call("get_canvas_document") as { document: typeof state.doc };
    result.document.title = "changed clone";
    expect(state.doc.title).toBe("");
    state.doc.title = "latest";
    expect(call("get_canvas_document")).toMatchObject({ document: { title: "latest" } });
  });
  it("uses the editor's real widths and language, then honors edited and empty prompts", () => {
    const { state, call } = setup();
    expect(call("get_canvas_prompt")).toMatchObject({ prompt: effectivePrompt(state.doc, state.widths, "en"), source: "generated" });
    expect(effectivePrompt(state.doc, state.widths, "en")).not.toBe(effectivePrompt(state.doc, {}, "en"));
    for (const promptEdit of ["custom", ""]) {
      state.doc.promptEdit = promptEdit;
      expect(call("get_canvas_prompt")).toMatchObject({ prompt: promptEdit, source: "edited" });
    }
  });
  it("stages a normalized proposal without changing live canvas, with a stale-state guard", () => {
    const { state, call, propose, revision } = setup();
    const before = json(state.doc);
    expect(call("preview_canvas_document", { document: { ...before, title: "Candidate" }, expectedRevision: revision() })).toMatchObject({ applied: false, status: "awaiting_user_confirmation" });
    expect(json(state.doc)).toEqual(before);
    expect(propose.mock.calls[0][0]).toMatchObject({ doc: { title: "Candidate" }, before: JSON.stringify(state.doc) });
  });
  it("rejects proposals based on an older read even before staging", () => {
    const { state, call, propose, revision } = setup();
    const expectedRevision = revision(); const candidate = json(state.doc);
    state.doc.title = "Concurrent human edit";
    expect(() => call("preview_canvas_document", { document: candidate, expectedRevision })).toThrow(/changed/);
    expect(state.doc.title).toBe("Concurrent human edit"); expect(propose).not.toHaveBeenCalled();
  });
  it("respects read-only tabs", () => {
    const { state, call, propose, revision } = setup(); state.editable = false;
    expect(() => call("preview_canvas_document", { document: json(state.doc), expectedRevision: revision() })).toThrow(/not editable/);
    expect(propose).not.toHaveBeenCalled();
  });
  it.each([null, [], { extra: true }, { document: {} }])("rejects extra or malformed read arguments %j", (input) => {
    expect(() => setup().call("get_canvas_document", input)).toThrow();
    expect(() => setup().call("get_canvas_prompt", input)).toThrow();
  });
  it.each([{}, { document: {} }, { document: {}, apply: true }, { document: { groups: [], frames: [], title: 5 } }, { document: { groups: [], frames: [], apiKey: "never" } }])("rejects malformed proposals without mutations %j", (input) => {
    const { state, call, propose, revision } = setup(); const before = json(state.doc);
    expect(() => call("preview_canvas_document", input)).toThrow();
    expect(json(state.doc)).toEqual(before); expect(propose).not.toHaveBeenCalled();
  });
  it("rejects unsafe JSON, oversize, duplicate IDs and new resource URLs", () => {
    const doc = seed();
    const base = json(doc);
    const candidates = [
      { ...base, title: "a".repeat(1024 * 1024) },
      { ...base, groups: [...base.groups, ...base.groups] },
      { ...base, groups: [{ ...base.groups[0], items: [{ ...base.groups[0].items[0], src: "https://example.com/track" }] }] },
      JSON.parse('{"groups":[],"frames":[],"__proto__":{}}'),
      { ...base, theme: { dark: Infinity } },
    ];
    for (const candidate of candidates) expect(() => validateCanvasCandidate(candidate, doc)).toThrow();
    const getter = { ...base, get title() { throw new Error("accessor invoked"); } };
    expect(() => validateCanvasCandidate(getter, doc)).toThrow("Unsafe JSON field.");
  });
  it("preserves existing images without fetching them", () => {
    const doc = seed(); doc.groups[0].items[0].src = "https://example.com/existing.png";
    expect(validateCanvasCandidate(json(doc), doc).groups[0].items[0].src).toBe(doc.groups[0].items[0].src);
  });
  it("registers all tools with abort cleanup; abort prevents later registration", async () => {
    const tools = setup().tools; const registerTool = vi.fn(); const lifecycle = new AbortController();
    await registerCanvasTools({ registerTool }, tools, lifecycle.signal);
    expect(registerTool).toHaveBeenCalledTimes(3);
    expect(registerTool.mock.calls[0][1]).toEqual({ signal: lifecycle.signal });
    lifecycle.abort(); registerTool.mockClear();
    await registerCanvasTools({ registerTool }, tools, lifecycle.signal);
    expect(registerTool).not.toHaveBeenCalled();
  });
  it("propagates registration failure instead of claiming success", async () => {
    await expect(registerCanvasTools({ registerTool: () => { throw new Error("unsupported"); } }, setup().tools, new AbortController().signal)).rejects.toThrow("unsupported");
  });
});
