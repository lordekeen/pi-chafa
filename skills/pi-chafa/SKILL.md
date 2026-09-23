---
name: pi-chafa
description: Show image files to the user in the terminal with the show_image tool. Use when the user asks to see or preview a picture, screenshot, plot, icon, or diagram, or when an image would help the user decide. Not for reading or interpreting image contents.
---

# pi-chafa — showing images to the user

`show_image` renders image files **for the user**. It is a UI/UX feature, not a vision feature, and what (if anything) reaches *you* depends on the delivery mode named in the result summary:

- **as ANSI art** (Chafa symbols): you receive only the plain-text summary — no image bytes, no base64, no description, no ANSI art.
- **via terminal-native rendering**, or a **mixed delivery** run: the extension emitted `{type:"image"}` blocks in the tool result, and pi's host may attach them to you when you run on a vision-capable model. That is the host's decision, not a guarantee.

So never claim to know what an image depicts unless a vision path actually showed it to you.

## When to call `show_image`

- The user explicitly asks to see a file ("show me", "display", "preview", "what does it look like").
- The user is reviewing something you generated — a plot, chart, screenshot, or diagram.
- A user-facing decision depends on an image and showing it would help.

## When to prefer other tools

- Textual inspection of a file → use `read`, not `show_image`.
- You need file metadata (size, dates) → use `ls` or `read`.
- You must interpret the image's contents → do not assume `show_image` is a vision path: symbols delivery returns text only, and a native image block only reaches you if the host attached it. Use the dedicated vision route below; otherwise say plainly that you cannot inspect the contents and offer to display the file for the user.

## Interpreting image contents (vision)

`show_image` is strictly for presenting an image to the **human user**, so treat its result as unproven vision: on the symbols path you receive only the text summary (no base64, no description, no ANSI art), and on the native path the tool result carries image blocks that may or may not be attached to you. When a request needs *interpretation* (describe, audit, OCR, "what's wrong in this screenshot"):

- **Dispatch the work to a vision-capable subagent** when one is listed (e.g. `designer`, which runs a vision model). That child reads the file itself; it does not gain vision by calling `show_image` either.
- **`pi-vision-handoff` is user-initiated.** It registers a `/vision-handoff` slash command for the *user* to attach an image and hand it to the configured vision model. It exposes no model-callable "describe this path" tool, so do not claim you will use it — ask the user to run it instead.
- You may show the image to the user with `show_image` alongside either route, so they can follow the analysis visually.
- **Never fabricate image contents.** If no vision path was used, say you did not see the image.

## Subagents

Subagents declare a strict tool allowlist in their frontmatter, so `show_image` is **not** available to them by default. Extension tools need the `ext:` selector — a bare `show_image` entry is parsed as a built-in name and fails loudly:

```yaml
# ~/.pi/agent/agents/designer.md
tools: read, grep, find, ls, write, ext:pi-chafa/show_image, ext:pi-codegraph
```

- `ext:pi-chafa/show_image` exposes exactly this tool; `ext:pi-chafa` exposes all of the extension's tools.
- Any `ext:` entry flips extension tools to an explicit allowlist for that agent — list every extension tool it should keep, or the others disappear.
- Extension names match case-insensitively; tool names stay case-sensitive.

**Headless reality:** a subagent session runs without a UI (`ctx.hasUI === false`), so `show_image` returns only the plain-text summary — nothing is rendered in the terminal and no ANSI or image block is produced. To actually show the user an image a subagent used, the orchestrator re-invokes `show_image` at top level after the child reports the file path.

## Coordination with pi-pretty (important)

- In a **native** terminal (kitty/iTerm2 — protocol shown as `kitty`/`iterm2` in `/images`) **with a pretty `read` override installed** (pi-pretty or similar), prefer `read <image>`: it already returns the image for native rendering, and it is the natural step when you were going to read anyway.
- Use `show_image` when you want explicit, intent-driven rendering, when the terminal is **non-native** (needs the Chafa symbols fallback that pi-pretty's read path does not provide), or when no pretty reader is installed.
- In non-native terminals, or without pi-pretty, prefer `show_image` directly.

## How to target files

- Prefer explicit paths (`show_image path: "docs/plot.png"`) over globs.
- Paths and globs are relative to the working directory; absolute paths, `~/...`, and pi's `@path` file-reference prefix also work.
- Use narrow globs when the user says "all screenshots": `screenshots/*.png` — not broad `**` patterns.

## Overrides

- Defaults are normally fine. Pass `format: "symbols"` to force Chafa ANSI art on a native-capable terminal (testing, artistic preference), `format: "native"` to force native delivery when the session is native-capable, or `cellWidth`/`colors`/`symbolsSet`/`dither` to tune one call only — they never persist.
- `format: "native"` errors only when the terminal cannot render natively; on a native-capable terminal where the host has images off, it degrades to symbols and adds a note to the result.

## After calling

- Report plainly what you did. Animated files show a **still frame**.
- The result summary may include a `Note:` clause (output capped at the configured row limit, a degraded forced-native request, or chafa producing no output). Relay it to the user rather than ignoring it.
- On a **native** terminal, a file that is not a recognized image format is a **per-file error**, not a note: no image block is emitted, because pi persists that block in session history and providers reject it on every later turn. The error suggests retrying that file with `format: "symbols"`, which lets Chafa attempt it.
- If the result mentions Chafa, tell the user how to install it (`brew install chafa` on macOS, `apt install chafa` on Debian/Ubuntu, or the distro package) or to set `CHAFA_BIN`.
- Never fabricate image contents. If you did not see the image, say you did not.
