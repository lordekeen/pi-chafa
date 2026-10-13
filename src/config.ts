import {
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
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

/** Where pi-chafa.json lives: CHAFA_CONFIG_DIR override, else the host agent dir (§6.2, #040). */
export function getConfigDir(): string {
	const override = process.env.CHAFA_CONFIG_DIR;
	if (override && override.trim() !== "") return override.trim();
	return getAgentDir();
}

/**
 * pi's own agent dir — used for pi's settings.json. Follows the host accessor
 * so a relocated agent dir (PI_CODING_AGENT_DIR / CONFIG_DIR_NAME) is honored;
 * CHAFA_CONFIG_DIR stays scoped to pi-chafa.json only (#040, spec §6.2).
 */
export function getHostAgentDir(): string {
	return getAgentDir();
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

/**
 * Load + validate pi-chafa.json and report which keys were explicitly present
 * *and valid*. The key set is what lets `resolveConfig` tell "cellWidth absent"
 * (host `terminal.imageWidthCells` may supply the default) apart from
 * "cellWidth explicitly set to the value the default would also produce"
 * (#010). Missing/corrupt file → empty partial + empty key set.
 */
export function loadFileConfig(agentDir: string = getConfigDir()): {
	config: Partial<ChafaConfig>;
	keys: Set<string>;
} {
	if (!agentDir) return { config: {}, keys: new Set() };
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(join(agentDir, "pi-chafa.json"), "utf8"));
	} catch {
		return { config: {}, keys: new Set() };
	}
	const config = validateConfig(raw);
	return { config, keys: new Set(Object.keys(config)) };
}

/** Load + validate pi-chafa.json; missing/corrupt file falls back to defaults. Re-read per call (pi-pretty pattern). */
export function loadConfig(agentDir: string = getConfigDir()): ChafaConfig {
	const base: ChafaConfig = {
		...DEFAULT_CONFIG,
		formatOrder: [...DEFAULT_CONFIG.formatOrder],
	};
	return { ...base, ...loadFileConfig(agentDir).config };
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
	const value = envValue(name)?.toLowerCase();
	if (value === undefined) return undefined;
	// Extended vocabulary (#004, decision D6): 1/0 plus true/false/yes/no/on/off,
	// case-insensitive and trimmed. Anything else stays silently ignored so a
	// typo falls back to the file/default rather than flipping behavior.
	if (value === "1" || value === "true" || value === "yes" || value === "on") {
		return true;
	}
	if (value === "0" || value === "false" || value === "no" || value === "off") {
		return false;
	}
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
	// Injected for hermetic tests (spec §6.4): the default reads pi's real
	// ~/.pi/agent/settings.json, so unit tests must pass an explicit value.
	hostSettings: HostImageSettings = readHostImageSettings(),
): ResolvedConfig {
	const { config: fileConfig, keys } = loadFileConfig(agentDir);
	const fromFile: ChafaConfig = {
		...DEFAULT_CONFIG,
		formatOrder: [...DEFAULT_CONFIG.formatOrder],
		...fileConfig,
	};
	const cfg = applyEnv(fromFile);
	// cellWidth precedence (#010): per-call param → CHAFA_CELL_WIDTH → an
	// explicitly present pi-chafa.json value → host terminal.imageWidthCells →
	// built-in default. The host layer fills in only when the file never
	// mentioned cellWidth; env is detected separately because applyEnv has
	// already folded it into cfg.
	const envCellWidth = envPositiveInt("CHAFA_CELL_WIDTH");
	const fileCellWidth = keys.has("cellWidth") ? cfg.cellWidth : undefined;
	const cellWidth =
		overrides.cellWidth ??
		envCellWidth ??
		fileCellWidth ??
		positiveInt(hostSettings.imageWidthCells) ??
		DEFAULT_CONFIG.cellWidth;
	// Per-call symbolsSet must trim to non-empty like the config-file rule
	// (validateConfig above); an empty/whitespace override would otherwise
	// reach chafa as `--symbols ""` (spec §4.1.1 / §6.3).
	const symbolsSet =
		typeof overrides.symbolsSet === "string" &&
		overrides.symbolsSet.trim() !== ""
			? overrides.symbolsSet.trim()
			: cfg.symbolsSet;
	const symbols: EffectiveSymbolsSettings = {
		cellWidth,
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

/**
 * The write policy for `pi-chafa.json` (decision D25, #058): a save persists the
 * `version` plus exactly the keys the file already had — carrying the *file's*
 * own values, never the resolved ones — overridden by the keys this save changed.
 *
 * A full-config write is the defect this replaces: it makes every key
 * "explicitly present", and `resolveConfig` reads `loadFileConfig().keys` to
 * decide whether pi's own `terminal.imageWidthCells` may still supply
 * `cellWidth` (#010) — so one unrelated save silently overrode the host's
 * setting. Environment-derived values must never land in the file for the same
 * reason: they are not the file's own, and they are not what the user changed.
 *
 * `version` is metadata rather than a setting, so it is always written and the
 * file stays self-describing. `formatOrder` survives only if the file had it: it
 * is not user-settable, so a save must not introduce it.
 */
export function mergeForWrite(
	fileValues: Partial<ChafaConfig>,
	resolved: ChafaConfig,
	changedKeys: readonly (keyof ChafaConfig)[],
): Partial<ChafaConfig> {
	// Object.fromEntries keeps the per-key correlation that a plain loop over the
	// `keyof` union cannot express (each value is of exactly its own key's type).
	const picked = Object.fromEntries(
		changedKeys.map((key) => [key, resolved[key]]),
	) as Partial<ChafaConfig>;
	return { version: DEFAULT_CONFIG.version, ...fileValues, ...picked };
}

/**
 * Persist the given object to <agentDir>/pi-chafa.json (used by the /images
 * command). The shape is the caller's business — `mergeForWrite` decides what a
 * save contains — so this takes a partial: a sparse file, not a materialized
 * config, is the normal case (#058, D25).
 */
export function writeConfigFile(
	agentDir: string,
	config: Partial<ChafaConfig>,
): void {
	if (!agentDir)
		throw new Error(
			"no config directory available (set CHAFA_CONFIG_DIR or HOME)",
		);
	mkdirSync(agentDir, { recursive: true });
	// Atomic persistence (AGENTS.md architecture table): write a sibling temp
	// file, then rename it over the target so readers never observe a partial
	// write. renameSync is atomic within a filesystem (spec §2).
	// The temp name is unique per write (#009): a static name would let two
	// racing writers clobber each other's temp file mid-flight. The finally
	// block guarantees no `.tmp` residue survives a failed rename.
	const target = join(agentDir, "pi-chafa.json");
	const tmp = join(
		agentDir,
		`pi-chafa.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}.tmp`,
	);
	try {
		writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
		renameSync(tmp, target);
	} finally {
		rmSync(tmp, { force: true });
	}
}
