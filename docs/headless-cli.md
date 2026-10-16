# Headless CLI

This downstream interface processes explicit project JSON without opening a
browser, reading browser storage, making network requests, or calling an AI
provider. It uses the editor's validator, migrations, prompt engine, and share
codec. It does not control a running editor.

## Build and run

Use the Node versions in `package.json` (Node 22.12+, 24, or 26+):

```sh
npm ci
npm run build:headless
node dist-headless/cli/main.js --help
node dist-headless/cli/main.js validate project.json > normalized.json
node dist-headless/cli/main.js prompt project.json --lang en > prompt.txt
cat project.json | node dist-headless/cli/main.js prompt - --lang zh
node dist-headless/cli/main.js prompt project.json --mode generated --frame home
node dist-headless/cli/main.js share project.json --base https://your-app.example/
```

The build is separate from startup so stdout remains suitable for pipelines.
`npm run --silent cli -- ...` is a convenience wrapper after building. No global
installation or published package is required. Use `--` before filenames that
start with a dash. Omit a filename, or use `-`, to read stdin.

## Commands and output

- `validate`: returns normalized project JSON. Missing legacy top-level fields
  receive fresh-editor defaults; existing item migrations are applied. Input is
  never rewritten. This checks the editor's supported import shape, not a
  versioned exhaustive JSON Schema or screen design quality.
- `prompt`: returns plain text, English by default. `--lang` accepts `ja`, `en`,
  `zh`, and `ko`. Default `--mode effective` preserves a saved `promptEdit`,
  including an empty string. `--mode generated` explicitly regenerates text.
  `--frame ID` requires generated mode and an existing frame in screen mode;
  invalid selection fails instead of silently exporting all screens.
- `share`: returns a locally encoded link for the explicit `--base` HTTP(S)
  application URL. Credentials and existing fragments in the base are rejected.
  No URL is fetched, opened, or published.

The browser measures text and fonts; the CLI uses the engine's width estimates.
Generated text uses the same engine but pixel layout equivalence is not promised.
The original project format is a plain `Doc` JSON object, not an invented wrapper
or a versioned `.m3e` container.

Share links are compressed, not encrypted. The editor's `shareable` behavior
removes item-level picked images and frame/item rewrite history; HTTP(S) item
images and other content can remain (including image sources within tabs).
Review the result before sharing it. For lossless exchange, keep the original
project JSON. Share links are not a backup or comprehensive privacy filter.

## Errors and limits

Successful output goes only to stdout. Errors go to stderr as one JSON object:

```json
{"error":{"code":"INVALID_JSON","message":"Input must be valid JSON."}}
```

Exit status: `0` success, `2` usage/options/frame selection, `3` invalid JSON or
project, `4` input/output failure, `5` unexpected failure. `--help` and `--version`
do not consume input. Input is limited to 1 MiB of UTF-8 JSON and 64 nesting levels.
The tool does not prompt for secrets and does not access credentials.

## Development

`lib/headless.ts` provides the reusable service API for CLI and MCP.
`lib/migrate.ts` contains the unchanged group migration used by both the browser
editor and headless import. `npm test` builds the headless entry points first,
then runs unit tests and actual subprocess input/output/error tests.
