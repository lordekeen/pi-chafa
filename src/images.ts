import { type Dirent, readdirSync, realpathSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { stripControls } from "./sanitize.js";

/** Directories never walked during magic-pattern expansion (documented guard). */
const PRUNE_DIRS = new Set([".git", "node_modules"]);

const MAGIC_RE = /[*?]/;

export function hasMagic(pattern: string): boolean {
	return MAGIC_RE.test(pattern);
}

function escapeRegExpChar(char: string): string {
	return /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}

/**
 * Translate a slash-separated glob to an anchored RegExp. A double-star
 * segment ("**") matches zero-or-more whole directory segments in ANY
 * position, not just leading: "**" then a suffix matches both a bare file
 * and `a/b/file`; a middle "**" matches `a/b` as well as `a/x/b`; a trailing
 * "**" matches everything under the prefix. A single star or question mark
 * stays within one segment. The double star is emitted as an optional group
 * that carries its own trailing "/", so the segment after it needs no extra
 * separator. An empty leading segment (an absolute pattern) contributes the
 * root "/" that expandTargets relies on when matching absolute paths.
 * POSIX dotfile rule (#029): a wildcard never matches a leading dot — `*`,
 * `?` and `**` skip `.hidden` — while a segment that starts with a literal dot
 * still matches it (`.hidden.png`, `.*.png`).
 */
export function globToRegExp(pattern: string): RegExp {
	const parts = pattern.replaceAll("\\", "/").split("/");
	let out = "";
	// True when the previous part was a non-final "**": its optional group may
	// end in "/", so the next segment must not receive another separator.
	let afterGlobStar = false;
	for (let i = 0; i < parts.length; i++) {
		const part = parts[i] as string;
		if (part === "") {
			// Only a leading empty part (absolute pattern) denotes a segment: the
			// root "/". Interior/trailing empties are repeated or trailing "/".
			if (out === "") out += "/";
			afterGlobStar = false;
			continue;
		}
		if (part === "**") {
			const isFinal = i === parts.length - 1;
			if (out !== "" && !out.endsWith("/") && !afterGlobStar) out += "/";
			// Every segment the double star consumes must itself be non-hidden.
			out += isFinal ? "(?:(?!\\.)[^/]+/)*(?!\\.)[^/]*" : "(?:(?!\\.)[^/]+/)*";
			afterGlobStar = !isFinal;
			continue;
		}
		if (out !== "" && !out.endsWith("/") && !afterGlobStar) out += "/";
		afterGlobStar = false;
		// POSIX dotfile rule (#029): a leading wildcard does not match a leading
		// dot; a segment that starts with a literal dot still matches dotfiles.
		if (part.startsWith("*") || part.startsWith("?")) out += "(?!\\.)";
		for (const char of part) {
			if (char === "*") out += "[^/]*";
			else if (char === "?") out += "[^/]";
			else out += escapeRegExpChar(char);
		}
	}
	return new RegExp(`^${out}$`);
}

/** Static prefix of an absolute, posix-normalized pattern up to the first magic segment. */
function searchRoot(absPattern: string): string {
	const segments = absPattern.split("/");
	let firstMagic = segments.findIndex((segment) => hasMagic(segment));
	if (firstMagic === -1) firstMagic = segments.length;
	const prefix = segments.slice(0, firstMagic).join("/");
	return prefix === "" ? "/" : prefix;
}

function walkFiles(root: string): string[] {
	const out: string[] = [];
	let sawSymlink = false;
	const stack = [root];
	while (stack.length > 0) {
		const current = stack.pop() as string;
		let entries: Dirent[];
		try {
			entries = readdirSync(current, { withFileTypes: true });
		} catch {
			continue; // unreadable dir during a magic walk: skip, not fatal
		}
		for (const entry of entries) {
			const entryPath = join(current, entry.name);
			if (entry.isSymbolicLink()) {
				// Follow the link to decide what it is (#001). A link to a file is a
				// match; a link to a directory is never descended (symlink cycles), and
				// a broken link or unreadable target is skipped silently.
				try {
					if (statSync(entryPath).isFile()) {
						sawSymlink = true;
						out.push(entryPath);
					}
				} catch {
					// broken link or unreadable target: skip
				}
				continue;
			}
			if (entry.isDirectory()) {
				if (PRUNE_DIRS.has(entry.name)) continue;
				stack.push(entryPath);
			} else if (entry.isFile()) {
				out.push(entryPath);
			}
		}
	}
	const sorted = out.sort(compareCodeUnits);
	// A glob can match both a symlink and its target, which would render the same
	// image twice (#022). De-duplicate by resolved real path, keeping the first
	// path in code-unit order so the result stays deterministic. Gated on having
	// seen a symlink, so an ordinary walk pays no realpath cost.
	if (!sawSymlink) return sorted;
	const seen = new Set<string>();
	const deduped: string[] = [];
	for (const file of sorted) {
		let real: string;
		try {
			real = realpathSync(file);
		} catch {
			// Vanished mid-walk: keep it, so the reader reports the per-file failure.
			deduped.push(file);
			continue;
		}
		if (seen.has(real)) continue;
		seen.add(real);
		deduped.push(file);
	}
	return deduped;
}

function compareCodeUnits(a: string, b: string): number {
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}

function posix(p: string): string {
	return p.split(sep).join("/");
}

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/**
 * Normalize a user-supplied target the way pi's own tools do (`normalizePath`
 * in pi's `utils/paths.ts`, behind `resolveToCwd` for read/edit/write): unicode
 * spaces become ASCII, a leading `@` file-reference marker is stripped, `~` and
 * `~/…` expand to the home directory, and `file://` URLs become paths. A model
 * that passes what `read`/`edit` accept must not get "no files matched" here
 * (#028). Pure: `home` is injectable for tests.
 */
export function normalizeTargetPath(
	target: string,
	home: string = homedir(),
	platform: string = process.platform,
): string {
	let out = target.replace(UNICODE_SPACES, " ");
	if (out.startsWith("@")) out = out.slice(1);
	if (out === "~") return home;
	if (out.startsWith("~/") || (platform === "win32" && out.startsWith("~\\"))) {
		return join(home, out.slice(2));
	}
	if (/^file:\/\//.test(out)) {
		try {
			return fileURLToPath(out);
		} catch {
			return out;
		}
	}
	return out;
}

/**
 * Resolve `target` (explicit path or glob; absolute, `~/`-relative or
 * cwd-relative) to the sorted list of existing file paths. Targets are first
 * normalized through {@link normalizeTargetPath} (#028). Explicit directories
 * throw a dedicated error; zero surviving matches throw a no-files-matched
 * error (spec §8).
 */
export function expandTargets(
	target: string,
	cwd: string,
	home: string = homedir(),
): string[] {
	if (typeof target !== "string" || target.trim() === "") {
		throw new Error("show_image requires a non-empty path or glob");
	}
	const normalized = normalizeTargetPath(target, home);
	const joined = isAbsolute(normalized) ? normalized : resolve(cwd, normalized);
	const absPattern = posix(joined);

	if (!hasMagic(absPattern)) {
		try {
			// statSync (not lstatSync) follows symlinks: a link to a file resolves to
			// the link path, a link to a directory hits the directory error below, and
			// a broken link throws ENOENT which the catch maps to [] (#001).
			const stats = statSync(absPattern);
			if (stats.isDirectory()) {
				throw new Error(
					`${stripControls(target)} is a directory; show_image targets files`,
				);
			}
			if (!stats.isFile()) return [];
			return [absPattern];
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
	}

	const regex = globToRegExp(absPattern);
	const root = searchRoot(absPattern);
	const matches = walkFiles(root).filter((file) => regex.test(posix(file)));
	if (matches.length === 0) {
		throw new Error(
			`no files matched ${stripControls(target)}. Try a narrower or wider pattern, or pass an explicit file path.`,
		);
	}
	return matches;
}

/** Read a file's bytes; failures keep the path in the message (spec §8, per-file handling). */
export async function readBytes(filePath: string): Promise<Buffer> {
	try {
		return await readFile(filePath);
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		throw new Error(`failed to read ${filePath}: ${err.message}`);
	}
}

/**
 * Byte-level mime sniff (magic bytes only — spec §7.4). Supports the set pi's
 * own dimension reader understands; unknown bytes → application/octet-stream.
 */
export function sniffMime(bytes: Buffer): string {
	if (
		bytes.length >= 8 &&
		bytes
			.subarray(0, 8)
			.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
	) {
		return "image/png";
	}
	if (
		bytes.length >= 3 &&
		bytes[0] === 0xff &&
		bytes[1] === 0xd8 &&
		bytes[2] === 0xff
	) {
		return "image/jpeg";
	}
	if (bytes.length >= 6 && bytes.subarray(0, 4).toString("ascii") === "GIF8") {
		return "image/gif";
	}
	if (
		bytes.length >= 12 &&
		bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
		bytes.subarray(8, 12).toString("ascii") === "WEBP"
	) {
		return "image/webp";
	}
	// BMP ("BM") — #015
	if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
		return "image/bmp";
	}
	// ICO (00 00 01 00) — #015
	if (
		bytes.length >= 4 &&
		bytes[0] === 0x00 &&
		bytes[1] === 0x00 &&
		bytes[2] === 0x01 &&
		bytes[3] === 0x00
	) {
		return "image/x-icon";
	}
	// AVIF: an ISO-BMFF ftyp box whose major brand is avif/avis, or that lists
	// one in its compatible-brands region (bounded to the box and 512 bytes so a
	// stray "avif" string in another container cannot match) — #015.
	if (bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp") {
		const major = bytes.subarray(8, 12).toString("ascii");
		if (major === "avif" || major === "avis") return "image/avif";
		const boxSize = bytes.readUInt32BE(0);
		const end = Math.min(
			bytes.length,
			boxSize >= 16 ? boxSize : bytes.length,
			512,
		);
		for (let offset = 16; offset + 4 <= end; offset += 4) {
			const brand = bytes.subarray(offset, offset + 4).toString("ascii");
			if (brand === "avif" || brand === "avis") return "image/avif";
		}
	}
	// SVG: text whose first element is <svg>, tolerating an ignorable prefix in
	// any order and any count — a BOM, whitespace, XML prologs, DOCTYPEs and
	// comments (the prolog+generator-comment shape most real-world exporters
	// emit, which the single-pass form missed; #023). Deliberately strict about
	// the element name (never `<svgfoo`) and about `<svg` appearing only later
	// in the text, so a document that merely mentions SVG stays octet-stream — #014.
	let rest = bytes.subarray(0, 512).toString("utf8");
	if (rest.startsWith("\uFEFF")) rest = rest.slice(1);
	// Bounded: the 512-byte window already caps the scan, and the loop stops as
	// soon as the prefix stops shrinking, so a malformed prefix cannot spin.
	for (let stripped = 0; stripped < 32; stripped += 1) {
		const before = rest;
		rest = rest
			.replace(/^\s+/, "")
			.replace(/^<\?xml[\s\S]*?\?>/, "")
			.replace(/^<!DOCTYPE[\s\S]*?>/i, "")
			.replace(/^<!--[\s\S]*?-->/, "");
		if (rest === before) break;
	}
	if (/^<svg[\s/>]/i.test(rest)) return "image/svg+xml";
	return "application/octet-stream";
}
