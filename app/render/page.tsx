"use client";

import { useEffect, useRef, useState } from "react";
import { ExportFrame } from "@/components/ExportFrame";
import { MeasuredContent } from "@/components/M3Node";
import { ThemeContext } from "@/lib/theme";
import { LangContext } from "@/lib/i18n";
import { configureRenderTheme, renderFontFamily, assertRenderGlyphs } from "@/lib/renderContract";
import { isMeasured, paletteOf, type Doc } from "@/lib/tokens";

type Payload = { doc: Doc; frameId: string; fontMode: "strict" | "system" };
declare global {
  interface Window {
    __M3E_RENDER_INPUT__?: Payload;
    __M3E_RENDER_STATE__?: { status: "loading" | "ready" | "error"; measuredWidths?: Record<string, number>; error?: string };
  }
}
/** Dedicated offline surface: no editor store, AI client, browser tools, or actions. */
export default function RenderPage() {
  const [payload, setPayload] = useState<Payload>();
  const [widths, setWidths] = useState<Record<string, number>>();
  const measure = useRef<HTMLDivElement>(null);
  useEffect(() => {
    window.__M3E_RENDER_STATE__ = { status: "loading" };
    if (!window.__M3E_RENDER_INPUT__) { window.__M3E_RENDER_STATE__ = { status: "error", error: "Missing CLI render payload." }; return; }
    setPayload(window.__M3E_RENDER_INPUT__);
  }, []);
  useEffect(() => {
    if (!payload || !measure.current) return;
    let active = true;
    void (async () => {
      try {
        const textFamily = renderFontFamily(payload.doc, payload.fontMode).split(",")[0];
        const families = ["Noto Sans SC", "Material Symbols Rounded", ...(payload.fontMode === "strict" ? [textFamily] : [])];
        for (const family of families) for (const weight of [400, 500, 600, 700]) {
          const loaded = await document.fonts.load(`${weight} 16px "${family}"`, family === "Noto Sans SC" ? "中文" : family === "Material Symbols Rounded" ? "home" : "M3E");
          if (!loaded.length || loaded.some((font) => font.status !== "loaded")) throw new Error("Pinned font failed to load: " + family);
        }
        await document.fonts.ready;
        if (!active) return;
        const next: Record<string, number> = {};
        measure.current?.querySelectorAll<HTMLElement>("[data-measure]").forEach((el) => { next[el.dataset.measure!] = Math.ceil(el.getBoundingClientRect().width); });
        setWidths(next);
      } catch (error) { if (active) window.__M3E_RENDER_STATE__ = { status: "error", error: error instanceof Error ? error.message : "Font load failed." }; }
    })();
    return () => { active = false; };
  }, [payload]);
  useEffect(() => {
    if (!widths || !payload) return;
    let active = true;
    void (async () => {
      try {
        await document.fonts.ready;
        if (payload.fontMode === "strict") {
          const root = document.querySelector("[data-export]");
          if (!root) throw new Error("Render surface missing.");
          const texts: string[] = [];
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) if (!walker.currentNode.parentElement?.closest(".msr")) texts.push(walker.currentNode.textContent ?? "");
          assertRenderGlyphs(payload.doc, texts, Array.from(root.querySelectorAll(".msr")).map((node) => node.textContent?.trim() ?? ""));
        }
        await Promise.all(Array.from(document.images).map((img) => img.decode()));
        let pixels = 0;
        for (const img of Array.from(document.images)) {
          pixels += img.naturalWidth * img.naturalHeight;
          if (img.naturalWidth > 8192 || img.naturalHeight > 8192 || pixels > 32000000) throw new Error("Image pixel budget exceeded.");
        }
        // Freeze all finite/infinite CSS/Web Animations at the initial visual state.
        document.getAnimations().forEach((animation) => { animation.pause(); animation.currentTime = 0; });
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        if (active) window.__M3E_RENDER_STATE__ = { status: "ready", measuredWidths: widths };
      } catch (error) { if (active) window.__M3E_RENDER_STATE__ = { status: "error", error: error instanceof Error ? error.message : "Image decode or font readiness failed." }; }
    })();
    return () => { active = false; };
  }, [widths, payload]);
  if (!payload) return null;
  const { doc, frameId } = payload;
  const frame = doc.frames.find((f) => f.id === frameId);
  if (!frame) return null;
  const theme = configureRenderTheme(doc, payload.fontMode);
  const palette = paletteOf(doc.paletteKey, doc.customPalette, theme);
  return <LangContext.Provider value="en"><ThemeContext.Provider value={theme}>
    <style>{`html,body{margin:0!important;padding:0!important;overflow:hidden!important;background:white!important}*{animation:none!important;transition:none!important;caret-color:transparent!important}`}</style>
    <main style={{ fontFamily: renderFontFamily(doc, payload.fontMode), pointerEvents: "none" }}>
      <div ref={measure} aria-hidden style={{ position: "absolute", left: -99999, top: 0, visibility: "hidden" }}>
        {doc.groups.flatMap((g) => g.items).filter(isMeasured).map((item) => <div key={item.id} data-measure={item.id} style={{ display: "inline-flex", boxSizing: "border-box", border: item.variant === "outlined" && ["button", "chip", "extendedFab"].includes(item.kind) ? "1px solid transparent" : "none" }}><MeasuredContent item={item} p={palette} /></div>)}
      </div>
      {widths && <ExportFrame frame={frame} groups={doc.groups} frames={doc.frames} widths={widths} palette={palette} />}
    </main>
  </ThemeContext.Provider></LangContext.Provider>;
}
