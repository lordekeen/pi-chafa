---
name: pi-chafa
description: Show image files to the user in the terminal with the show_image tool. Use when the user asks to see or preview a picture, screenshot, plot, icon, or diagram, or when an image would help the user decide. Not for reading or interpreting image contents.
---

# pi-chafa — showing images to the user

`show_image` renders image files **for the user only**. It is a UI/UX feature, not a vision feature: you never receive the image contents or a description of them, so never claim to know what an image depicts.

## When to call `show_image`

- The user explicitly asks to see a file ("show me", "display", "preview", "what does it look like").
- The user is reviewing something you generated — a plot, chart, screenshot, or diagram.
- A user-facing decision depends on an image and showing it would help.

## When to prefer other tools

- Textual inspection of a file → use `read`, not `show_image`.
- You need file metadata (size, dates) → use `ls` or `read`.
- You must interpret the image's contents → impossible for you; say so plainly and offer to show it to the user instead.

## Coordination with pi-pretty (important)

- In a **native** terminal (kitty/iTerm2 — protocol shown as `kitty`/`iterm2` in `/images`) **with a pretty `read` override installed** (pi-pretty or similar), prefer `read <image>`: it already returns the image for native rendering, and it is the natural step when you were going to read anyway.
- Use `show_image` when you want explicit, intent-driven rendering, when the terminal is **non-native** (needs the Chafa symbols fallback that pi-pretty's read path does not provide), or when no pretty reader is installed.
- In non-native terminals, or without pi-pretty, prefer `show_image` directly.

## How to target files

- Prefer explicit paths (`show_image path: "docs/plot.png"`) over globs.
- Paths and globs are relative to the working directory.
- Use narrow globs when the user says "all screenshots": `screenshots/*.png` — not broad `**` patterns.

## Overrides

- Defaults are normally fine. Pass `format: "symbols"` to force Chafa ANSI art on a native-capable terminal (testing, artistic preference), `format: "native"` to force native delivery, or `cellWidth`/`colors`/`symbolsSet`/`dither` to tune one call only — they never persist.

## After calling

- Report plainly what you did. Animated files show a **still frame**.
- If the result mentions Chafa, tell the user how to install it (`brew install chafa` on macOS, `apt install chafa` on Debian/Ubuntu, or the distro package) or to set `CHAFA_BIN`.
- Never fabricate image contents. If you did not see the image, say you did not.
