import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChafaConfig, HostImageSettings } from "../src/types.js";
import {
	CHAFA_ENV_KEYS,
	DEFAULT_CONFIG,
	applyEnv,
	getConfigDir,
	getHostAgentDir,
	loadConfig,
	mergeForWrite,
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
	delete process.env.PI_CODING_AGENT_DIR;
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
	it("accepts the extended boolean vocabulary case-insensitively and trimmed (#004)", () => {
		writeFileSync(join(dir, "pi-chafa.json"), JSON.stringify({ preferNative: false }));
		for (const value of ["1", "true", "TRUE", " True ", "yes", "YES", "on", "On"]) {
			process.env.CHAFA_PREFER_NATIVE = value;
			expect(applyEnv(loadConfig(dir)).preferNative).toBe(true);
		}
		writeFileSync(join(dir, "pi-chafa.json"), JSON.stringify({ preferNative: true }));
		for (const value of ["0", "false", "FALSE", " False ", "no", "NO", "off", "Off"]) {
			process.env.CHAFA_PREFER_NATIVE = value;
			expect(applyEnv(loadConfig(dir)).preferNative).toBe(false);
		}
	});
	it("ignores unrecognized or empty boolean values and falls back to the file (#004)", () => {
		writeFileSync(join(dir, "pi-chafa.json"), JSON.stringify({ preferNative: false }));
		for (const value of ["maybe", "2", "", "   "]) {
			process.env.CHAFA_PREFER_NATIVE = value;
			expect(applyEnv(loadConfig(dir)).preferNative).toBe(false);
		}
	});
});

describe("resolveConfig precedence", () => {
	// Hermetic host settings (spec §6.4): tests must never read the developer's
	// real ~/.pi/agent/settings.json, so every resolveConfig call injects one.
	const HOST_60: HostImageSettings = { showImages: true, imageWidthCells: 60, images: null };
	it("lays per-call overrides above env above file above defaults", () => {
		writeFileSync(join(dir, "pi-chafa.json"), JSON.stringify({ cellWidth: 40, colors: "8" }));
		process.env.CHAFA_CELL_WIDTH = "80";
		const resolved = resolveConfig({ cellWidth: 100, colors: "full" }, dir, HOST_60);
		expect(resolved.symbols.cellWidth).toBe(100);
		expect(resolved.symbols.colors).toBe("full");
		expect(resolved.preferNative).toBe(true);
		expect(resolved.symbols.maxRows).toBe(DEFAULT_CONFIG.maxRows);
		expect(resolved.symbols.timeoutMs).toBe(DEFAULT_CONFIG.timeoutMs);
	});
	it("falls back to config when a per-call symbolsSet is blank or whitespace (spec §4.1.1/§6.3)", () => {
		expect(resolveConfig({ symbolsSet: "" }, dir, HOST_60).symbols.symbolsSet).toBe(
			DEFAULT_CONFIG.symbolsSet,
		);
		expect(resolveConfig({ symbolsSet: "   " }, dir, HOST_60).symbols.symbolsSet).toBe(
			DEFAULT_CONFIG.symbolsSet,
		);
	});
	it("uses the trimmed per-call symbolsSet override", () => {
		expect(resolveConfig({ symbolsSet: "  block  " }, dir, HOST_60).symbols.symbolsSet).toBe("block");
	});
});

describe("resolveConfig host cellWidth layer (#010)", () => {
	const host = (imageWidthCells: number): HostImageSettings => ({
		showImages: true,
		imageWidthCells,
		images: null,
	});
	it("uses the host terminal.imageWidthCells when file and env are silent", () => {
		expect(resolveConfig({}, dir, host(80)).symbols.cellWidth).toBe(80);
	});
	it("prefers an explicit file cellWidth over the host width (provenance case)", () => {
		writeFileSync(join(dir, "pi-chafa.json"), JSON.stringify({ cellWidth: 60 }));
		expect(resolveConfig({}, dir, host(80)).symbols.cellWidth).toBe(60);
	});
	it("prefers CHAFA_CELL_WIDTH over both the file and the host width", () => {
		writeFileSync(join(dir, "pi-chafa.json"), JSON.stringify({ cellWidth: 60 }));
		process.env.CHAFA_CELL_WIDTH = "40";
		expect(resolveConfig({}, dir, host(80)).symbols.cellWidth).toBe(40);
	});
	it("prefers a per-call cellWidth over everything", () => {
		writeFileSync(join(dir, "pi-chafa.json"), JSON.stringify({ cellWidth: 60 }));
		process.env.CHAFA_CELL_WIDTH = "40";
		expect(resolveConfig({ cellWidth: 30 }, dir, host(80)).symbols.cellWidth).toBe(30);
	});
	it("falls back to the built-in default when the host width is not usable", () => {
		expect(resolveConfig({}, dir, host(0)).symbols.cellWidth).toBe(DEFAULT_CONFIG.cellWidth);
	});
	it("does not treat an invalid file cellWidth as explicit", () => {
		writeFileSync(join(dir, "pi-chafa.json"), JSON.stringify({ cellWidth: -5 }));
		expect(resolveConfig({}, dir, host(80)).symbols.cellWidth).toBe(80);
	});
});

describe("getConfigDir", () => {
	it("honors CHAFA_CONFIG_DIR", () => {
		process.env.CHAFA_CONFIG_DIR = dir;
		expect(getConfigDir()).toBe(dir);
	});
	it("follows the host agent dir via getAgentDir() (#040)", () => {
		process.env.PI_CODING_AGENT_DIR = dir;
		expect(getConfigDir()).toBe(dir);
		expect(getHostAgentDir()).toBe(dir);
	});
	it("keeps CHAFA_CONFIG_DIR scoped to the pi-chafa file only (#040)", () => {
		process.env.PI_CODING_AGENT_DIR = dir;
		const override = join(dir, "override");
		process.env.CHAFA_CONFIG_DIR = override;
		expect(getConfigDir()).toBe(override);
		expect(getHostAgentDir()).toBe(dir);
	});
	it("readHostImageSettings' default agentDir follows the host dir (#040)", () => {
		process.env.PI_CODING_AGENT_DIR = dir;
		writeFileSync(
			join(dir, "settings.json"),
			JSON.stringify({ terminal: { showImages: false } }),
		);
		expect(readHostImageSettings().showImages).toBe(false);
	});
});

describe("readHostImageSettings", () => {
	it("defaults to showImages true, width 60, and no protocol override when settings.json is absent", () => {
		expect(readHostImageSettings(dir)).toEqual({
			showImages: true,
			imageWidthCells: 60,
			images: null,
		});
	});
	it("reads terminal.showImages and terminal.imageWidthCells from pi settings.json", () => {
		writeFileSync(
			join(dir, "settings.json"),
			JSON.stringify({ terminal: { showImages: false, imageWidthCells: 90 } }),
		);
		expect(readHostImageSettings(dir)).toEqual({
			showImages: false,
			imageWidthCells: 90,
			images: null,
		});
	});
	it("maps terminal.images to the protocol field; false/auto/unknown -> null", () => {
		const write = (images: unknown) =>
			writeFileSync(join(dir, "settings.json"), JSON.stringify({ terminal: { images } }));
		write("kitty");
		expect(readHostImageSettings(dir).images).toBe("kitty");
		write("iterm2");
		expect(readHostImageSettings(dir).images).toBe("iterm2");
		write(false);
		expect(readHostImageSettings(dir).images).toBe(null);
		write("auto");
		expect(readHostImageSettings(dir).images).toBe(null);
		write("wezterm");
		expect(readHostImageSettings(dir).images).toBe(null);
	});
	it("ignores a corrupt settings.json", () => {
		writeFileSync(join(dir, "settings.json"), "nope");
		expect(readHostImageSettings(dir)).toEqual({
			showImages: true,
			imageWidthCells: 60,
			images: null,
		});
	});
	it("reads pi's settings from HOME, not CHAFA_CONFIG_DIR (spec §6.2)", () => {
		const home = mkdtempSync(join(tmpdir(), "pi-chafa-home-"));
		const prevHome = process.env.HOME;
		try {
			mkdirSync(join(home, ".pi", "agent"), { recursive: true });
			writeFileSync(
				join(home, ".pi", "agent", "settings.json"),
				JSON.stringify({ terminal: { showImages: false, imageWidthCells: 42 } }),
			);
			// CHAFA_CONFIG_DIR's settings.json conflicts on purpose: it must be ignored.
			writeFileSync(
				join(dir, "settings.json"),
				JSON.stringify({ terminal: { showImages: true, imageWidthCells: 99 } }),
			);
			process.env.CHAFA_CONFIG_DIR = dir;
			process.env.HOME = home;
			expect(getHostAgentDir()).toBe(join(home, ".pi", "agent"));
			expect(readHostImageSettings()).toEqual({
				showImages: false,
				imageWidthCells: 42,
				images: null,
			});
		} finally {
			if (prevHome === undefined) delete process.env.HOME;
			else process.env.HOME = prevHome;
			rmSync(home, { recursive: true, force: true });
		}
	});
});

describe("writeConfigFile", () => {
	it("round-trips a config through the file", () => {
		const next: ChafaConfig = { ...DEFAULT_CONFIG, cellWidth: 72, preferNative: false };
		writeConfigFile(dir, next);
		expect(loadConfig(dir)).toEqual(next);
	});
	it("lands the last write and leaves no .tmp residue across sequential writes (#009)", () => {
		writeConfigFile(dir, { ...DEFAULT_CONFIG, cellWidth: 61 });
		writeConfigFile(dir, { ...DEFAULT_CONFIG, cellWidth: 62 });
		expect(loadConfig(dir).cellWidth).toBe(62);
		expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});
	it("removes the temp file when the rename fails (#009)", () => {
		// A directory at the target path makes renameSync fail after the temp file
		// was written, which exercises the cleanup path without mocking node:fs.
		mkdirSync(join(dir, "pi-chafa.json"));
		expect(() => writeConfigFile(dir, DEFAULT_CONFIG)).toThrow();
		expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});
});

describe("mergeForWrite (#058, D25)", () => {
	const resolved = (over: Partial<ChafaConfig> = {}): ChafaConfig => ({
		...DEFAULT_CONFIG,
		...over,
	});

	it("writes the version plus only the keys the save changed", () => {
		// The trap this policy exists for: `resolved` carries a cellWidth (from the
		// host's terminal.imageWidthCells), and writing it would make the key
		// explicitly present — which is exactly what resolveConfig reads to decide
		// whether pi's own setting may still supply it (#010).
		expect(mergeForWrite({}, resolved({ colors: "8" }), ["colors"])).toStrictEqual({
			version: DEFAULT_CONFIG.version,
			colors: "8",
		});
	});

	it("keeps the file's own values for keys the save did not touch", () => {
		const file: Partial<ChafaConfig> = { colors: "16", symbolsSet: "ascii" };
		const written = mergeForWrite(file, resolved({ colors: "8", cellWidth: 72 }), [
			"cellWidth",
		]);
		expect(written).toStrictEqual({
			version: DEFAULT_CONFIG.version,
			colors: "16",
			symbolsSet: "ascii",
			cellWidth: 72,
		});
	});

	it("never persists an env-resolved value for an untouched key", () => {
		// CHAFA_COLORS=8 in the environment: the resolved config says 8 while the file
		// says 16, and only a touched key may take the resolved value.
		const file: Partial<ChafaConfig> = { colors: "16" };
		const written = mergeForWrite(file, resolved({ colors: "8" }), ["maxRows"]);
		expect(written.colors).toBe("16");
		expect(written.maxRows).toBe(DEFAULT_CONFIG.maxRows);
	});

	it("lets a changed key override the file's old value", () => {
		const file: Partial<ChafaConfig> = { colors: "16" };
		const written = mergeForWrite(file, resolved({ colors: "full" }), ["colors"]);
		expect(written.colors).toBe("full");
	});

	it("writes a cleared binaryPath as null rather than dropping the key", () => {
		const file: Partial<ChafaConfig> = { binaryPath: "/opt/chafa" };
		const written = mergeForWrite(file, resolved({ binaryPath: null }), [
			"binaryPath",
		]);
		expect(written).toStrictEqual({
			version: DEFAULT_CONFIG.version,
			binaryPath: null,
		});
	});

	it("preserves formatOrder only when the file already had it", () => {
		const withOrder = mergeForWrite(
			{ formatOrder: ["native", "symbols"] },
			resolved(),
			[],
		);
		expect(withOrder.formatOrder).toStrictEqual(["native", "symbols"]);
		// Absent stays absent: it is not user-settable, so a save must not introduce it.
		expect(mergeForWrite({}, resolved(), ["colors"])).not.toHaveProperty(
			"formatOrder",
		);
	});

	it("does not mutate either input", () => {
		const file: Partial<ChafaConfig> = { colors: "16" };
		const current = resolved({ colors: "8" });
		const fileBefore = structuredClone(file);
		const resolvedBefore = structuredClone(current);
		mergeForWrite(file, current, ["colors", "cellWidth"]);
		expect(file).toStrictEqual(fileBefore);
		expect(current).toStrictEqual(resolvedBefore);
	});
});
