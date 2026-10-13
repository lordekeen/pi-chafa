import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	expandTargets,
	globToRegExp,
	normalizeTargetPath,
	readBytes,
	sniffMime,
} from "../src/images.js";

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
		expect(globToRegExp("screenshots/*.png").test("screenshots/a.png")).toBe(
			true,
		);
		expect(globToRegExp("screenshots/*.png").test("sub/a.png")).toBe(false);
		expect(globToRegExp("*.png").test("sub/a.png")).toBe(false);
	});
	it("supports whole-segment ** across directories", () => {
		const re = globToRegExp("**/*.jpg");
		expect(re.test("a.jpg")).toBe(true);
		expect(re.test("sub/deep/b.jpg")).toBe(true);
	});
	it("never lets wildcards match a leading dot (POSIX, #029)", () => {
		expect(globToRegExp("*.png").test("a.png")).toBe(true);
		expect(globToRegExp("*.png").test(".png")).toBe(false);
		expect(globToRegExp("*.png").test(".hidden.png")).toBe(false);
		expect(globToRegExp("**/*.png").test("a.png")).toBe(true);
		expect(globToRegExp("**/*.png").test("sub/a.png")).toBe(true);
		expect(globToRegExp("**/*.png").test(".a.png")).toBe(false);
		expect(globToRegExp("**/*.png").test(".hidden/a.png")).toBe(false);
	});
	it("matches dotfiles when the segment starts with an explicit dot", () => {
		expect(globToRegExp(".png").test(".png")).toBe(true);
		expect(globToRegExp(".*.png").test(".x.png")).toBe(true);
		expect(globToRegExp(".*.png").test(".png")).toBe(false);
	});
});

describe("expandTargets", () => {
	it("resolves an explicit relative file against cwd", () => {
		expect(expandTargets("screenshots/a.png", dir)).toEqual([
			join(dir, "screenshots", "a.png"),
		]);
	});
	it("resolves an absolute path unchanged", () => {
		const abs = join(dir, "screenshots", "a.png");
		expect(expandTargets(abs, dir)).toEqual([abs]);
	});
	it("returns an empty list for a missing literal path (caller reports zero match)", () => {
		expect(expandTargets(join(dir, "nope.png"), dir)).toEqual([]);
	});
	it("throws a dedicated error for an explicit directory target", () => {
		expect(() => expandTargets("screenshots", dir)).toThrow(
			/is a directory; show_image targets files/,
		);
	});
	it("expands a glob to sorted existing files only", () => {
		expect(expandTargets("screenshots/*", dir)).toEqual([
			join(dir, "screenshots", "a.png"),
			join(dir, "screenshots", "b.jpg"),
		]);
	});
	it("caps a broad glob at 50 matches with an actionable error (#035)", () => {
		mkdirSync(join(dir, "many"), { recursive: true });
		for (let i = 0; i < 60; i++) {
			writeFileSync(join(dir, "many", `f${i}.png`), "png-bytes");
		}
		let threw: Error | null = null;
		try {
			expandTargets("many/*.png", dir);
		} catch (error) {
			threw = error as Error;
		}
		expect(threw).not.toBeNull();
		expect(threw!.message).toContain("60");
		expect(threw!.message).toContain("caps at 50");
		expect(threw!.message).toContain("narrow the pattern");
	});
	it("honors an aborted signal during expansion (#035)", () => {
		const controller = new AbortController();
		controller.abort();
		let threw: Error | null = null;
		try {
			expandTargets("**/*.png", dir, undefined, controller.signal);
		} catch (error) {
			threw = error as Error;
		}
		expect(threw).not.toBeNull();
		expect(threw!.name).toBe("AbortError");
	});
	it("matches nested files with ** and skips directories", () => {
		expect(expandTargets("**/*.gif", dir)).toEqual([join(dir, "sub", "c.gif")]);
		expect(expandTargets("**/*.webp", dir)).toEqual([
			join(dir, "sub", "deep", "d.webp"),
		]);
	});
	it("throws no-files-matched for a glob with zero matches", () => {
		expect(() => expandTargets("**/*.svg", dir)).toThrow(
			/no files matched \*\*\/\*\.svg/,
		);
	});
	it("sanitizes control bytes in the directory error message (#038)", () => {
		const evilDir = join(dir, "evil\x1b[2Jdir");
		mkdirSync(evilDir);
		let threw: Error | null = null;
		try {
			expandTargets(evilDir, dir);
		} catch (error) {
			threw = error as Error;
		}
		expect(threw).not.toBeNull();
		expect(threw!.message).toContain(
			"is a directory; show_image targets files",
		);
		expect(threw!.message).not.toContain("\x1b");
	});
	it("sanitizes control bytes in the no-match error message (#038)", () => {
		const evil = "no\x07match*.png";
		let threw: Error | null = null;
		try {
			expandTargets(evil, dir);
		} catch (error) {
			threw = error as Error;
		}
		expect(threw).not.toBeNull();
		expect(threw!.message).toContain("no files matched");
		expect(threw!.message).not.toContain("\x07");
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

describe("expandTargets — pi path conventions (#028)", () => {
	it("expands ~ and ~/... against the home directory", () => {
		expect(normalizeTargetPath("~", "/fake/home")).toBe("/fake/home");
		expect(normalizeTargetPath("~/Pictures/a.png", "/fake/home")).toBe(
			join("/fake/home", "Pictures", "a.png"),
		);
		expect(expandTargets("~/screenshots/a.png", dir, dir)).toEqual([
			join(dir, "screenshots", "a.png"),
		]);
	});

	it("strips pi's @ file-reference prefix", () => {
		expect(normalizeTargetPath("@screenshots/a.png", "/fake/home")).toBe(
			"screenshots/a.png",
		);
		expect(expandTargets("@screenshots/a.png", dir, dir)).toEqual([
			join(dir, "screenshots", "a.png"),
		]);
	});

	it("normalizes unicode spaces and file:// URLs", () => {
		expect(normalizeTargetPath("screenshots\u00A0a.png", "/fake/home")).toBe(
			"screenshots a.png",
		);
		expect(
			normalizeTargetPath(`file://${dir}/screenshots/a.png`, "/fake/home"),
		).toBe(join(dir, "screenshots", "a.png"));
	});

	it("leaves absolute and cwd-relative targets untouched", () => {
		const abs = join(dir, "screenshots", "a.png");
		expect(normalizeTargetPath("screenshots/a.png", "/fake/home")).toBe(
			"screenshots/a.png",
		);
		expect(normalizeTargetPath(abs, "/fake/home")).toBe(abs);
	});

	it("accepts the Windows ~\\ form only when the platform says win32 (#031 seam)", () => {
		expect(
			normalizeTargetPath("~\\Pictures\\a.png", "/fake/home", "win32"),
		).toBe(join("/fake/home", "Pictures\\a.png"));
		expect(
			normalizeTargetPath("~\\Pictures\\a.png", "/fake/home", "linux"),
		).toBe("~\\Pictures\\a.png");
	});
});

describe("expandTargets — dotfiles (#029)", () => {
	it("excludes dotfiles from wildcard expansion", () => {
		writeFileSync(join(dir, ".hidden.png"), "png-bytes");
		writeFileSync(join(dir, "visible.png"), "png-bytes");
		mkdirSync(join(dir, ".hidden-dir"), { recursive: true });
		writeFileSync(join(dir, ".hidden-dir", "inside.png"), "png-bytes");
		expect(expandTargets("*.png", dir, dir)).toEqual([
			join(dir, "visible.png"),
		]);
		expect(expandTargets("**/*.png", dir, dir)).not.toContain(
			join(dir, ".hidden.png"),
		);
		expect(expandTargets("**/*.png", dir, dir)).not.toContain(
			join(dir, ".hidden-dir", "inside.png"),
		);
	});

	it("still resolves an explicitly named dotfile", () => {
		writeFileSync(join(dir, ".hidden.png"), "png-bytes");
		expect(expandTargets(".hidden.png", dir, dir)).toEqual([
			join(dir, ".hidden.png"),
		]);
	});
});

describe("expandTargets — symlinks (#001)", () => {
	// Symlink creation can be unavailable (Windows without developer mode,
	// restricted sandboxes); each case reports a skip instead of failing.
	function trySymlink(target: string, linkPath: string): boolean {
		try {
			symlinkSync(target, linkPath);
			return true;
		} catch {
			return false;
		}
	}
	it("resolves an explicit symlink to a file at the link path, not the target", (context) => {
		const link = join(dir, "link.png");
		if (!trySymlink(join(dir, "screenshots", "a.png"), link)) {
			context.skip();
			return;
		}
		expect(expandTargets("link.png", dir)).toEqual([link]);
	});
	it("throws the directory error for an explicit symlink to a directory", (context) => {
		const link = join(dir, "link-dir");
		if (!trySymlink(join(dir, "screenshots"), link)) {
			context.skip();
			return;
		}
		expect(() => expandTargets("link-dir", dir)).toThrow(
			/is a directory; show_image targets files/,
		);
	});
	it("returns an empty list for a broken symlink", (context) => {
		const link = join(dir, "broken.png");
		if (!trySymlink(join(dir, "missing-target.png"), link)) {
			context.skip();
			return;
		}
		expect(expandTargets("broken.png", dir)).toEqual([]);
	});
	it("includes a symlinked image in a glob walk (#001)", (context) => {
		// The pattern matches only the link, and its target does not match it, so
		// the link is the only path representing the file: #001 requires it.
		const link = join(dir, "screenshots", "link.png");
		if (!trySymlink(join(dir, "sub", "c.gif"), link)) {
			context.skip();
			return;
		}
		expect(expandTargets("screenshots/link*.png", dir)).toEqual([link]);
	});
	it("de-duplicates a symlink whose target also matches the glob (#022)", (context) => {
		const link = join(dir, "screenshots", "z-link.png");
		if (!trySymlink(join(dir, "screenshots", "a.png"), link)) {
			context.skip();
			return;
		}
		// Both paths match `*.png` but resolve to the same file: one entry, and the
		// first path in code-unit order wins.
		expect(expandTargets("screenshots/*.png", dir)).toEqual([
			join(dir, "screenshots", "a.png"),
		]);
	});
	it("de-duplicates two symlinks pointing at the same target (#022)", (context) => {
		const first = join(dir, "screenshots", "m-one.png");
		const second = join(dir, "screenshots", "n-two.png");
		if (
			!trySymlink(join(dir, "sub", "c.gif"), first) ||
			!trySymlink(join(dir, "sub", "c.gif"), second)
		) {
			context.skip();
			return;
		}
		// a.png is a real file and must survive the de-duplication untouched.
		expect(expandTargets("screenshots/*.png", dir)).toEqual([
			join(dir, "screenshots", "a.png"),
			first,
		]);
	});
	it("does not descend a symlinked directory during a glob walk", (context) => {
		const link = join(dir, "link-sub");
		if (!trySymlink(join(dir, "sub"), link)) {
			context.skip();
			return;
		}
		expect(expandTargets("**/*.gif", dir)).toEqual([join(dir, "sub", "c.gif")]);
	});
});

describe("readBytes + sniffMime", () => {
	const PNG = Buffer.from([
		0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 1,
	]);
	const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
	const GIF = Buffer.from("GIF89a....", "ascii");
	const GIF87 = Buffer.from("GIF87a....", "ascii");
	const WEBP = Buffer.from("RIFF\x24\x00\x00\x00WEBPVP8 ", "ascii");
	it("sniffs png/jpeg/gif/webp magic bytes", () => {
		expect(sniffMime(PNG)).toBe("image/png");
		expect(sniffMime(JPEG)).toBe("image/jpeg");
		expect(sniffMime(GIF)).toBe("image/gif");
		expect(sniffMime(GIF87)).toBe("image/gif");
		expect(sniffMime(WEBP)).toBe("image/webp");
	});
	it("keeps the 6-byte GIF length guard", () => {
		expect(sniffMime(Buffer.from("GIF8", "ascii"))).toBe(
			"application/octet-stream",
		);
	});
	it("falls back to application/octet-stream for unknown bytes", () => {
		expect(sniffMime(Buffer.from("hello world"))).toBe(
			"application/octet-stream",
		);
	});
	const BMP = Buffer.from([0x42, 0x4d, 0x36, 0x00, 0x00, 0x00, 0x00, 0x00]);
	const ICO = Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x10, 0x10]);
	const AVIF = Buffer.concat([
		Buffer.from([0x00, 0x00, 0x00, 0x20]),
		Buffer.from("ftyp", "ascii"),
		Buffer.from("avif", "ascii"),
		Buffer.from([0x00, 0x00, 0x00, 0x00]),
	]);
	const AVIF_SEQUENCE = Buffer.concat([
		Buffer.from([0x00, 0x00, 0x00, 0x20]),
		Buffer.from("ftyp", "ascii"),
		Buffer.from("avis", "ascii"),
		Buffer.from([0x00, 0x00, 0x00, 0x00]),
	]);
	it("sniffs bmp/ico/avif magic bytes (#015)", () => {
		expect(sniffMime(BMP)).toBe("image/bmp");
		expect(sniffMime(ICO)).toBe("image/x-icon");
		expect(sniffMime(AVIF)).toBe("image/avif");
		expect(sniffMime(AVIF_SEQUENCE)).toBe("image/avif");
	});
	it("accepts an avif brand in the ftyp compatible-brands list (conservatively)", () => {
		const compatible = Buffer.concat([
			Buffer.from([0x00, 0x00, 0x00, 0x20]),
			Buffer.from("ftyp", "ascii"),
			Buffer.from("mif1", "ascii"),
			Buffer.from([0x00, 0x00, 0x00, 0x00]),
			Buffer.from("avif", "ascii"),
		]);
		expect(sniffMime(compatible)).toBe("image/avif");
	});
	it("does not mistake another BMFF brand for avif (#015)", () => {
		const mp4 = Buffer.concat([
			Buffer.from([0x00, 0x00, 0x00, 0x18]),
			Buffer.from("ftyp", "ascii"),
			Buffer.from("mp42", "ascii"),
			Buffer.from([0x00, 0x00, 0x00, 0x00]),
		]);
		expect(sniffMime(mp4)).toBe("application/octet-stream");
	});
	it("sniffs svg with and without a prolog, BOM, or doctype (#014)", () => {
		expect(
			sniffMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')),
		).toBe("image/svg+xml");
		expect(
			sniffMime(
				Buffer.from(
					'<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="x"></svg>',
				),
			),
		).toBe("image/svg+xml");
		expect(
			sniffMime(Buffer.from('\uFEFF\n  <svg viewBox="0 0 1 1"></svg>')),
		).toBe("image/svg+xml");
		expect(
			sniffMime(
				Buffer.from(
					'<?xml version="1.0"?><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"><svg></svg>',
				),
			),
		).toBe("image/svg+xml");
	});
	it("tolerates comments in the pre-element prefix, any order or count (#023)", () => {
		const docs = [
			'<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n<!-- Generator: Adobe -->\n<svg xmlns="x"></svg>',
			'<?xml version="1.0"?>\n<!DOCTYPE svg>\n<!-- c -->\n<svg></svg>',
			'\uFEFF<?xml version="1.0"?>\n<!-- c -->\n<svg></svg>',
			"<!-- c -->\n<svg></svg>",
			'<!-- a --><!-- b -->\n<!DOCTYPE svg>\n<?xml version="1.0"?>\n<svg></svg>',
		];
		for (const doc of docs) {
			expect(sniffMime(Buffer.from(doc))).toBe("image/svg+xml");
		}
	});
	it("does not treat text that merely mentions svg as an image (#014)", () => {
		expect(sniffMime(Buffer.from("hello <svg world"))).toBe(
			"application/octet-stream",
		);
		expect(sniffMime(Buffer.from('<?xml version="1.0"?><not-an-svg/>'))).toBe(
			"application/octet-stream",
		);
		expect(sniffMime(Buffer.from("<svgfoo></svgfoo>"))).toBe(
			"application/octet-stream",
		);
	});
	it("keeps the #014 decoy strictness after stripping the prefix (#023)", () => {
		expect(
			sniffMime(Buffer.from('<?xml version="1.0"?><!-- c --><not-an-svg/>')),
		).toBe("application/octet-stream");
		expect(sniffMime(Buffer.from("<!-- c -->\n<svgfoo></svgfoo>"))).toBe(
			"application/octet-stream",
		);
		expect(sniffMime(Buffer.from("hello <!-- c --> <svg></svg>"))).toBe(
			"application/octet-stream",
		);
		expect(sniffMime(Buffer.from("<!-- unterminated <svg></svg>"))).toBe(
			"application/octet-stream",
		);
	});
	it("reads bytes from a real file", async () => {
		const bytes = await readBytes(join(dir, "notes.txt"));
		expect(bytes.toString("utf8")).toBe("text");
	});
	it("rejects unreadable files with the path in the message", async () => {
		await expect(readBytes(join(dir, "missing.png"))).rejects.toThrow(
			/missing\.png/,
		);
	});
});
