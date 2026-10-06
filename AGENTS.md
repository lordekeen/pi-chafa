# AGENTS.md

Project context and rules for AI agents working in this repository. Read this before changing code.

## What this is

`pi-chafa` is a [pi](https://pi.dev) extension package that allows the model to display image files to the **user** in the terminal.
- Where supported (kitty, iTerm2), it renders native terminal image blocks via pi's host pipeline.
- Everywhere else (tmux, Alacritty, VS Code, screen, plain SSH, Windows console), it converts images to ANSI/Unicode symbol art using system **Chafa** (≥ 1.10.0).
- Bundles a skill ([`SKILL.md`](skills/pi-chafa/SKILL.md)) and the [`/images`](src/commands/images.ts) slash command for tuning runtime defaults.

## Spec conflict rule

The spec is **authoritative, but not frozen**. A change that contradicts the spec must amend the spec in the *same* change; never silently override it. The plan or task that ships the behavior carries the spec edit, so the tree never contains a behavior the spec denies (see "Spec wins in any conflict" in the Files & Architecture table).

## Non-negotiable invariants

1. **UI/UX feature, NOT model vision:** The extension never puts image bytes, base64 payloads, or ANSI art into model-visible **text**. Plain-text tool output is a short summary; ANSI art lives only in `details.payload` for the custom `renderResult` component, so symbols delivery returns the model nothing but text. Native delivery (provider-safe mimes only, spec §7.4) does put `{type:"image", data, mimeType}` blocks in the tool result, and pi's host may attach those blocks to a vision-capable model — that is the host's pipeline, not the extension's, and the model must not assume either way.
2. **Strict ANSI separation:** Plain-text tool output passes through pi's host `getTextOutput()` which strips ANSI. Colored ANSI art must *only* be returned inside a custom [`renderResult`](src/show-image.ts) component (a pi-tui `Container`/`Text` tree) and must render **outside** the tool row's themed background (`renderShell: "self"`, #027) so transparent pixels show the terminal background.
3. **Zero terminal pollution:**
   - Raw Chafa output must never emit screen clears (`--clear` forbidden).
   - Cursor toggle sequences must be cleanly stripped via [`cleanSymbolsPayload`](src/chafa.ts).
   - User paths and labels must be sanitized with [`stripControls`](src/show-image.ts) to prevent ANSI/control-character injection into the TUI.
4. **Clean abort handling:** When an execution abort occurs via `AbortSignal`, it must be recognized as a user cancellation and thrown, never reported as a misleading timeout or swallowed as a per-file failure.
5. **No native runtime dependencies:** Runtime dependencies rely on pi's peer packages (`@earendil-works/pi-*` plus `typebox`, a pi core package) and Node built-ins (`node:fs`, `node:path`, `node:child_process`). `typebox` is imported at runtime by `src/show-image.ts` and must stay declared in `peerDependencies` (it is also a devDependency for local builds). `chafa` is an external binary on `PATH`.
6. **Precedence ladder:** Tool call parameters > `CHAFA_*` environment variables > `~/.pi/agent/pi-chafa.json` config > defaults.

## Files & Architecture

| File | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Extension entrypoint: registers [`show_image`](src/show-image.ts) tool and [`/images`](src/commands/images.ts) command. |
| [`src/types.ts`](src/types.ts) | Core types, interfaces, and constant arrays ([`COLOR_MODES`](src/types.ts), [`DITHER_MODES`](src/types.ts), [`DELIVERY_FORMATS`](src/types.ts)). |
| [`src/config.ts`](src/config.ts) | Configuration resolution, schema validation, host settings reading, and atomic persistence. |
| [`src/chafa.ts`](src/chafa.ts) | Chafa binary probing, arg generation, subprocess execution with timeouts, and ANSI payload cleaner. |
| [`src/detect.ts`](src/detect.ts) | Delivery decision engine implementing spec §7.2 matrix (native vs symbols vs none), and the effective image capability resolution (spec §6.4 ladder) via [`resolveCapsImages`](src/detect.ts). |
| [`src/images.ts`](src/images.ts) | Path and glob expansion, magic byte sniffing for MIME types, and file reading. |
| [`src/show-image.ts`](src/show-image.ts) | The `show_image` tool definition, execution loop, no-UI degradation, and custom TUI renderers. |
| [`src/commands/images.ts`](src/commands/images.ts) | `/images` slash command panel, terminal capability inspector, and interactive settings menu. |
| [`skills/pi-chafa/SKILL.md`](skills/pi-chafa/SKILL.md) | Bundled skill auto-discovered by pi, guiding models on when to call `show_image`. |
| [`scripts/smoke.mjs`](scripts/smoke.mjs) | Opt-in real-dependency smoke runner (`npm run test:smoke`): builds `dist/` then drives it against the real chafa binary, the real filesystem, and the real capability ladder. Not published — `scripts/` is outside the `files` allowlist. |
| [`docs/spec/2026-09-03-pi-chafa-extension-design.md`](docs/spec/2026-09-03-pi-chafa-extension-design.md) | Authoritative design specification. Spec wins in any conflict — amend it in the same change (see "Spec conflict rule" above). |

## Verification Gates

Every pull request or task MUST pass all four checks cleanly before completion:

```bash
npm run typecheck   # tsc --noEmit (strict TypeScript)
npm run lint        # biome check src/
npm test            # vitest run (all unit and integration tests)
npm run build       # tsc -p tsconfig.build.json (emits to dist/)
```

Use `npm run lint:fix` to resolve formatting and import ordering issues.

Optional, opt-in fifth gate — deliberately **not** part of `npm test`, because the unit suite injects fakes for chafa and must stay hermetic:

```bash
npm run test:smoke  # builds dist/ and drives the built artifact against the real chafa binary, filesystem, and image files
```

It requires `chafa` (≥ 1.10.0) and ImageMagick on `PATH`, and **skips cleanly with exit 0** when either is missing.

## Conventions

- **TDD & Injected Dependencies:** Pure logic is separated from side effects. Tool implementations accept injected dependency records (e.g. [`ShowImageDeps`](src/show-image.ts)) so test suites run in headless Node without requiring an active pi TUI session or a physical GPU/display.
- **Regex Safety:** Due to Biome's `noControlCharactersInRegex` lint rule, ANSI escape patterns and control-character regexes must be instantiated via `new RegExp(...)` from string constants (e.g., `ESC = "\x1b"`).
- **Silent Degradation:** Invalid or unknown configuration fields are ignored silently rather than crashing the extension.
- **Test-layer split:** Unit/integration tests inject fakes for chafa and stay hermetic. Coverage of the real binary, the real filesystem, and the real capability ladder lives in [`scripts/smoke.mjs`](scripts/smoke.mjs). Do not "fix" a hermetic test by pointing it at the real binary.
- **Seam trap:** [`buildShowImageTool`](src/show-image.ts) merges `{ ...defaultDeps(), ...deps }`; execute reads host settings exactly **once** through the injectable `readHostImages` and computes the spec §6.4 ladder from that one value plus `getCapabilities()`/env/platform — there is no separate `capsImages` seam (#044). A test that injects `readHostImages` with `images: null` must not expect native delivery. The ladder is covered directly via [`resolveCapsImages`](src/detect.ts), and end to end by the smoke runner calling `buildShowImageTool()` with no overrides.
- **Conventional Commits:** Prefix commits with `feat:`, `fix:`, `docs:`, `chore:`, or `test:`.
