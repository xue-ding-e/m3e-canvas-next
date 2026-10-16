"use client";

import { Frame, Group, Palette, frameOfGroup, frameSizeOf, frameLengthOf, layoutOf, freeRadii, MEASURED, GAP, connectSpecOf, uniformRadii, baseRadii, sizeOf } from "@/lib/tokens";
import { modalRailOf } from "@/lib/rail";
import { M3Static } from "./M3Node";

/** Shared by editor PNG export and the offline CLI renderer. */
export function ExportFrame({ frame: f, groups, frames, widths, palette: p }: { frame: Frame; groups: Group[]; frames: Frame[]; widths: Record<string, number>; palette: Palette }) {
    const gs = groups.filter((g) => frameOfGroup(g, frames, widths)?.id === f.id);
    const { w } = frameSizeOf(f);
    const h = frameLengthOf(f);
    return (
      <div
        data-export={f.id}
        style={{
          position: "relative",
          width: w,
          height: h,
          background: p[f.bg ?? "surface"],
          overflow: "hidden",
        }}
      >
        {gs.map((g) =>
          g.free ? (
            ((corners) =>
            layoutOf(g, widths).map((pl) => (
              <div key={pl.item.id} style={{ position: "absolute", left: pl.x - f.x, top: pl.y - f.y, zIndex: modalRailOf(g) ? 2 : undefined }}>
                <M3Static
                  item={pl.item}
                  palette={p}
                  radii={corners.get(pl.item.id)}
                  style={MEASURED.includes(pl.item.kind) ? undefined : { width: pl.w, height: pl.h }}
                />
              </div>
            )))(freeRadii(g, widths))
          ) : (
          <div
            key={g.id}
            style={{
              position: "absolute",
              left: g.x - f.x,
              top: g.y - f.y,
              zIndex: modalRailOf(g) ? 2 : undefined,
              display: "flex",
              flexDirection: g.axis === "x" ? "row" : "column",
              alignItems: g.axis === "x" ? "center" : "stretch",
              gap: GAP,
            }}
          >
            {g.items.map((it, i) => {
              const conn = connectSpecOf(it);
              const n = g.items.length;
              const radii =
                conn && n > 1
                  ? (g.axis === "x" ? { tl: i === 0 ? conn.outer : conn.inner, bl: i === 0 ? conn.outer : conn.inner, tr: i === n - 1 ? conn.outer : conn.inner, br: i === n - 1 ? conn.outer : conn.inner } : { tl: i === 0 ? conn.outer : conn.inner, tr: i === 0 ? conn.outer : conn.inner, bl: i === n - 1 ? conn.outer : conn.inner, br: i === n - 1 ? conn.outer : conn.inner })
                  : conn
                    ? uniformRadii(conn.outer)
                    : baseRadii(it);
              return (
                <M3Static
                  key={it.id}
                  item={it}
                  palette={p}
                  radii={radii}
                  style={MEASURED.includes(it.kind) ? undefined : { width: sizeOf(it, widths).w, height: sizeOf(it, widths).h }}
                />
              );
            })}
          </div>
          ),
        )}
        {gs.some((g) => modalRailOf(g)) && (
          <div aria-hidden style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.32)", pointerEvents: "none", zIndex: 1 }} />
        )}
      </div>
    );
  }
