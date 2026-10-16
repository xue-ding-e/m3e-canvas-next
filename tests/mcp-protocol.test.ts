import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MAX_MCP_MESSAGE_BYTES } from "../cli/mcp";

const children: ChildProcessWithoutNullStreams[] = [];
afterEach(async () => {
  await Promise.all(children.splice(0).map(async (child) => {
    if (child.exitCode !== null) return;
    const exited = once(child, "exit");
    child.kill();
    await exited;
  }));
});

function connection() {
  const child = spawn(process.execPath, [resolve("dist-headless/cli/mcp.js")], { stdio: "pipe" });
  children.push(child);
  let stdout = "", stderr = "", pending = "";
  let nextId = 0;
  const waiters = new Map<number, { resolve: (message: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    pending += chunk;
    let end: number;
    while ((end = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      try {
        const message = JSON.parse(line);
        const waiter = waiters.get(message.id);
        if (waiter) {
          clearTimeout(waiter.timer);
          waiters.delete(message.id);
          waiter.resolve(message);
        }
      } catch {
        for (const waiter of waiters.values()) waiter.reject(new Error(`Non-JSON stdout: ${line}`));
      }
    }
  });
  function notify(method: string, params?: unknown) { child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }) + "\n"); }
  function request(method: string, params?: unknown): Promise<any> {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiters.delete(id); reject(new Error(`Timed out: ${method}; stderr=${stderr}`)); }, 5000);
      waiters.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }) + "\n");
    });
  }
  async function initialize() {
    const response = await request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "protocol-test", version: "1.0.0" } });
    expect(response.result.protocolVersion).toBe("2025-11-25");
    expect(response.result.capabilities.tools).toBeDefined();
    notify("notifications/initialized");
    return response;
  }
  return { child, request, notify, initialize, stdout: () => stdout, stderr: () => stderr };
}
const doc = { title: "Test", brief: "Private sketch", paletteKey: "purple", frame: "phone", groups: [], frames: [] };
const decoded = (response: any) => JSON.parse(response.result.content[0].text);

describe("MCP stdio wire protocol", () => {
  it("interoperates with the official SDK client and preserves an explicitly empty prompt", async () => {
    const client = new Client({ name: "sdk-integration-test", version: "1.0.0" });
    const transport = new StdioClientTransport({ command: process.execPath, args: [resolve("dist-headless/cli/mcp.js")], stderr: "pipe" });
    let stderr = "";
    transport.stderr?.on("data", (chunk) => { stderr += chunk; });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools).toHaveLength(7);
      const response = await client.callTool({ name: "generate_prompt", arguments: { doc: { ...doc, promptEdit: "" } } });
      expect(response.isError).not.toBe(true);
      expect(response.structuredContent).toMatchObject({ prompt: "", mode: "effective" });
      expect((await client.listResources()).resources).toHaveLength(1);
      expect(stderr).toBe("");
    } finally {
      await client.close();
    }
  });
  it("edits a design through the official SDK using discovered schemas and revision protection", async () => {
    const client = new Client({ name: "design-sdk-test", version: "1.0.0" });
    const transport = new StdioClientTransport({ command: process.execPath, args: [resolve("dist-headless/cli/mcp.js")], stderr: "pipe" });
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await client.callTool({ name, arguments: args });
      expect(response.isError).not.toBe(true);
      return response.structuredContent as Record<string, any>;
    };
    try {
      await client.connect(transport);
      const catalog = await call("design_catalog", { lang: "en" });
      expect(catalog.supported).toContain("item.update");
      expect(catalog.schemas.transaction.properties.version.const).toBe(1);
      expect(catalog.unsupported.length).toBeGreaterThan(0);
      const created = await call("create_project", { options: { title: "MCP design" } });
      const original = JSON.stringify(created.doc);
      const inspected = await call("inspect_project", { doc: created.doc });
      expect(inspected.revision).toBe(created.revision);
      const edited = await call("apply_operations", { doc: created.doc, transaction: {
        version: 1, expectedRevision: inspected.revision, operations: [
          { op: "frame.add", frame: { id: "home", name: "Home", x: 0, y: 0 } },
          { op: "group.add", group: { id: "content", x: 30, y: 60, axis: "y", items: [{ id: "save", kind: "button", label: "Save" }] } },
          { op: "item.update", id: "save", set: { label: "Continue" } },
        ],
      } });
      expect(edited.doc.groups[0].items[0].label).toBe("Continue");
      expect(edited.changes).toHaveLength(3);
      expect(edited.previousRevision).toBe(created.revision);
      expect(edited.revision).not.toBe(created.revision);
      expect(JSON.stringify(created.doc)).toBe(original);
      const final = await call("inspect_project", { doc: edited.doc });
      expect(final.counts).toEqual({ frames: 1, groups: 1, items: 1 });
      expect(final.revision).toBe(edited.revision);
      const stale = await client.callTool({ name: "apply_operations", arguments: { doc: edited.doc, transaction: { version: 1, expectedRevision: created.revision, operations: [{ op: "project.update", set: { title: "stale edit" } }] } } });
      expect(stale.isError).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("rejects invalid editing batches atomically, guards manual prompts and exposes no I/O tool", async () => {
    const c = connection();
    await c.initialize();
    const call = (transaction: unknown, value: unknown = doc) => c.request("tools/call", { name: "apply_operations", arguments: { doc: value, transaction } });
    for (const transaction of [
      { version: 2, operations: [{ op: "prompt.clear" }] },
      { version: 1, operations: [] },
      { version: 1, operations: Array.from({ length: 201 }, () => ({ op: "prompt.clear" })) },
      { version: 1, operations: [{ op: "project.update", set: { title: "partial" } }, { op: "item.remove", id: "absent" }] },
      { version: 1, operations: [{ op: "read_file", path: "/etc/passwd" }] },
      { version: 1, operations: [{ op: "project.update", set: { title: "edit" } }], outputPath: "/tmp/must-not-write" },
    ]) {
      const response = await call(transaction);
      expect(response.result?.isError === true || response.error?.code === -32602).toBe(true);
      expect(response.result?.structuredContent?.doc).toBeUndefined();
    }
    const manual = { ...doc, promptEdit: "Custom manual prompt" };
    const operations = [{ op: "project.update", set: { title: "Changed" } }];
    expect((await call({ version: 1, operations }, manual)).result.isError).toBe(true);
    const preserved = decoded(await call({ version: 1, operations, promptEditPolicy: "preserve" }, manual));
    expect(preserved.doc.promptEdit).toBe(manual.promptEdit);
    expect(preserved.warnings.length).toBeGreaterThan(0);
    const cleared = decoded(await call({ version: 1, operations, promptEditPolicy: "clear" }, manual));
    expect(cleared.doc.promptEdit).toBeUndefined();
    expect(manual.title).toBe("Test");
    const inspected = decoded(await c.request("tools/call", { name: "inspect_project", arguments: { doc } }));
    expect(inspected.doc.title).toBe("Test");
    expect((await c.request("ping")).result).toEqual({});
    expect(c.stderr()).toBe("");
  });

  it("initializes, lists exactly the safe tools, calls them, and emits only JSON-RPC on stdout", async () => {
    const c = connection();
    await c.initialize();
    const list = await c.request("tools/list");
    expect(list.result.tools.map((tool: any) => tool.name).sort()).toEqual(["apply_operations", "create_project", "create_share_link", "design_catalog", "generate_prompt", "inspect_project", "validate_project"]);
    for (const tool of list.result.tools) {
      if (!["create_project", "design_catalog"].includes(tool.name)) expect(tool.inputSchema.required).toContain("doc");
      expect(tool.annotations.readOnlyHint).toBe(true);
      expect(tool.annotations.openWorldHint).toBe(false);
    }
    const validated = await c.request("tools/call", { name: "validate_project", arguments: { doc } });
    expect(decoded(validated)).toMatchObject({ valid: true, doc: { title: "Test" } });
    expect(validated.result.structuredContent).toEqual(decoded(validated));
    const prompt = await c.request("tools/call", { name: "generate_prompt", arguments: { doc: { ...doc, promptEdit: "Keep my manual prompt" } } });
    expect(decoded(prompt)).toMatchObject({ prompt: "Keep my manual prompt", mode: "effective", lang: "en" });
    const generated = await c.request("tools/call", { name: "generate_prompt", arguments: { doc: { ...doc, promptEdit: "Keep my manual prompt" }, mode: "generated", lang: "zh" } });
    expect(decoded(generated).prompt).not.toBe("Keep my manual prompt");
    const link = await c.request("tools/call", { name: "create_share_link", arguments: { doc, baseUrl: "https://example.invalid/canvas/" } });
    expect(decoded(link).url).toMatch(/^https:\/\/example\.invalid\/canvas\/#docz?=/);
    const resources = await c.request("resources/list");
    expect(resources.result.resources).toHaveLength(1);
    const guide = await c.request("resources/read", { uri: "m3e://guide" });
    expect(guide.result.contents[0].text).toContain("not live browser synchronization");
    expect(c.stderr()).toBe("");
    for (const line of c.stdout().trim().split("\n")) expect(JSON.parse(line).jsonrpc).toBe("2.0");
  });

  it("reports invalid arguments and project errors and remains usable", async () => {
    const c = connection();
    await c.initialize();
    for (const args of [{}, { doc: "file.json" }, { doc, path: "/etc/passwd" }, { doc, lang: "xx" }]) {
      const response = await c.request("tools/call", { name: "generate_prompt", arguments: args });
      expect(response.result?.isError === true || response.error?.code === -32602).toBe(true);
    }
    for (const [name, args] of [
      ["validate_project", { doc: {} }],
      ["generate_prompt", { doc, frameId: "missing" }],
      ["generate_prompt", { doc, frameId: "missing", mode: "generated" }],
      ["create_share_link", { doc, baseUrl: "file:///etc/passwd" }],
      ["create_share_link", { doc, baseUrl: "https://user:password@example.invalid/" }],
    ] as const) {
      const response = await c.request("tools/call", { name, arguments: args });
      expect(response.result.isError).toBe(true);
      expect(decoded(response).error.code).toBeTruthy();
    }
    const unknown = await c.request("tools/call", { name: "read_file", arguments: { path: "/etc/passwd" } });
    expect(unknown.result?.isError === true || unknown.error?.code === -32602).toBe(true);
    const unsupported = await c.request("not/a/method");
    expect(unsupported.error.code).toBe(-32601);
    c.child.stdin.write("malformed JSON\n");
    const ping = await c.request("ping");
    expect(ping.result).toEqual({});
  });

  it("returns migration warnings and bounds document resources without killing the server", async () => {
    const c = connection();
    await c.initialize();
    const legacy = await c.request("tools/call", { name: "validate_project", arguments: { doc: { groups: [], frames: [] } } });
    expect(decoded(legacy).warnings.length).toBeGreaterThan(0);
    const oversized = await c.request("tools/call", { name: "validate_project", arguments: { doc: { ...doc, brief: "x".repeat(1024 * 1024 + 1) } } });
    expect(oversized.result.isError).toBe(true);
    let nested: unknown = "leaf";
    for (let i = 0; i < 70; i++) nested = { child: nested };
    const tooDeep = await c.request("tools/call", { name: "validate_project", arguments: { doc: { ...doc, nested } } });
    expect(tooDeep.result.isError).toBe(true);
    expect((await c.request("ping")).result).toEqual({});
  });

  it("rejects an oversized wire line before parsing and keeps project content off stderr", async () => {
    const c = connection();
    await c.initialize();
    const exited = once(c.child, "exit");
    c.child.stdin.on("error", () => {});
    c.child.stdin.write("secret-marker" + "x".repeat(MAX_MCP_MESSAGE_BYTES));
    const [code] = await exited;
    expect(code).toBe(1);
    expect(c.stderr()).toContain("MCP input rejected");
    expect(c.stderr()).not.toContain("secret-marker");
    for (const line of c.stdout().trim().split("\n")) expect(JSON.parse(line).jsonrpc).toBe("2.0");
  });
});
