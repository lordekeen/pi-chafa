import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import {
	MIN_CHAFA_VERSION,
	buildSymbolsArgs,
	cleanSymbolsPayload,
	createCachedProbe,
	probeChafa,
	runChafa,
} from "../src/chafa.js";
import type { EffectiveSymbolsSettings } from "../src/types.js";

const settings: EffectiveSymbolsSettings = {
	cellWidth: DEFAULT_CONFIG.cellWidth,
	maxRows: DEFAULT_CONFIG.maxRows,
	colors: DEFAULT_CONFIG.colors,
	symbolsSet: DEFAULT_CONFIG.symbolsSet,
	dither: DEFAULT_CONFIG.dither,
	timeoutMs: DEFAULT_CONFIG.timeoutMs,
	binaryPath: null,
};

describe("buildSymbolsArgs (spec §7.3 chat-safe invocation)", () => {
	it("produces exactly the documented arg vector with no --clear", () => {
		expect(buildSymbolsArgs("/tmp/a.png", settings)).toEqual([
			"--format",
			"symbols",
			"--relative",
			"off",
			"--size",
			"60x50",
			"--colors",
			"240",
			"--symbols",
			"block+border",
			"--dither",
			"none",
			"--animate",
			"off",
			"/tmp/a.png",
		]);
	});
	it("reflects per-call settings in --size/--colors/--symbols/--dither", () => {
		const custom: EffectiveSymbolsSettings = { ...settings, cellWidth: 80, maxRows: 20, colors: "16", symbolsSet: "block", dither: "ordered" };
		const args = buildSymbolsArgs("x.png", custom);
		expect(args).toContain("80x20");
		expect(args).toContain("16");
		expect(args).toContain("block");
		expect(args).toContain("ordered");
		expect(args).not.toContain("--clear");
		expect(args).toContain("off");
	});
});

describe("cleanSymbolsPayload (spec §7.3 post-processing)", () => {
	const ART = "  \x1b[38;5;1m█\x1b[0m\n \x1b[38;5;2m█\x1b[0m\n";
	it("strips leading hide-cursor and trailing show-cursor escapes", () => {
		const raw = `\x1b[?25l${ART}\x1b[?25h`;
		expect(cleanSymbolsPayload(raw)).toBe(ART.trimEnd());
	});
	it("strips stray carriage returns (defensive; spec §3.6/§7.3)", () => {
		const raw = `\x1b[?25l${ART.replaceAll("\n", "\r\n")}\x1b[?25h`;
		expect(cleanSymbolsPayload(raw)).toBe(ART.trimEnd());
	});
	it("appends a final reset when the payload does not end with one (ANSI-leak risk 2)", () => {
		const raw = "\x1b[?25l\x1b[38;5;1mRED\x1b[?25h";
		expect(cleanSymbolsPayload(raw)).toBe("\x1b[38;5;1mRED\x1b[0m");
	});
	it("returns empty string for empty input", () => {
		expect(cleanSymbolsPayload("")).toBe("");
	});
});

describe("probeChafa", () => {
	it("parses the version line and returns the binary", async () => {
		const mockExec = vi.fn(async () => ({ stdout: "Chafa version 1.18.2\n", stderr: "" }));
		const probe = await probeChafa(null, mockExec as never);
		expect(probe.binary).toBe("chafa");
		expect(probe.version).toEqual({ major: 1, minor: 18 });
	});
	it("throws an actionable install error on ENOENT", async () => {
		const mockExec = vi.fn(async () => {
			const err = new Error("spawn chafa ENOENT") as NodeJS.ErrnoException;
			err.code = "ENOENT";
			throw err;
		});
		await expect(probeChafa(null, mockExec as never)).rejects.toThrow(/not found/);
		await expect(probeChafa(null, mockExec as never)).rejects.toThrow(/CHAFA_BIN/);
	});
	it("throws when the binary is older than the minimum supported version", async () => {
		const mockExec = vi.fn(async () => ({ stdout: "Chafa version 1.6.0\n", stderr: "" }));
		await expect(probeChafa(null, mockExec as never)).rejects.toThrow(
			new RegExp(`${MIN_CHAFA_VERSION.major}\\.${MIN_CHAFA_VERSION.minor}`),
		);
	});
	it("forwards the abort signal into the version exec (#008)", async () => {
		let seen: unknown;
		const mockExec = vi.fn(async (_bin, _args, opts) => {
			seen = (opts as { signal?: AbortSignal }).signal;
			return { stdout: "Chafa version 1.18.2\n", stderr: "" };
		});
		const controller = new AbortController();
		await probeChafa(null, mockExec as never, controller.signal);
		expect(seen).toBe(controller.signal);
	});
	it("rethrows an abort from the version exec instead of wrapping it (#008)", async () => {
		const mockExec = vi.fn(async () => {
			const err = new Error("The operation was aborted") as Error & { code?: string };
			err.name = "AbortError";
			err.code = "ABORT_ERR";
			throw err;
		});
		const err = await probeChafa(null, mockExec as never).then(
			() => undefined,
			(e: unknown) => e,
		);
		expect((err as Error).name).toBe("AbortError");
	});
	it("parses the Loaders line into a normalized upper-case list (#015)", async () => {
		const mockExec = vi.fn(async () => ({
			stdout:
				"Chafa version 1.18.2\n\nLoaders:  AVIF GIF HEIF JPEG JXL PNG QOI SVG TIFF WebP XWD\nFeatures: mmx sse4.1\n",
			stderr: "",
		}));
		const probe = await probeChafa(null, mockExec as never);
		expect(probe.loaders).toEqual([
			"AVIF",
			"GIF",
			"HEIF",
			"JPEG",
			"JXL",
			"PNG",
			"QOI",
			"SVG",
			"TIFF",
			"WEBP",
			"XWD",
		]);
	});
	it("upper-cases mixed-case loader names", async () => {
		const mockExec = vi.fn(async () => ({
			stdout: "Chafa version 1.18.2\nLoaders: avif Png\n",
			stderr: "",
		}));
		expect((await probeChafa(null, mockExec as never)).loaders).toEqual(["AVIF", "PNG"]);
	});
	it("excludes '#'-disabled loaders rather than assuming they exist", async () => {
		const mockExec = vi.fn(async () => ({
			stdout: "Chafa version 1.18.2\nLoaders: AVIF #BMP PNG\n",
			stderr: "",
		}));
		expect((await probeChafa(null, mockExec as never)).loaders).toEqual(["AVIF", "PNG"]);
	});
	it("reports loaders as null when the Loaders line is absent — never guesses (#015)", async () => {
		const mockExec = vi.fn(async () => ({ stdout: "Chafa version 1.18.2\n", stderr: "" }));
		expect((await probeChafa(null, mockExec as never)).loaders).toBe(null);
		const empty = vi.fn(async () => ({ stdout: "Chafa version 1.18.2\nLoaders:\n", stderr: "" }));
		expect((await probeChafa(null, empty as never)).loaders).toBe(null);
	});
});

describe("createCachedProbe (#007, #008)", () => {
	const okExec = () => ({ stdout: "Chafa version 1.18.2\n", stderr: "" });
	it("memoizes a successful probe by resolved binary path", async () => {
		const mockExec = vi.fn(async () => okExec());
		const cached = createCachedProbe(mockExec as never);
		const first = await cached(null);
		const second = await cached("chafa");
		expect(mockExec).toHaveBeenCalledTimes(1);
		expect(second).toEqual(first);
		expect(first.binary).toBe("chafa");
	});
	it("caches a different key per explicit binaryPath", async () => {
		const mockExec = vi.fn(async () => okExec());
		const cached = createCachedProbe(mockExec as never);
		await cached("/opt/chafa");
		await cached("/opt/chafa");
		await cached(null);
		expect(mockExec).toHaveBeenCalledTimes(2);
	});
	it("shares a single exec across concurrent calls", async () => {
		let calls = 0;
		const mockExec = vi.fn(async () => {
			calls++;
			await new Promise((resolve) => setTimeout(resolve, 5));
			return okExec();
		});
		const cached = createCachedProbe(mockExec as never);
		await Promise.all([cached(null), cached(null)]);
		expect(calls).toBe(1);
	});
	it("never caches a rejection, so a missing-then-installed chafa recovers", async () => {
		let calls = 0;
		const mockExec = vi.fn(async () => {
			calls++;
			if (calls === 1) {
				const err = new Error("spawn chafa ENOENT") as NodeJS.ErrnoException;
				err.code = "ENOENT";
				throw err;
			}
			return okExec();
		});
		const cached = createCachedProbe(mockExec as never);
		await expect(cached(null)).rejects.toThrow(/not found/);
		await expect(cached(null)).resolves.toMatchObject({ binary: "chafa" });
		expect(mockExec).toHaveBeenCalledTimes(2);
	});
	it("clear() drops the cached success", async () => {
		const mockExec = vi.fn(async () => okExec());
		const cached = createCachedProbe(mockExec as never);
		await cached(null);
		cached.clear();
		await cached(null);
		expect(mockExec).toHaveBeenCalledTimes(2);
	});
	it("rejects promptly for an already-aborted signal without spawning", async () => {
		const mockExec = vi.fn(async () => okExec());
		const cached = createCachedProbe(mockExec as never);
		await cached(null); // prime the cache: an abort must not be masked by it
		const controller = new AbortController();
		controller.abort();
		const err = await cached(null, controller.signal).then(
			() => undefined,
			(e: unknown) => e,
		);
		expect((err as Error).name).toBe("AbortError");
		expect(mockExec).toHaveBeenCalledTimes(1);
	});
});

describe("runChafa", () => {
	it("returns stdout on success", async () => {
		const mockExec = vi.fn(async () => ({ stdout: "ART", stderr: "" }));
		await expect(runChafa("/bin/chafa", ["--version"], { timeoutMs: 1000 }, mockExec as never)).resolves.toBe("ART");
	});
	it("surfaces stderr on nonzero exit", async () => {
		const mockExec = vi.fn(async () => {
			const err = new Error("Command failed") as Error & { stderr?: string; code?: number };
			err.code = 2;
			err.stderr = "chafa: cannot open /nope.png";
			throw err;
		});
		await expect(
			runChafa("/bin/chafa", ["/nope.png"], { timeoutMs: 1000 }, mockExec as never),
		).rejects.toThrow(/chafa: cannot open \/nope\.png/);
	});
	it("reports a timeout with a remedy hint", async () => {
		const mockExec = vi.fn(async () => {
			const err = new Error("Command failed") as NodeJS.ErrnoException & { killed?: boolean };
			err.killed = true;
			throw err;
		});
		await expect(
			runChafa("/bin/chafa", ["big.png"], { timeoutMs: 250 }, mockExec as never),
		).rejects.toThrow(/timed out after 250ms/);
		await expect(
			runChafa("/bin/chafa", ["big.png"], { timeoutMs: 250 }, mockExec as never),
		).rejects.toThrow(/cellWidth/);
	});
	it("rethrows a user abort distinctly (not as a timeout)", async () => {
		const mockExec = vi.fn(async () => {
			const err = new Error("The operation was aborted") as Error & { code?: string };
			err.name = "AbortError";
			err.code = "ABORT_ERR";
			throw err;
		});
		await expect(
			runChafa("/bin/chafa", ["big.png"], { timeoutMs: 250 }, mockExec as never),
		).rejects.toThrow("The operation was aborted");
		await expect(
			runChafa("/bin/chafa", ["big.png"], { timeoutMs: 250 }, mockExec as never),
		).rejects.not.toThrow(/timed out/);
	});
});
