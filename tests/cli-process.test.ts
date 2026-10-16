import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const entry = resolve("dist-headless/cli/main.js");
const dir = mkdtempSync(join(tmpdir(), "m3e-cli-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const doc = { groups: [], frames: [{ id: "home", name: "Home", x: 0, y: 0 }] };
const run = (args: string[], input = JSON.stringify(doc)) => spawnSync(process.execPath, [entry, ...args], { input, encoding: "utf8", timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });

describe("actual CLI process", () => {
  it("prints help and version without parsing input", () => {
    for (const args of [["--help"], [], ["--version"]]) {
      const result = run(args, "bad JSON");
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toMatch(/m3e.canvas/i);
    }
  });
  it("validates stdin and file input as normalized JSON", () => {
    const file = join(dir, "project.json");
    writeFileSync(file, JSON.stringify(doc));
    for (const args of [["validate"], ["validate", "-"], ["validate", file]]) {
      const result = run(args);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({ title: "", frames: doc.frames });
    }
  });
  it("defaults to effective text and preserves an explicitly empty edit", () => {
    for (const promptEdit of ["Hand-edited prompt", ""]) {
      const result = run(["prompt"], JSON.stringify({ ...doc, promptEdit }));
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(promptEdit ? promptEdit + "\n" : "");
      expect(result.stderr).toBe("");
    }
  });
  it("generates localized frame prompts and compatible share links", () => {
    const result = run(["prompt", "--lang", "zh", "--mode", "generated", "--frame", "home"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("## 配色");
    const share = run(["share", "--base", "https://example.com/"]);
    expect(share.status).toBe(0);
    expect(share.stdout).toMatch(/^https:\/\/example.com\/#docz?=/);
  });
  it.each([
    [["oops"], "{}", 2, "USAGE"],
    [["validate", "--lang", "en"], "{}", 2, "USAGE"],
    [["share"], "{}", 2, "USAGE"],
    [["prompt", "--frame", "--help"], "{}", 2, "USAGE"],
    [["validate", "--", "--help"], "{}", 4, "INPUT_ERROR"],
    [["validate"], "{", 3, "INVALID_JSON"],
    [["validate"], "{}", 3, "INVALID_PROJECT"],
    [["prompt", "--frame", "home"], JSON.stringify(doc), 2, "INVALID_OPTIONS"],
    [["prompt", "--mode", "generated", "--frame", "wrong"], JSON.stringify(doc), 2, "UNKNOWN_FRAME"],
    [["prompt", "--lang", "xx"], JSON.stringify(doc), 2, "INVALID_OPTIONS"],
    [["validate", join(dir, "missing.json")], "", 4, "INPUT_ERROR"],
    [["validate"], " ".repeat(1024 * 1024 + 1), 3, "INVALID_PROJECT"],
  ] as const)("classifies errors without contaminating stdout (%s)", (args, input, status, code) => {
    const result = run([...args], input);
    expect(result.status).toBe(status);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr).error.code).toBe(code);
    expect(result.stderr).not.toContain(" at ");
  });
});
