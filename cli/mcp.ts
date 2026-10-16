#!/usr/bin/env node
import { Transform, type TransformCallback } from "node:stream";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { HeadlessError, normalizeProject, projectPrompt, projectShareLink } from "../lib/headless";

/** Limit the wire input before the SDK buffers or parses a complete JSON line. */
export const MAX_MCP_MESSAGE_BYTES = 2 * 1024 * 1024;
export class BoundedMcpInput extends Transform {
  private lineBytes = 0;
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
    let start = 0;
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] !== 10) continue;
      if (this.lineBytes + i - start > MAX_MCP_MESSAGE_BYTES) {
        callback(new Error("MCP message exceeds 2 MiB limit"));
        return;
      }
      this.lineBytes = 0;
      start = i + 1;
    }
    this.lineBytes += chunk.length - start;
    if (this.lineBytes > MAX_MCP_MESSAGE_BYTES) {
      callback(new Error("MCP message exceeds 2 MiB limit"));
      return;
    }
    callback(null, chunk);
  }
}

export const AGENT_GUIDE = `M3E Canvas headless tools accept an explicit exported project JSON object in doc.
They do not access browser tabs, browser storage, files, network endpoints, or model credentials.
validate_project returns the normalized project and warns when normalization changes it.
generate_prompt defaults to mode=effective and lang=en. Effective mode preserves a saved promptEdit;
use mode=generated explicitly to regenerate. Choose frameId only with mode=generated when asking for one frame.
create_share_link requires an explicit baseUrl and only returns a URL; it never opens or fetches it.
A share link contains project content; review it before sharing. It is not encryption or access control.
Use the browser's project import to load returned JSON, or open a returned link yourself.
This is standard process-based MCP over stdio, not WebMCP and not live browser synchronization.`;

const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const documentSchema = z.record(z.string(), z.unknown()).describe("Exported M3E Canvas project JSON object, not a filename or URL");
const result = (value: Record<string, unknown>) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value });
async function invoke(work: () => Record<string, unknown> | Promise<Record<string, unknown>>) {
  try {
    return result(await work());
  } catch (error) {
    const code = error instanceof HeadlessError ? error.code : "INTERNAL_ERROR";
    const message = error instanceof HeadlessError ? error.message : "Unable to process project";
    return { ...result({ error: { code, message } }), isError: true };
  }
}

/** No tool retains the document after its call, and none performs external I/O. */
export function createMcpServer() {
  const server = new McpServer({ name: "m3e-canvas", version: "0.1.0" });
  server.registerTool("validate_project", {
    description: "Validate and normalize an explicitly supplied M3E Canvas project; return the normalized document and migration warning.",
    inputSchema: z.object({ doc: documentSchema }).strict(), annotations,
  }, ({ doc }) => invoke(() => {
    const normalized = normalizeProject(doc);
    const changed = JSON.stringify(doc) !== JSON.stringify(normalized);
    return { valid: true, doc: normalized, warnings: changed ? ["Project normalization applied defaults or migrations; use the returned doc."] : [] };
  }));
  server.registerTool("generate_prompt", {
    description: "Return a coding prompt from explicit project JSON. Defaults: effective mode (preserves saved promptEdit), English. No model call.",
    inputSchema: z.object({ doc: documentSchema, lang: z.enum(["en", "ja", "zh", "ko"]).default("en"), frameId: z.string().min(1).optional(), mode: z.enum(["effective", "generated"]).default("effective") }).strict(), annotations,
  }, ({ doc, lang, frameId, mode }) => invoke(() => ({ prompt: projectPrompt(doc, { lang, frameId, mode }), lang, mode, ...(frameId ? { frameId } : {}) })));
  server.registerTool("create_share_link", {
    description: "Encode explicit project JSON in a share URL for the supplied baseUrl. Returns only; never fetches, opens, or publishes. The link contains project content.",
    inputSchema: z.object({ doc: documentSchema, baseUrl: z.string().min(1).max(4096) }).strict(), annotations,
  }, ({ doc, baseUrl }) => invoke(async () => ({ url: await projectShareLink(doc, baseUrl) })));
  server.registerResource("agent-guide", "m3e://guide", { description: "Headless JSON exchange workflow and limitations", mimeType: "text/plain" }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/plain", text: AGENT_GUIDE }] }));
  return server;
}

export async function startMcpServer() {
  const input = new BoundedMcpInput();
  const server = createMcpServer();
  input.on("error", () => {
    // Never echo malformed protocol data or project content to diagnostics.
    process.stderr.write("MCP input rejected: message exceeds limit or stream failed\n");
    process.exitCode = 1;
    process.stdin.unpipe(input);
    process.stdin.destroy();
    void server.close();
  });
  process.stdin.pipe(input);
  await server.connect(new StdioServerTransport(input, process.stdout));
  process.stdin.on("end", () => { void server.close(); });
}

if (require.main === module) {
  startMcpServer().catch(() => {
    process.stderr.write("Unable to start M3E Canvas MCP server\n");
    process.exitCode = 1;
  });
}
