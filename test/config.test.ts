import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChafaConfig } from "../src/types.js";
import {
	CHAFA_ENV_KEYS,
	DEFAULT_CONFIG,
	applyEnv,
	getConfigDir,
	loadConfig,
	readHostImageSettings,
	resolveConfig,
	writeConfigFile,
} from "../src/config.js";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-chafa-config-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	for (const key of CHAFA_ENV_KEYS) delete process.env[key];
});

describe("loadConfig", () => {
	it("returns defaults when the file is missing", () => {
		expect(loadConfig(dir)).toEqual(DEFAULT_CONFIG);
	});
	it("applies file values over defaults", () => {
		writeFileSync(
			join(dir, "pi-chafa.json"),
			JSON.stringify({ cellWidth: 90, colors: "16", preferNative: false }),
		);
		const cfg = loadConfig(dir);
		expect(cfg.cellWidth).toBe(90);
		expect(cfg.colors).toBe("16");
		expect(cfg.preferNative).toBe(false);
		expect(cfg.maxRows).toBe(DEFAULT_CONFIG.maxRows);
	});
	it("skips unknown keys and invalid values silently", () => {
		writeFileSync(
			join(dir, "pi-chafa.json"),
			JSON.stringify({
				cellWidth: -5,
				maxRows: "lots",
				colors: "999",
				dither: 3,
				symbolsSet: 42,
				preferNative: "yes",
				timeoutMs: 0,
				binaryPath: "/usr/bin/chafa",
				madeUpKey: true,
			}),
		);
		const cfg = loadConfig(dir);
		expect(cfg).toEqual({ ...DEFAULT_CONFIG, binaryPath: "/usr/bin/chafa" });
	});
	it("ignores a corrupt file", () => {
		writeFileSync(join(dir, "pi-chafa.json"), "{ not json");
		expect(loadConfig(dir)).toEqual(DEFAULT_CONFIG);
	});
});

describe("applyEnv (env > file > defaults)", () => {
	it("overrides config fields from CHAFA_* env", () => {
		writeFileSync(join(dir, "pi-chafa.json"), JSON.stringify({ cellWidth: 90, colors: "16" }));
		process.env.CHAFA_CELL_WIDTH = "120";
		process.env.CHAFA_COLORS = "full";
		process.env.CHAFA_PREFER_NATIVE = "0";
		process.env.CHAFA_SYMBOLS = "block";
		process.env.CHAFA_MAX_ROWS = "33";
		process.env.CHAFA_TIMEOUT_MS = "4000";
		process.env.CHAFA_BIN = "/opt/chafa";
		process.env.CHAFA_DITHER = "ordered";
		const cfg = applyEnv(loadConfig(dir));
		expect(cfg.cellWidth).toBe(120);
		expect(cfg.colors).toBe("full");
		expect(cfg.preferNative).toBe(false);
		expect(cfg.symbolsSet).toBe("block");
		expect(cfg.maxRows).toBe(33);
		expect(cfg.timeoutMs).toBe(4000);
		expect(cfg.binaryPath).toBe("/opt/chafa");
		expect(cfg.dither).toBe("ordered");
	});
	it("ignores unset and invalid env values", () => {
		writeFileSync(join(dir, "pi-chafa.json"), JSON.stringify({ cellWidth: 90 }));
		process.env.CHAFA_CELL_WIDTH = "abc";
		process.env.CHAFA_COLORS = "neon";
		process.env.CHAFA_PREFER_NATIVE = "2";
		const cfg = applyEnv(loadConfig(dir));
		expect(cfg.cellWidth).toBe(90);
		expect(cfg.colors).toBe(DEFAULT_CONFIG.colors);
		expect(cfg.preferNative).toBe(true);
	});
});

describe("resolveConfig precedence", () => {
	it("lays per-call overrides above env above file above defaults", () => {
		writeFileSync(join(dir, "pi-chafa.json"), JSON.stringify({ cellWidth: 40, colors: "8" }));
		process.env.CHAFA_CELL_WIDTH = "80";
		const resolved = resolveConfig({ cellWidth: 100, colors: "full" }, dir);
		expect(resolved.symbols.cellWidth).toBe(100);
		expect(resolved.symbols.colors).toBe("full");
		expect(resolved.preferNative).toBe(true);
		expect(resolved.symbols.maxRows).toBe(DEFAULT_CONFIG.maxRows);
		expect(resolved.symbols.timeoutMs).toBe(DEFAULT_CONFIG.timeoutMs);
	});
});

describe("getConfigDir", () => {
	it("honors CHAFA_CONFIG_DIR", () => {
		process.env.CHAFA_CONFIG_DIR = dir;
		expect(getConfigDir()).toBe(dir);
	});
});

describe("readHostImageSettings", () => {
	it("defaults to showImages true and width 60 when settings.json is absent", () => {
		expect(readHostImageSettings(dir)).toEqual({ showImages: true, imageWidthCells: 60 });
	});
	it("reads terminal.showImages and terminal.imageWidthCells from pi settings.json", () => {
		writeFileSync(
			join(dir, "settings.json"),
			JSON.stringify({ terminal: { showImages: false, imageWidthCells: 90 } }),
		);
		expect(readHostImageSettings(dir)).toEqual({ showImages: false, imageWidthCells: 90 });
	});
	it("ignores a corrupt settings.json", () => {
		writeFileSync(join(dir, "settings.json"), "nope");
		expect(readHostImageSettings(dir)).toEqual({ showImages: true, imageWidthCells: 60 });
	});
});

describe("writeConfigFile", () => {
	it("round-trips a config through the file", () => {
		const next: ChafaConfig = { ...DEFAULT_CONFIG, cellWidth: 72, preferNative: false };
		writeConfigFile(dir, next);
		expect(loadConfig(dir)).toEqual(next);
	});
});
