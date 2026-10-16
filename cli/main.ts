#!/usr/bin/env node
import { readFile, stat } from "node:fs/promises";
import { HeadlessError, MAX_PROJECT_BYTES, parseProject, projectPrompt, projectShareLink, type PromptOptions } from "../lib/headless";
import { applyOperations, createProject, designCatalog, inspectProject } from "../lib/design";
import type { Lang } from "../lib/i18n";

const HELP = `M3E Canvas headless CLI

Usage:
  node dist-headless/cli/main.js create [options.json|-]
  node dist-headless/cli/main.js catalog [--lang en|ja|zh|ko]
  node dist-headless/cli/main.js inspect [file|-]
  node dist-headless/cli/main.js apply [transaction.json|-]
  node dist-headless/cli/main.js validate [file|-]
  node dist-headless/cli/main.js prompt [file|-] [--lang en|ja|zh|ko]
      [--mode effective|generated] [--frame ID]
  node dist-headless/cli/main.js share [file|-] --base https://your-app/

Omit file or use - to read JSON from stdin. Use -- before a filename starting
with a dash. validate writes normalized project JSON; prompt writes plain text;
share writes a locally encoded link (no network request). create/inspect/catalog
write JSON; apply reads {doc, version:1, operations, expectedRevision?} and writes
{doc, revision, changes, warnings}. It never overwrites input. Errors go to stderr
as JSON. Redirect stdout to save a result. No browser storage is accessed.

Prompt defaults: English, effective (preserves promptEdit, including empty text).
--frame requires --mode generated. Layout uses estimated, not measured, widths.
Share uses the editor's codec: item-level picked images and frame/item rewrite
history are omitted. Other content remains; this is not a privacy scrubber.
Input is limited to 1 MiB and 64 nesting levels.

Exit codes: 0 success; 2 usage/options; 3 invalid JSON/project; 4 input/output;
5 unexpected failure. --help and --version do not read input.
`;

class CliError extends Error {
  constructor(public readonly code: string, public readonly exitCode: number, message: string) { super(message); }
}

function argumentsOf(args: string[]) {
  const command = args.shift();
  if (!["validate", "prompt", "share", "create", "catalog", "inspect", "apply"].includes(command ?? "")) throw new CliError("USAGE", 2, "Expected validate, prompt, or share. Use --help for usage.");
  const flags: Record<string, string> = {};
  let file: string | undefined;
  let literal = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!literal && arg === "--") { literal = true; continue; }
    if (!literal && arg.startsWith("--")) {
      const key = arg.slice(2);
      const allowed = command === "catalog" ? ["lang"] : command === "prompt" ? ["lang", "mode", "frame"] : command === "share" ? ["base"] : [];
      if (!allowed.includes(key) || flags[key] !== undefined || !args[i + 1] || args[i + 1].startsWith("--")) throw new CliError("USAGE", 2, `Unknown, duplicate, or missing-value option: ${arg}`);
      flags[key] = args[++i];
    } else {
      if (file !== undefined || (!literal && arg.startsWith("-") && arg !== "-")) throw new CliError("USAGE", 2, "Expected a single input file or - for stdin.");
      file = arg;
    }
  }
  if (command === "share" && !flags.base) throw new CliError("USAGE", 2, "share requires --base with your app URL.");
  return { command, flags, file: file ?? "-" };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || (args.length === 1 && ["--help", "-h"].includes(args[0])) || (args.length === 2 && ["validate", "prompt", "share", "create", "catalog", "inspect", "apply"].includes(args[0]) && ["--help", "-h"].includes(args[1]))) { process.stdout.write(HELP); return; }
  if (args.length === 1 && args[0] === "--version") { process.stdout.write("m3e-canvas 0.1.0\n"); return; }
  const { command, flags, file } = argumentsOf(args);
  if (command === "create" && file === "-" && process.stdin.isTTY) { process.stdout.write(JSON.stringify(createProject(), null, 2) + "\n"); return; }
  if (command === "catalog") {
    if (file !== "-") throw new CliError("USAGE", 2, "catalog does not read a file.");
    process.stdout.write(JSON.stringify(designCatalog((flags.lang ?? "en") as Lang), null, 2) + "\n"); return;
  }
  let text: string;
  try {
    if (file === "-") {
      if (process.stdin.isTTY) throw new Error("stdin is a terminal; provide a file or pipe JSON");
      process.stdin.setEncoding("utf8");
      text = "";
      let bytes = 0;
      for await (const chunk of process.stdin) {
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_PROJECT_BYTES) throw new HeadlessError("INVALID_PROJECT", "Project input exceeds 1 MiB.");
        text += chunk;
      }
    } else {
      const info = await stat(file);
      if (!info.isFile()) throw new Error("Input path must be a regular file.");
      if (info.size > MAX_PROJECT_BYTES) throw new HeadlessError("INVALID_PROJECT", "Project input exceeds 1 MiB.");
      text = await readFile(file, "utf8");
    }
  } catch (error) {
    if (error instanceof HeadlessError) throw error;
    throw new CliError("INPUT_ERROR", 4, error instanceof Error ? error.message : "Cannot read input.");
  }
  if (["create", "apply"].includes(command ?? "")) {
    let value: unknown;
    try { value = JSON.parse(text || (command === "create" ? "{}" : "")); } catch { throw new HeadlessError("INVALID_JSON", "Input must be valid JSON."); }
    if (command === "create") process.stdout.write(JSON.stringify(createProject(value), null, 2) + "\n");
    else {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new HeadlessError("INVALID_PROJECT", "Expected a transaction envelope with doc, version and operations.");
      const { doc, ...transaction } = value as Record<string, unknown>;
      process.stdout.write(JSON.stringify(applyOperations(doc, transaction), null, 2) + "\n");
    }
    return;
  }
  const doc = parseProject(text);
  let output: string;
  if (command === "inspect") output = JSON.stringify(inspectProject(doc), null, 2) + "\n";
  else if (command === "validate") output = JSON.stringify(doc, null, 2) + "\n";
  else if (command === "share") output = await projectShareLink(doc, flags.base) + "\n";
  else {
    output = projectPrompt(doc, { lang: flags.lang as Lang | undefined, mode: flags.mode as PromptOptions["mode"], frameId: flags.frame });
    if (output && !output.endsWith("\n")) output += "\n";
  }
  process.stdout.write(output);
}

function fail(error: unknown) {
  const code = error instanceof HeadlessError || error instanceof CliError ? error.code : "INTERNAL_ERROR";
  const exitCode = error instanceof CliError ? error.exitCode : error instanceof HeadlessError ? (["INVALID_JSON", "INVALID_PROJECT"].includes(code) ? 3 : 2) : 5;
  process.stderr.write(JSON.stringify({ error: { code, message: error instanceof Error ? error.message : "Unexpected failure." } }) + "\n");
  process.exitCode = exitCode;
}

process.stdout.on("error", () => fail(new CliError("OUTPUT_ERROR", 4, "Cannot write stdout.")));
void main().catch(fail);
