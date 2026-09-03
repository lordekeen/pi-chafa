import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expandTargets, globToRegExp, hasMagic, readBytes, sniffMime } from "../src/images.js";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-chafa-images-"));
	mkdirSync(join(dir, "screenshots"), { recursive: true });
	mkdirSync(join(dir, "sub", "deep"), { recursive: true });
	writeFileSync(join(dir, "screenshots", "a.png"), "png-bytes");
	writeFileSync(join(dir, "screenshots", "b.jpg"), "jpg-bytes");
	writeFileSync(join(dir, "sub", "c.gif"), "gif-bytes");
	writeFileSync(join(dir, "sub", "deep", "d.webp"), "webp-bytes");
	writeFileSync(join(dir, "notes.txt"), "text");
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("globToRegExp", () => {
	it("anchors and matches * within a segment only", () => {
		expect(globToRegExp("screenshots/*.png").test("screenshots/a.png")).toBe(true);
		expect(globToRegExp("screenshots/*.png").test("sub/a.png")).toBe(false);
		expect(globToRegExp("*.png").test("sub/a.png")).toBe(false);
	});
	it("supports whole-segment ** across directories", () => {
		const re = globToRegExp("**/*.jpg");
		expect(re.test("a.jpg")).toBe(true);
		expect(re.test("sub/deep/b.jpg")).toBe(true);
	});
});

describe("expandTargets", () => {
	it("resolves an explicit relative file against cwd", () => {
		expect(expandTargets("screenshots/a.png", dir)).toEqual([join(dir, "screenshots", "a.png")]);
	});
	it("resolves an absolute path unchanged", () => {
		const abs = join(dir, "screenshots", "a.png");
		expect(expandTargets(abs, dir)).toEqual([abs]);
	});
	it("returns an empty list for a missing literal path (caller reports zero match)", () => {
		expect(expandTargets(join(dir, "nope.png"), dir)).toEqual([]);
	});
	it("throws a dedicated error for an explicit directory target", () => {
		expect(() => expandTargets("screenshots", dir)).toThrow(/is a directory; show_image targets files/);
	});
	it("expands a glob to sorted existing files only", () => {
		expect(expandTargets("screenshots/*", dir)).toEqual([
			join(dir, "screenshots", "a.png"),
			join(dir, "screenshots", "b.jpg"),
		]);
	});
	it("matches nested files with ** and skips directories", () => {
		expect(expandTargets("**/*.gif", dir)).toEqual([join(dir, "sub", "c.gif")]);
		expect(expandTargets("**/*.webp", dir)).toEqual([join(dir, "sub", "deep", "d.webp")]);
	});
	it("throws no-files-matched for a glob with zero matches", () => {
		expect(() => expandTargets("**/*.svg", dir)).toThrow(/no files matched \*\*\/\*\.svg/);
	});
	it("matches a top-level file and a nested file for a ** glob", () => {
		// Regression: **/ in any position matches zero-or-more directories, so a
		// top-level file must not be silently omitted after resolution to an
		// absolute /<cwd>/**/*.gif pattern.
		writeFileSync(join(dir, "top.gif"), "gif-bytes");
		expect(expandTargets("**/*.gif", dir)).toEqual([
			join(dir, "sub", "c.gif"),
			join(dir, "top.gif"),
		]);
	});
	it("matches an absolute mid-** pattern at zero or more depths", () => {
		// globToRegExp must treat a mid-pattern ** the same as a leading one, so
		// an absolute /<cwd>/**/*.gif regex still matches top-level files.
		writeFileSync(join(dir, "top.gif"), "gif-bytes");
		const posixDir = dir.split(sep).join("/");
		const re = globToRegExp(`${posixDir}/**/*.gif`);
		expect(re.test(`${posixDir}/top.gif`)).toBe(true);
		expect(re.test(`${posixDir}/sub/c.gif`)).toBe(true);
	});
});

describe("readBytes + sniffMime", () => {
	const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 1]);
	const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
	const GIF = Buffer.from("GIF89a....", "ascii");
	const WEBP = Buffer.from("RIFF\x24\x00\x00\x00WEBPVP8 ", "ascii");
	it("sniffs png/jpeg/gif/webp magic bytes", () => {
		expect(sniffMime(PNG)).toBe("image/png");
		expect(sniffMime(JPEG)).toBe("image/jpeg");
		expect(sniffMime(GIF)).toBe("image/gif");
		expect(sniffMime(WEBP)).toBe("image/webp");
	});
	it("falls back to application/octet-stream for unknown bytes", () => {
		expect(sniffMime(Buffer.from("hello world"))).toBe("application/octet-stream");
	});
	it("reads bytes from a real file", async () => {
		const bytes = await readBytes(join(dir, "notes.txt"));
		expect(bytes.toString("utf8")).toBe("text");
	});
	it("rejects unreadable files with the path in the message", async () => {
		await expect(readBytes(join(dir, "missing.png"))).rejects.toThrow(/missing\.png/);
	});
});
