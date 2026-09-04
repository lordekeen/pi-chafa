# Contributing to pi-chafa

Thank you for your interest in improving `pi-chafa`. This guide outlines our design principles, local setup, and quality standards.

## Philosophy

`pi-chafa` has a single, focused purpose: show image files to the **user** in the pi terminal cleanly, safely, and universally.

- **UI/UX, not Vision:** Features that send image contents back into the model context do not belong in this extension.
- **Safety First:** We prioritize TUI stability and terminal safety. Any code that emits raw control codes or risks terminal corruption will not be accepted.
- **Understand Your Code:** AI tools and agentic workflows are encouraged, but you must understand every line of code submitted. Blindly generated changes without technical verification will be closed.

## Prerequisites

- **Node.js:** Node ≥ 20.x (tested on Node 24.x with ECMAScript modules).
- **Chafa:** System binary ≥ 1.10.0 installed on `PATH` (recommended: 1.18.x).
  - macOS: `brew install chafa`
  - Ubuntu/Debian: `sudo apt install chafa`
  - Arch Linux: `sudo pacman -S chafa`
- **pi:** [pi coding agent](https://pi.dev) installed locally.

## Development Setup

Clone the repository and install dev dependencies:

```bash
git clone https://github.com/your-username/pi-chafa.git
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

### Activation Smoke Test

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

1. **Zero Runtime Dependencies:** Keep the extension lightweight. Depend only on pi's peer packages (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`) and Node built-in modules (`node:fs`, `node:path`, `node:child_process`).
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

## Pull Request Checklist

- [ ] Branch created from `main`.
- [ ] Code follows existing style and passes `npm run lint`.
- [ ] TypeScript passes with zero diagnostics (`npm run typecheck`).
- [ ] All unit and integration tests pass (`npm test`).
- [ ] Build succeeds and outputs clean artifacts to `dist/` (`npm run build`).
- [ ] Documentation ([README.md](README.md), [DESIGN.md](DESIGN.md), [AGENTS.md](AGENTS.md)) updated if user-facing behavior or architectural contracts changed.
