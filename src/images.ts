import { type Dirent, lstatSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

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
 * Translate a slash-separated glob to an anchored RegExp. A whole-segment
 * double star ("`**`") crosses "/", while a single star or question mark
 * does not. A LEADING double-star glob (more segments follow) matches
 * zero-or-more whole directory segments, so it matches a bare `a.jpg` as
 * well as `sub/deep/b.jpg`; its optional group carries the trailing "/".
 * Separators are emitted per segment index so an absolute pattern (leading
 * "/") keeps the "/" that expandTargets relies on when matching against
 * absolute paths.
 */
export function globToRegExp(pattern: string): RegExp {
	const parts = pattern.replaceAll("\\", "/").split("/");
	let out = "";
	const leadingGlobStar = parts.length > 1 && parts[0] === "**";
	const segments = leadingGlobStar ? parts.slice(1) : parts;
	if (leadingGlobStar) out += "(?:.*/)?";
	for (let i = 0; i < segments.length; i++) {
		if (i > 0) out += "/";
		const part = segments[i] as string;
		if (part === "**") {
			out += ".*";
			continue;
		}
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
			if (entry.isDirectory()) {
				if (PRUNE_DIRS.has(entry.name)) continue;
				stack.push(join(current, entry.name));
			} else if (entry.isFile()) {
				out.push(join(current, entry.name));
			}
		}
	}
	return out.sort();
}

function posix(p: string): string {
	return p.split(sep).join("/");
}

/**
 * Resolve `target` (explicit path or glob, absolute or cwd-relative) to the
 * sorted list of existing file paths. Explicit directories throw a dedicated
 * error; zero surviving matches throw a no-files-matched error (spec §8).
 */
export function expandTargets(target: string, cwd: string): string[] {
	if (typeof target !== "string" || target.trim() === "") {
		throw new Error("show_image requires a non-empty path or glob");
	}
	const joined = isAbsolute(target) ? target : resolve(cwd, target);
	const absPattern = posix(joined);

	if (!hasMagic(absPattern)) {
		try {
			const stats = lstatSync(absPattern);
			if (stats.isDirectory()) {
				throw new Error(`${target} is a directory; show_image targets files`);
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
			`no files matched ${target}. Try a narrower or wider pattern, or pass an explicit file path.`,
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
	if (
		bytes.length >= 6 &&
		bytes.subarray(0, 6).toString("ascii") === "GIF87a"
	) {
		return "image/gif";
	}
	if (
		bytes.length >= 6 &&
		bytes.subarray(0, 6).toString("ascii") === "GIF89a"
	) {
		return "image/gif";
	}
	if (
		bytes.length >= 12 &&
		bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
		bytes.subarray(8, 12).toString("ascii") === "WEBP"
	) {
		return "image/webp";
	}
	return "application/octet-stream";
}

/** dirname re-export kept for callers that need the matched file's directory (DRY). */
export function matchedDir(filePath: string): string {
	return dirname(filePath);
}
