# Contributing to pi-chafa

Thank you for your interest in improving `pi-chafa`. This guide outlines our design principles, local setup, and quality standards.

## Philosophy

`pi-chafa` has a single, focused purpose: show image files to the **user** in the pi terminal cleanly, safely, and universally.

- **UI/UX, not Vision:** Features that send image contents back into the model context do not belong in this extension.
- **Safety First:** We prioritize TUI stability and terminal safety. Any code that emits raw control codes or risks terminal corruption will not be accepted.
- **Understand Your Code:** AI tools and agentic workflows are encouraged, but you must understand every line of code submitted. Blindly generated changes without technical verification will be closed.

## Prerequisites

- **Node.js:** Node ≥ 22.19.0 (the floor pi itself declares; tested on Node 24.x with ECMAScript modules).
- **Chafa:** System binary ≥ 1.10.0 installed on `PATH` (recommended: 1.18.x).
  - macOS: `brew install chafa`
  - Ubuntu/Debian: `sudo apt install chafa`
  - Arch Linux: `sudo pacman -S chafa`
- **pi:** [pi coding agent](https://pi.dev) installed locally.

## Development Setup

Clone the repository and install dev dependencies:

```bash
git clone https://github.com/lordekeen/pi-chafa.git
cd pi-chafa
npm install
```

To test local changes directly in your `pi` environment:

```bash
# Install local working directory into pi settings
pi install /path/to/pi-chafa

# Or test directly for a single session without permanent install
pi -e ./src/index.ts
```

## Quality Gates

Before opening a pull request or committing changes, ensure that all four verification commands pass:

```bash
npm run typecheck   # Typecheck with tsc --noEmit
npm run lint        # Code style and lint checks with Biome
npm test            # Run Vitest test suite
npm run build       # Build distribution artifacts in dist/
```

To automatically format code and sort imports to match the repository standards:

```bash
npm run lint:fix
```

Optional, opt-in real-dependency smoke test — outside `npm test`, which must stay hermetic:

```bash
npm run test:smoke   # builds dist/ and drives it against the real chafa binary, real files, and the real filesystem
```

It requires `chafa` (≥ 1.10.0) and ImageMagick on `PATH`, and skips cleanly with exit 0 when either is missing.

### Activation Smoke Test

The shipped extension entry is `./src/index.ts` (pi's loader transpiles it). `dist/` is a **build verification artifact**: gate 4 compiles it, the smoke runner loads it, a local `prepublishOnly` hook rebuilds it — and it is never published (`files` excludes `dist/`, and there is no `main`/`types`). So this compiled-bundle check remains a valid build verification.

Verify that the compiled bundle activates cleanly and registers all tools and commands:

```bash
node --input-type=module -e "
import('./dist/index.js').then((m) => {
  const registered = { tools: [], commands: [] };
  const pi = {
    registerTool: (t) => registered.tools.push(t.name),
    registerCommand: (n) => registered.commands.push(n),
  };
  m.default(pi);
  if (registered.tools[0] !== 'show_image') throw new Error('show_image not registered');
  if (registered.commands[0] !== 'images') throw new Error('images command not registered');
  console.log('activation ok:', JSON.stringify(registered));
});
"
```

## Coding Conventions

1. **Zero Runtime Dependencies:** Keep the extension lightweight. Depend only on pi's peer packages (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`) plus `typebox` (a pi core package, declared peer dependency), and Node built-in modules (`node:fs`, `node:path`, `node:child_process`).
2. **Test-Driven Design:** Add unit tests in [test/](test) for any new logic or bug fix. Inject dependencies (like `runChafa` or `readHostImages`) so tests remain fully deterministic and run headless.
3. **ANSI & Control Sequence Safety:**
   - Plain text results must remain human-readable and clean of ANSI escapes.
   - Colored symbol outputs belong exclusively in custom pi-tui [`Text`](src/show-image.ts) components via `renderResult`.
   - Always sanitize external path strings with [`stripControls`](src/show-image.ts).
   - Construct control-character regular expressions via `new RegExp(...)` using string constants to comply with Biome's `noControlCharactersInRegex` rule.
4. **Git Commit Messages:** Use [Conventional Commits](https://www.conventionalcommits.org/):
   - `feat:` new feature or tool capability
   - `fix:` bug fix or edge case correction
   - `docs:` documentation updates
   - `test:` adding or improving tests
   - `chore:` tooling or build script maintenance

## Releases

Releases are automated and **maintainer-only** — contributors do not bump versions, tag, or edit [`CHANGELOG.md`](CHANGELOG.md).

```text
conventional commit on main
        │
        ▼
release-please opens/updates a release PR   (semver bump + CHANGELOG.md entry)
        │
        ▼
maintainer merges the release PR            (creates the GitHub release + tag)
        │
        ▼
release-please.yml's publish job STAGES the version to npm
        │
        ▼
maintainer approves with 2FA: `npm stage approve <stage-id>`   → live
```

What this means in practice:

- **Commit types decide the version.** `feat:` → minor, `fix:` → patch, `perf:`/`revert:` also release; breaking changes land as minor while pre-1.0 (`bump-minor-pre-major`). `docs:`, `chore:`, `test:`, `ci:`, `refactor:` are hidden from the changelog and release nothing on their own.
- **Staged is not shipped.** While a version sits in staging it is not installable; `npm view @lordekeen/pi-chafa version` still reports the previous version until a maintainer approves it.
- **Publish jobs run on Node 24.** `npm stage publish` requires npm CLI ≥ 11.15.0, and Node 22 still bundles npm 10.x.
- **`NPM_TOKEN`** (repository secret) must be a staging-capable granular token. CI needs no 2FA because staging is the credential-free step; the approval is where 2FA happens.
- **Emergency path:** run the *manual-publish* workflow (`.github/workflows/publish-manual.yml`) from `main` to stage the current version directly.

### First-publish exception (`0.2.0`)

A package that does not exist on the registry yet cannot be staged, so the first version is necessarily local and manual, and its anchor must exist before any release-please run sees `main`:

```bash
npm run typecheck && npm run lint && npm test && npm run build
npm publish --access public              # no staging: nothing to stage yet
gh release create v0.2.0 --target <sha> --title "v0.2.0" --notes "Initial release"
```

The hand-made release is what anchors [release-please-config.json](release-please-config.json) (via [.release-please-manifest.json](.release-please-manifest.json)); without it, release-please counts commits from the beginning of history and proposes one giant release. Push the tag in the same push as the release-prep commit (`git push origin main v0.2.0`) so the first run already sees it, then create the release on that tag. A hand-made release runs no `release_created`-gated job, so it cannot publish anything by accident.

## Pull Request Checklist

- [ ] Branch created from `main`.
- [ ] Code follows existing style and passes `npm run lint`.
- [ ] TypeScript passes with zero diagnostics (`npm run typecheck`).
- [ ] All unit and integration tests pass (`npm test`).
- [ ] Build succeeds and outputs clean artifacts to `dist/` (`npm run build`). Remember `dist/` is a verification artifact and is **not** published.
- [ ] No manual edits to `CHANGELOG.md` or the version in `package.json` — release-please owns both.
- [ ] *If* `chafa` and ImageMagick are available on `PATH`: real-dependency smoke test passes (`npm run test:smoke`). It skips cleanly with exit 0 when they are not, so this is not a blocker on machines without them.
- [ ] Documentation ([README.md](README.md), [DESIGN.md](DESIGN.md), [AGENTS.md](AGENTS.md)) updated if user-facing behavior or architectural contracts changed.
