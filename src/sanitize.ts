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
// Non-global twin: `.test()` on a /g regex advances lastIndex between calls.
const CONTROL_TEST_RE = new RegExp(CONTROL_CHARS);
const CSI_RE = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, "g");

/** Strip control characters and ANSI escapes from path/label-derived text (AGENTS.md invariant 3). */
export function stripControls(s: string): string {
	return s.replace(CSI_RE, "").replace(CONTROL_RE, "");
}

/**
 * True when `s` carries a raw control character. Callers that persist user input
 * refuse such a value rather than stripping it: a stripped path is a *different*
 * path than the user typed (invariant 3).
 */
export function hasControlChars(s: string): boolean {
	return CONTROL_TEST_RE.test(s);
}
