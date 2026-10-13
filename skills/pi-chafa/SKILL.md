---
name: pi-chafa
description: Display image files to the user in the terminal with the show_image tool. Use whenever the user asks to see, show, display, preview, or open a picture, screenshot, plot, chart, icon, or diagram ("show me", "what does it look like", "let me see it"), and proactively after you or a command generate an image the user should review, or when an image would help them make a decision. Presentation only: it does not let you see or interpret image contents.
---

# pi-chafa: showing images to the user

`show_image` renders image files **for the human user**. It is a display feature, not a vision feature.

## What reaches you

The delivery mode is named in the tool result:

- **ANSI art (Chafa symbols):** you get a text summary only, with no image data.
- **Terminal-native or mixed:** image blocks are emitted, and the host *may* attach them to you if your model supports vision. This is not guaranteed.

Unless a vision path actually showed you the image, you do not know what it depicts. Never describe or guess its contents. Say you did not see it.

## Choosing the right action

1. **User wants to see an image, or a generated image needs review** → call `show_image`.
2. **You need the file's text or metadata** → use `read` or `ls`.
3. **You need to interpret the image** (describe, OCR, audit, "what's wrong here") → delegate to a vision-capable subagent or the harness's vision handoff, if one is available. The subagent reads the file itself. You can also call `show_image` so the user can follow along.
4. **No vision path exists** → say you cannot inspect the contents and offer to display the file.

## Targeting files

- Prefer explicit paths: `path: "docs/plot.png"`.
- Relative paths, absolute paths, `~/...`, and `@path` all work.
- For "all screenshots", use a narrow glob like `screenshots/*.png`, not `**`. More than 50 matches fails, so narrow the pattern or call per file.

## After calling

- Report plainly what you did. Animated files show a still frame.
- Relay any `Note:` in the result (row cap reached, native fallback, empty Chafa output).
- If Chafa is missing, tell the user: `brew install chafa` (macOS), `apt install chafa` (Debian/Ubuntu), or set `CHAFA_BIN`.
- If the file or glob matches nothing, say so and ask for the correct path.

## Overrides (rarely needed)

Defaults are usually right. For per-call overrides (`format`, `cellWidth`, `colors`, `symbolsSet`, `dither`) and native-terminal error behavior, see `references/overrides.md`.
