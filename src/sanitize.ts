/**
 * Neutral sanitization helpers (AGENTS.md invariant 3): user paths and labels
 * must never carry ANSI/control bytes into the TUI. This module exists because
 * `src/images.ts` may not import from `src/show-image.ts` (dependency cycle).
 */
// Regex-safety (biome noControlCharactersInRegex): instantiate via new RegExp
// from string constants.
const ESC = "\x1b";
const CONTROL_CHARS = "[\x00-\x1f\x7f]";
const CONTROL_RE = new RegExp(CONTROL_CHARS, "g");
const CSI_RE = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, "g");

/** Strip control characters and ANSI escapes from path/label-derived text (AGENTS.md invariant 3). */
export function stripControls(s: string): string {
	return s.replace(CSI_RE, "").replace(CONTROL_RE, "");
}
