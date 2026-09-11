import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	type ChafaConfig,
	type ChafaOverrides,
	COLOR_MODES,
	type ColorsMode,
	DITHER_MODES,
	type DitherMode,
	type EffectiveSymbolsSettings,
	type HostImageSettings,
	type ResolvedConfig,
} from "./types.js";

/** Built-in defaults — spec §6.1 table, verbatim. */
export const DEFAULT_CONFIG: ChafaConfig = {
	version: 1,
	preferNative: true,
	cellWidth: 60,
	maxRows: 50,
	colors: "240",
	symbolsSet: "block+border",
	dither: "none",
	formatOrder: ["symbols"],
	binaryPath: null,
	timeoutMs: 8000,
};

/** CHAFA_* env keys this module reads (spec §6.2) — exported for test cleanup. */
export const CHAFA_ENV_KEYS = [
	"CHAFA_BIN",
	"CHAFA_CELL_WIDTH",
	"CHAFA_MAX_ROWS",
	"CHAFA_COLORS",
	"CHAFA_SYMBOLS",
	"CHAFA_DITHER",
	"CHAFA_PREFER_NATIVE",
	"CHAFA_TIMEOUT_MS",
	"CHAFA_CONFIG_DIR",
] as const;

/** Where pi-chafa.json lives: CHAFA_CONFIG_DIR override, else ~/.pi/agent (spec §6.2). */
export function getConfigDir(): string {
	const override = process.env.CHAFA_CONFIG_DIR;
	if (override && override.trim() !== "") return override.trim();
	return join(homedir(), ".pi", "agent");
}

/**
 * pi's own agent dir (~/.pi/agent) — used for pi's settings.json. Ignores
 * CHAFA_CONFIG_DIR, whose override is scoped to pi-chafa.json only (spec §6.2).
 */
export function getHostAgentDir(): string {
	return join(homedir(), ".pi", "agent");
}

function isColorMode(value: unknown): value is ColorsMode {
	return (
		typeof value === "string" &&
		(COLOR_MODES as readonly string[]).includes(value)
	);
}

function isDitherMode(value: unknown): value is DitherMode {
	return (
		typeof value === "string" &&
		(DITHER_MODES as readonly string[]).includes(value)
	);
}

function positiveInt(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0
		? value
		: undefined;
}

/** Validate an unknown raw config object; unknown keys and invalid values are skipped silently (spec §6.1). */
export function validateConfig(raw: unknown): Partial<ChafaConfig> {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
	const record = raw as Record<string, unknown>;
	const out: Partial<ChafaConfig> = {};

	if (
		typeof record.version === "number" &&
		Number.isInteger(record.version) &&
		record.version > 0
	) {
		out.version = record.version;
	}
	if (typeof record.preferNative === "boolean")
		out.preferNative = record.preferNative;

	const cellWidth = positiveInt(record.cellWidth);
	if (cellWidth !== undefined) out.cellWidth = cellWidth;
	const maxRows = positiveInt(record.maxRows);
	if (maxRows !== undefined) out.maxRows = maxRows;
	const timeoutMs = positiveInt(record.timeoutMs);
	if (timeoutMs !== undefined) out.timeoutMs = timeoutMs;

	if (isColorMode(record.colors)) out.colors = record.colors;
	if (isDitherMode(record.dither)) out.dither = record.dither;
	if (
		typeof record.symbolsSet === "string" &&
		record.symbolsSet.trim() !== ""
	) {
		out.symbolsSet = record.symbolsSet.trim();
	}
	if (record.binaryPath === null) out.binaryPath = null;
	else if (
		typeof record.binaryPath === "string" &&
		record.binaryPath.trim() !== ""
	) {
		out.binaryPath = record.binaryPath.trim();
	}
	if (
		Array.isArray(record.formatOrder) &&
		record.formatOrder.every(
			(entry) => entry === "native" || entry === "symbols",
		)
	) {
		out.formatOrder = record.formatOrder;
	}
	return out;
}

/** Load + validate pi-chafa.json; missing/corrupt file falls back to defaults. Re-read per call (pi-pretty pattern). */
export function loadConfig(agentDir: string = getConfigDir()): ChafaConfig {
	const config: ChafaConfig = {
		...DEFAULT_CONFIG,
		formatOrder: [...DEFAULT_CONFIG.formatOrder],
	};
	if (!agentDir) return config;
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(join(agentDir, "pi-chafa.json"), "utf8"));
	} catch {
		return config;
	}
	const validated = validateConfig(raw);
	return { ...config, ...validated };
}

function envValue(name: string): string | undefined {
	const value = process.env[name];
	if (value === undefined || value.trim() === "") return undefined;
	return value.trim();
}

function envPositiveInt(name: string): number | undefined {
	const value = envValue(name);
	if (value === undefined) return undefined;
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function envBoolean(name: string): boolean | undefined {
	const value = envValue(name);
	if (value === undefined) return undefined;
	if (value === "1") return true;
	if (value === "0") return false;
	return undefined;
}

/** Apply CHAFA_* env over a file-loaded config: env > file (spec §6.2, §6.3). */
export function applyEnv(config: ChafaConfig): ChafaConfig {
	const bin = envValue("CHAFA_BIN");
	const cellWidth = envPositiveInt("CHAFA_CELL_WIDTH");
	const maxRows = envPositiveInt("CHAFA_MAX_ROWS");
	const timeoutMs = envPositiveInt("CHAFA_TIMEOUT_MS");
	const colors = envValue("CHAFA_COLORS");
	const symbolsSet = envValue("CHAFA_SYMBOLS");
	const dither = envValue("CHAFA_DITHER");
	const preferNative = envBoolean("CHAFA_PREFER_NATIVE");

	return {
		...config,
		binaryPath: bin ?? config.binaryPath,
		cellWidth: cellWidth ?? config.cellWidth,
		maxRows: maxRows ?? config.maxRows,
		timeoutMs: timeoutMs ?? config.timeoutMs,
		colors: isColorMode(colors) ? colors : config.colors,
		dither: isDitherMode(dither) ? dither : config.dither,
		symbolsSet: symbolsSet ?? config.symbolsSet,
		preferNative: preferNative ?? config.preferNative,
	};
}

/**
 * Full per-call resolution: defaults ← file ← CHAFA_* env ← tool params (spec §6.3).
 * Only the five §4.1.1 params may override here; they never persist.
 */
export function resolveConfig(
	overrides: ChafaOverrides = {},
	agentDir: string = getConfigDir(),
): ResolvedConfig {
	const fromFile = loadConfig(agentDir);
	const cfg = applyEnv(fromFile);
	// Per-call symbolsSet must trim to non-empty like the config-file rule
	// (validateConfig above); an empty/whitespace override would otherwise
	// reach chafa as `--symbols ""` (spec §4.1.1 / §6.3).
	const symbolsSet =
		typeof overrides.symbolsSet === "string" &&
		overrides.symbolsSet.trim() !== ""
			? overrides.symbolsSet.trim()
			: cfg.symbolsSet;
	const symbols: EffectiveSymbolsSettings = {
		cellWidth: overrides.cellWidth ?? cfg.cellWidth,
		maxRows: cfg.maxRows,
		colors: overrides.colors ?? cfg.colors,
		symbolsSet,
		dither: overrides.dither ?? cfg.dither,
		timeoutMs: cfg.timeoutMs,
		binaryPath: cfg.binaryPath,
	};
	return {
		preferNative: cfg.preferNative,
		formatOrder: cfg.formatOrder,
		symbols,
	};
}

/**
 * Read pi's own terminal image settings (never writes them — spec §6.4).
 * Only the user-level settings file is read; defaults match pi's docs
 * (terminal.showImages: true, terminal.imageWidthCells: 60).
 */
export function readHostImageSettings(
	agentDir: string = getHostAgentDir(),
): HostImageSettings {
	const result: HostImageSettings = {
		showImages: true,
		imageWidthCells: 60,
		images: null,
	};
	if (!agentDir) return result;
	try {
		const parsed = JSON.parse(
			readFileSync(join(agentDir, "settings.json"), "utf8"),
		) as Record<string, unknown>;
		const terminal = parsed?.terminal;
		if (typeof terminal === "object" && terminal !== null) {
			const t = terminal as Record<string, unknown>;
			if (typeof t.showImages === "boolean") result.showImages = t.showImages;
			const width = t.imageWidthCells;
			if (typeof width === "number" && Number.isInteger(width) && width > 0) {
				result.imageWidthCells = width;
			}
			// terminal.images vocabulary: "kitty" | "iterm2" | false | "auto"
			// (settings.md). Only an explicit supported protocol survives;
			// false / "auto" / absent / anything else means "no override".
			if (t.images === "kitty" || t.images === "iterm2") {
				result.images = t.images;
			}
		}
	} catch {
		// corrupt or missing settings.json → defaults
	}
	return result;
}

/** Persist a config to <agentDir>/pi-chafa.json (used by the /images command). */
export function writeConfigFile(agentDir: string, config: ChafaConfig): void {
	if (!agentDir)
		throw new Error(
			"no config directory available (set CHAFA_CONFIG_DIR or HOME)",
		);
	mkdirSync(agentDir, { recursive: true });
	// Atomic persistence (AGENTS.md architecture table): write a sibling temp
	// file, then rename it over the target so readers never observe a partial
	// write. renameSync is atomic within a filesystem (spec §2).
	const target = join(agentDir, "pi-chafa.json");
	const tmp = join(agentDir, "pi-chafa.json.tmp");
	writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
	renameSync(tmp, target);
}
