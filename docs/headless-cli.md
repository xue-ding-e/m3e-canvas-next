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

## Structured design editing (transaction version 1)

`create [options.json|-]` returns a new empty project, `inspect [project.json|-]`
returns the normalized project, SHA-256 revision, counts, geometric ownership and
estimated bounds, and `catalog --lang en` returns all 36 component defaults,
existing engine specifications, color/layout enums, and discoverable JSON schemas.
The catalog's `storedFields` is a union of persistent fields, not a claim that
every field has a visual effect on every kind.

`apply [transaction.json|-]` reads one reviewable JSON envelope and returns
`{version, doc, revision, previousRevision, changes, warnings, geometry}`. It never
writes over its input. Save stdout separately, review the result, and extract
`doc` for browser import or a subsequent operation. Errors leave the supplied
object/file unchanged and produce no partial document on stdout.

```json
{
  "version": 1,
  "doc": {"groups": [], "frames": [], "title": "Notes", "brief": "", "frame": "phone", "paletteKey": "purple"},
  "promptEditPolicy": "clear",
  "operations": [
    {"op": "frame.add", "frame": {"id": "home", "name": "Home", "x": 0, "y": 0}},
    {"op": "group.add", "group": {"id": "actions", "x": 16, "y": 80, "axis": "x", "items": []}},
    {"op": "item.add", "groupId": "actions", "item": {"id": "save", "kind": "button", "label": "Save"}}
  ]
}
```

Supply `expectedRevision` from the preceding `inspect` to reject stale plans.
A batch accepts at most 200 operations and 1 MiB. Entity IDs are explicit, globally
unique and immutable; frame references must resolve by the end of the batch.
Use `set` and `unset` on update operations; `null` is not a generic delete marker.
Required fields cannot be unset. An empty temporary group is allowed within a
batch but must contain an item by its end. Locked groups require an explicit
`group.lock` unlock before direct or indirect changes.

Implemented operations:

- `project.update`: title, brief, screen mode, platform, palette, theme, dynamic
  color and prompt options. Theme replacement is a full theme object.
- `frame.add/update/remove/reorder/tidy`: update coordinates carries geometrically
  owned groups; width/height use the editor's resize/reflow helper; length uses
  its stretch helper. Remove defaults to keeping groups and rejecting dangling
  references; choose `contents: "remove"` and/or `references: "clear"` explicitly.
- `group.add/update/remove/reorder/lock`: groups can be connected runs or free
  groups with explicit per-item offsets. Order is back-to-front storage order.
- `item.add/update/remove/move/reorder`: all registered kinds; immutable IDs/kinds,
  runtime field checks, connected-run size propagation, rail update behavior,
  estimated lone-part/FAB resize anchoring, and free-group slot reorder.
- `tabs.insert/remove/reorder`: carries selected indices and per-slot navigation;
  carousel cards are materialized and their count is kept in sync.
- `prompt.set/clear`: explicitly replace/reset saved edited text.

Navigation, image sources, card options, toggle looks, per-slot actions and swipe
references are expressed through the corresponding typed entity fields. URLs are
stored only, never fetched by design editing; link actions require absolute
HTTP(S) URLs without embedded credentials.

When design edits leave an existing `promptEdit`, the default policy rejects the
transaction. Choose `clear` to use generated text again, `preserve` to explicitly
retain potentially stale text (with a warning), or end with `prompt.set/clear`.
A later design operation makes an earlier prompt replacement stale again.

This is persistent document editing, not complete UI emulation: automatic
join/split, frame duplication with remapped navigation, implicit kind conversion,
runtime preview interaction, browser undo/redo history, and exhaustive per-kind
semantic validation remain outside this interface. Item removal/moving and raw
field changes do not promise every selection-specific UI rearrangement. Layout
uses estimated widths. PNG rendering is a separate command with explicit
prerequisites; see [offline rendering](CLI_RENDER.md).
