# Browser site tools (WebMCP)

The top-level editor progressively registers three imperative tools through
`document.modelContext`. This is separate from the CLI / stdio MCP server.
Nothing is registered on the `/automation/` explanation page.

- `get_canvas_document({})` returns the **current editor** document and an opaque
  `revision`. It does not read AI settings, keys, files or other tabs.
- `get_canvas_prompt({})` returns the current effective prompt, using the editor's
  live measured widths and language. Edited prompts, including empty strings,
  take precedence. Its output also includes the current revision.
- `preview_canvas_document({document, expectedRevision})` validates and stages a
  full candidate. Use the revision from the read on which the candidate is based.
  A stale revision is rejected. This tool does **not** apply or persist changes.

Output is untrusted user content, not agent instructions. Never approve a
candidate on the user's behalf. The user reviews its complete JSON and summary
in a native modal dialog, then clicks Apply candidate or Cancel. Applying uses
existing editor import/history, so Undo restores the previous full document.
There is deliberately no apply/approve tool. A trusted DOM event check prevents
synthetic script dispatch, but is not proof of a human: browser automation may
also produce trusted events.

## Boundaries

- One pending proposal at a time; staging never silently replaces another.
- Applying checks edit access and that the canvas is still identical to the
  staged baseline. Staging is disabled during existing import/share/clear,
  interactive-preview and AI-busy flows.
- Inputs must be JSON, at most 1 MiB, with depth/complexity/count limits and unique
  nonempty frame/group/item IDs. Unknown top-level document fields are rejected.
- New image sources must be added through the regular editor first. Candidate
  preview is JSON-only and never renders candidate resources.
- Shared headless validation restricts custom palette roles/seed to hex colors
  and background/fill selectors to actual color tokens, blocking CSS URL values.
- Applying can retain the editor's normal behavior, including loading one of its
  supported Google Fonts after a theme change. This is not a network automation
  API; tools cannot fetch arbitrary URLs or open files.
- Tool lifecycle uses AbortSignal cleanup. Failed or unsupported registration
  leaves manual read/prompt/JSON-review controls usable. Controls are currently
  in English; the underlying prompt respects the editor's selected language.
- A stale manual candidate must be cleared and prepared again from a fresh read;
  reading the canvas does not silently authorize an old candidate for a new state.

## Verification and release gate

Unit tests cover the tool contract, live reads, measured-width prompts, edited
prompts, revision conflicts, validation failures, resource restrictions and
AbortSignal registration. They do not establish host compatibility.

In the actual ChatGPT built-in browser, verify all of the following before
claiming WebMCP compatibility or publishing this explicitly requested feature:

1. Open the **top-level editor**, observe all three tools and call document/prompt.
2. Submit a valid proposal with its expectedRevision; verify document readback
   and browser persistence remain unchanged until the user confirms.
3. Cancel; repeat and let the user apply; read the result; use Undo and read again.
4. Submit malformed and stale input, and a second proposal while one is pending;
   verify errors leave document and pending review unchanged.
5. Close/reopen the page and check registration/cleanup, and test the read-only
   second-tab guard.

Official support documentation:
https://help.openai.com/en/articles/20001423-using-site-tools-in-the-chatgpt-desktop-app

Current implementation QA: typecheck, 843 unit tests and static production build
passed. Actual browser interaction and ChatGPT host calls remain **unverified**:
the available isolated Chromium could not launch because this cloud execution
sandbox denied its local process-singleton socket, including an escalated retry.
No `document.modelContext` shim was used. This is a release blocker for the
requested WebMCP delivery, not a passing host test.
