import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RENDER_FONT_FILES, RENDER_FONT_BUNDLE_SHA256 } from "../lib/renderFonts";

describe("pinned offline fonts (asset integrity, not browser acceptance)", () => {
  const root = join(process.cwd(), "public/render-fonts");
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  it("verifies every font/CSS byte against the runtime whitelist", () => {
    expect(manifest.files).toEqual(RENDER_FONT_FILES);
    let total = 0;
    for (const [name, expected] of Object.entries(RENDER_FONT_FILES)) {
      expect(name).toMatch(/^[a-z0-9.-]+\.(woff2|css)$/);
      const bytes = readFileSync(join(root, name)); total += bytes.length;
      expect(bytes.length).toBe(expected.bytes);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(expected.sha256);
    }
    expect(total).toBe(manifest.totalRuntimeBytes);
    expect(total).toBeLessThan(12 * 1024 * 1024);
    expect(RENDER_FONT_BUNDLE_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });
  it("preserves OFL copyright licenses and Google's original Apache license", () => {
    for (const name of ["roboto", "roboto-flex", "roboto-serif", "noto-sans-sc"]) {
      const license = readFileSync(join(root, "licenses", name + "-OFL-1.1.txt"), "utf8");
      expect(license).toContain("SIL OPEN FONT LICENSE");
      expect(license).toMatch(/Copyright/i);
    }
    expect(readFileSync(join(root, "licenses/material-symbols-Apache-2.0.txt"), "utf8")).toContain("Apache License");
    expect(manifest.packages.find((p: { package: string }) => p.package === "google/material-design-icons").version).toBe("49d4db35df873165d6bd6ba09b063c7dafbac2f4");
  });
  it("uses only local pinned font URLs with blocking font display", () => {
    const css = readFileSync(join(root, "fonts.css"), "utf8");
    expect(css).not.toMatch(/https?:|@import/);
    expect(css).not.toContain("font-display: swap");
    for (const match of css.matchAll(/url\(['"]?([^)'"\s]+)['"]?\)/g)) {
      expect(match[1]).toMatch(/^\/render-fonts\//);
      expect(RENDER_FONT_FILES[match[1].slice("/render-fonts/".length)]).toBeDefined();
    }
  });
});
