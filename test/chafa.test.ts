import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import {
	MIN_CHAFA_VERSION,
	buildSymbolsArgs,
	cleanSymbolsPayload,
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
