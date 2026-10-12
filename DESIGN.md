# DESIGN.md — pi-chafa Architecture & Decisions

High-level engineering design and technical rationale for `pi-chafa`. The formal specification is maintained locally in `docs/` (a local-only tree that is deliberately never published, and absent from this repository's history); this file is the published design contract, and [`AGENTS.md`](AGENTS.md) carries the rules that must not be violated.

## 1. Objective

Provide a universal image viewing capability for the [pi](https://pi.dev) coding agent:
- Display image files to the **user** directly inside the terminal.
- Deliver true terminal-native graphics on terminals supporting Kitty or iTerm2 protocols.
- Deliver ANSI/Unicode character-cell art using **Chafa** on all other environments (tmux, screen, Alacritty, VS Code, SSH, Windows consoles).
- Ensure zero TUI corruption, zero terminal injection vulnerabilities, and strict separation between user display and model context.

## 2. Core Architecture

```
                                  pi Runtime
                                      │
               ┌──────────────────────┴──────────────────────┐
               ▼                                             ▼
       show_image Tool                                /images Command
  (src/show-image.ts)                            (src/commands/images.ts)
               │                                             │
      Target Resolution                              Inspect Environment
 (glob expansion, magic bytes)                    (caps, chafa ver, overrides)
               │                                             │
      Delivery Decision                              Interactive Config Menu
    (src/detect.ts §7.2)                                     │
               │                                     Atomic JSON Writer
       ┌───────┴──────────────┐                      (~/.pi/agent/pi-chafa.json)
       ▼                      ▼
  Native Path            Symbols Path
(raw bytes → base64)   (Chafa CLI subprocess)
       │                      │
  Image Blocks           ANSI Payload Cleaner
 ({type: "image"})      (strip cursor toggles & \r)
       │                      │
  Host Image Renderer    Custom renderResult Component
 (Kitty / iTerm2)        (pi-tui Text, ANSI preserved)
```

## 3. Data Flow & Subsystems

### 3.1 Target Resolution & File Handling ([`src/images.ts`](src/images.ts))
1. **Argument Parsing:** Accepts either `path` (single target) or `glob` (multi-file match).
2. **Glob Translation:** Custom glob-to-regex translator supporting `*`, `?`, and recursive `**` directories matching zero-or-more segments in any position.
3. **MIME Sniffing:** Inspects the first 16 bytes against magic number signatures for PNG, JPEG, GIF87a/89a, and WebP only (spec §7.4), to guarantee accurate content types without relying solely on file extensions. SVG is not magic-byte-sniffable (it is XML text), so it is not detectable this way at all.

### 3.2 Delivery Mode Decision Matrix ([`src/detect.ts`](src/detect.ts))
Determines whether each target is rendered natively, converted to symbols, or degraded:

| Terminal Capabilities (`caps.images`) | Host `showImages` | User Config / Param Format | Delivery Mode |
|---|---|---|---|
| `kitty` or `iterm2` | `true` | `auto` (with `preferNative: true`) | `native` |
| `kitty` or `iterm2` | `true` | `preferNative: false` OR format=`symbols` | `symbols` |
| `null` (plain terminal / tmux) | any | `auto` or `symbols` | `symbols` |
| `kitty` or `iterm2` | `false` | `native` (explicitly forced) | `symbols` (Chafa), with a note that a forced native delivery was degraded |
| `null` (not native-capable) | any | `native` (explicitly forced) | Error (`format=native unavailable`) |
| No UI / Headless (`ctx.hasUI === false`) | any | any | `none` (safe text degrade) |

### 3.3 Chafa Subprocess Engine ([`src/chafa.ts`](src/chafa.ts))
- **Executable Invocation:** Spawns `chafa` on `PATH` (or explicit `binaryPath`) with `--format=symbols` and `--relative=off`.
- **Arg Hardening:** `--clear` is strictly omitted to protect the TUI alt-screen buffer. `--animate=off` is passed to prevent runaway loops on animated GIFs.
- **Payload Cleaner:** Strips terminal cursor visibility toggles (`\x1b[?25h`, `\x1b[?25l`) and trailing carriage returns (`\r`) before passing strings to the TUI.
- **Terminal Injection Guard:** [`stripControls`](src/show-image.ts) removes C0/DEL control characters and ANSI CSI sequences from paths and labels before formatting them into user-visible components.

### 3.4 Custom Rendering Pipeline ([`src/show-image.ts`](src/show-image.ts))
- **Host ANSI Filter Bypass:** Standard tool result text passes through `getTextOutput()`, which removes ANSI formatting. To deliver vibrant ANSI/Unicode art, `show_image` implements [`renderResult`](src/show-image.ts), returning a pi-tui [`Text`](src/show-image.ts) component that renders sequences directly into the terminal cell grid.
- **Model vs User Isolation:** The LLM receives only a high-level summary string (e.g. `Showed image chart.png to the user as ANSI art.`). The binary image data and ANSI payloads never enter the conversation context window.

### 3.5 Configuration Management ([`src/config.ts`](src/config.ts))
- **Resolution Order:** Per-call tool parameters > `CHAFA_*` environment variables > `~/.pi/agent/pi-chafa.json` > [`DEFAULT_CONFIG`](src/config.ts).
- **Validation:** Unknown keys and malformed values are silently dropped to ensure forward/backward compatibility without runtime aborts.

## 4. Key Design Decisions

| Decision | Alternative Considered | Rationale |
|---|---|---|
| **System `chafa` binary** | Bundled WebAssembly (`chafa-wasm`) | Native execution delivers maximum rendering performance and zero bundle bloat. Wasm deferred to future release. |
| **Custom `renderResult`** | Raw text content | pi's host tool execution engine strips ANSI from standard text content. Only pi-tui `Component` instances preserve color escape sequences. |
| **Per-file execution loop** | Batch execution (`chafa file1 file2 ...`) | Individual execution isolates corrupt images, provides fine-grained per-file error reporting, and enables real-time progress updates. |
| **C0/CSI stripping** | Unsanitized paths | Malicious file paths containing terminal escapes could hijack TUI formatting or prompt injection defenses. |
| **AbortError propagation** | Catching as per-file error | User cancellations must halt execution immediately rather than logging confusing per-file timeouts. |

## 5. Error Handling Philosophy

1. **Partial Success:** When resolving multiple images, failures on individual files (e.g., corrupt header, file missing) are captured per-file. Successful files are still rendered, and the summary reports the count of failed files.
2. **Actionable Errors:** If no files succeed or a required dependency is missing (e.g., `chafa` not found on `PATH`), descriptive errors with clear remediation steps are returned (`isError: true`).
3. **No-UI Graceful Degradation:** When run under print/batch modes (`ctx.hasUI === false`), image rendering is bypassed in favor of clean informative text placeholders without failing the tool call.

## 6. Deferred & Future Scope

- **Upstream Sixel Support:** Sixel rendering is deferred pending host TUI architecture updates; pi-tui exposes no sixel path today.
- **Dynamic Terminal Width Clamping:** Symbols output currently relies on configured `cellWidth` (default: 60) rather than dynamic terminal column queries.
- **WASM Fallback:** Embedded WebAssembly fallback for systems lacking native `chafa` packages.
