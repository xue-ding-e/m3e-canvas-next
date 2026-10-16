"use client";

import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { canvasTools, registerCanvasTools, type CanvasProposal, type CanvasState, type WebMcpRegistry } from "../lib/browserTools";
import { MAX_PROJECT_BYTES } from "../lib/headless";
import type { Doc } from "../lib/tokens";

type Props = CanvasState & { apply: (doc: Doc) => void };

/** Progressive enhancement: the manual review flow also works without a host API. */
export function BrowserTools(props: Props) {
  const latest = useRef(props);
  latest.current = props;
  const [status, setStatus] = useState("Checking site tools…");
  const [pending, setPending] = useState<CanvasProposal | null>(null);
  const pendingRef = useRef<CanvasProposal | null>(null);
  const [input, setInput] = useState("");
  const inputRevision = useRef<string | null>(null);
  const [output, setOutput] = useState("");
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const toolsRef = useRef<ReturnType<typeof canvasTools> | null>(null);
  if (!toolsRef.current) toolsRef.current = canvasTools(() => latest.current, (proposal) => {
    if (pendingRef.current) throw new Error("Review or cancel the existing proposal first.");
    pendingRef.current = proposal;
    flushSync(() => { setPending(proposal); setError(""); });
  });
  const tools = toolsRef.current;

  useEffect(() => {
    if (window.top !== window.self) { setStatus("Open the top-level page to use site tools."); return; }
    const registry = (document as Document & { modelContext?: WebMcpRegistry }).modelContext;
    if (typeof registry?.registerTool !== "function") {
      setStatus("Site tools unavailable in this browser. Use the manual controls below.");
      return;
    }
    const lifecycle = new AbortController();
    void registerCanvasTools(registry, tools, lifecycle.signal).then(() => {
      if (!lifecycle.signal.aborted) setStatus("3 site tools registered. Changes always require your review here.");
    }).catch(() => {
      if (lifecycle.signal.aborted) return;
      lifecycle.abort();
      setStatus("Site-tool registration failed. Manual controls remain available.");
    });
    return () => lifecycle.abort();
  }, [tools]);
  useEffect(() => {
    if (pending && dialog.current && !dialog.current.open) dialog.current.showModal();
  }, [pending]);

  const cancel = () => { pendingRef.current = null; setPending(null); setError(""); };
  const run = (name: string, args: unknown) => {
    try { setError(""); const result = tools.find((tool) => tool.name === name)!.execute(args); setOutput(JSON.stringify(result, null, 2)); }
    catch (e) { setError(e instanceof Error ? e.message : "Unable to complete this action."); }
  };
  const stale = pending !== null && pending.before !== JSON.stringify(props.doc);
  return <>
    <details className="m3e-browser-tools" data-testid="browser-tools">
      <summary>ChatGPT / Site tools</summary>
      <p role="status">{status}</p>
      <p>Only the current canvas and prompt are exposed. No AI settings or API keys. Keep this page open in ChatGPT’s built-in browser to use supported site tools.</p>
      <button type="button" onClick={() => run("get_canvas_document", {})}>Read canvas JSON</button>{" "}
      <button type="button" onClick={() => run("get_canvas_prompt", {})}>Read current prompt</button>
      <label>Candidate document JSON (maximum 1 MiB)
        <textarea aria-label="Candidate document JSON" value={input} maxLength={MAX_PROJECT_BYTES} onChange={(event) => {
          if (!inputRevision.current) inputRevision.current = (tools[0].execute({}) as { revision: string }).revision;
          setInput(event.target.value);
          if (!event.target.value) inputRevision.current = null;
        }} />
      </label>
      <button type="button" disabled={!props.editable || !!pending} onClick={() => {
        try { run("preview_canvas_document", { document: JSON.parse(input), expectedRevision: inputRevision.current }); }
        catch { setError("Enter valid JSON."); }
      }}>Review candidate</button>{" "}
      <button type="button" disabled={!!pending} onClick={() => { setInput(""); inputRevision.current = null; setError(""); }}>Clear candidate / start again</button>
      <p>If the canvas changed, clear the candidate and prepare a fresh one from the latest canvas JSON.</p>
      {output && <textarea aria-label="Site tools output" readOnly value={output} />}
      {error && !pending && <p role="alert">{error}</p>}
    </details>
    {pending && <dialog className="m3e-candidate-dialog" ref={dialog} aria-labelledby="candidate-title" onCancel={(event) => { event.preventDefault(); cancel(); }} onKeyDown={(event) => event.stopPropagation()}>
      <h2 id="candidate-title">Review candidate canvas</h2>
      <p>This will replace your current canvas only when you click Apply. Cancel leaves your canvas unchanged. After applying, use the editor’s Undo to restore it.</p>
      <p>{props.doc.frames.length} → {pending.doc.frames.length} frames; {props.doc.groups.length} → {pending.doc.groups.length} groups</p>
      <p>Title: {pending.doc.title || "(untitled)"}</p>
      <p>JSON preview, including all proposed fields:</p>
      <pre tabIndex={0}>{JSON.stringify(pending.doc, null, 2)}</pre>
      {stale && <p role="alert">The canvas changed since this proposal. Cancel and submit a fresh proposal.</p>}
      {error && <p role="alert">{error}</p>}
      <button type="button" onClick={cancel}>Cancel</button>{" "}
      <button type="button" disabled={stale || !props.editable} onClick={(event) => {
        // No tool or exported function can approve a proposal. A page interaction
        // and a fresh canvas/access check are required at the moment of applying.
        if (!event.isTrusted || !latest.current.editable || pending.before !== JSON.stringify(latest.current.doc)) return;
        latest.current.apply(structuredClone(pending.doc));
        inputRevision.current = null;
        setInput("");
        cancel();
        setOutput("Candidate applied. Use the editor’s Undo to restore the previous canvas.");
      }}>Apply candidate</button>
    </dialog>}
  </>;
}
