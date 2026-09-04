import { type Dirent, lstatSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";

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
			out += isFinal ? ".*" : "(?:.*/)?";
			afterGlobStar = !isFinal;
			continue;
		}
		if (out !== "" && !out.endsWith("/") && !afterGlobStar) out += "/";
		afterGlobStar = false;
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
