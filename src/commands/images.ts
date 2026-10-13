import {
	DynamicBorder,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionUIContext,
	getSettingsListTheme,
	keyText,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	getCapabilities,
	Key,
	type KeybindingsManager,
	matchesKey,
	type SettingItem,
	SettingsList,
	type SettingsListTheme,
	Spacer,
	Text,
} from "@earendil-works/pi-tui";
import { createCachedProbe } from "../chafa.js";
import {
	getConfigDir,
	loadConfig,
	loadFileConfig,
	mergeForWrite,
	readHostImageSettings,
	writeConfigFile,
} from "../config.js";
import { type ImageEnv, isTmux, resolveCapsImages } from "../detect.js";
import { hasControlChars, stripControls } from "../sanitize.js";
import {
	type AgentCapsImages,
	type ChafaConfig,
	type ChafaProbe,
	COLOR_MODES,
	type ColorsMode,
	DITHER_MODES,
	type DitherMode,
	type HostImageSettings,
} from "../types.js";

/** Preset ladders shared by the SettingsList item builder and the fallback flow. */
const WIDTH_PRESETS: string[] = ["40", "50", "60", "80", "100", "120"];
const ROW_PRESETS: string[] = ["25", "35", "50", "75", "100"];
const SYMBOL_PRESETS: string[] = [
	"block+border",
	"block",
	"border",
	"ascii",
	"braille",
	"all",
];
const TIMEOUT_PRESETS: string[] = [
	"2000",
	"4000",
	"8000",
	"15000",
	"30000",
	"60000",
];

export const SETTING_DESCRIPTIONS = {
	preferNative:
		"Prefer native Kitty/iTerm2 protocols when supported; false forces Chafa symbols art.",
	colors:
		"Chafa color mode: full (24-bit truecolor), 256, 240, 16, 8, 2, or none.",
	dither: "Chafa dithering algorithm: none, ordered, diffusion, or noise.",
	symbolsSet:
		"Chafa symbol classes: block+border, block, border, ascii, braille, or all.",
	cellWidth:
		"Width in terminal columns (default 60). Enter/Space cycles · Press 'e' to edit custom width.",
	maxRows:
		"Row height limit cap (default 50). Enter/Space cycles · Press 'e' to edit custom max rows.",
	timeoutMs:
		"Per-invocation chafa wall-clock limit in ms (default 8000). Enter/Space cycles · Press 'e' to edit custom timeout.",
	binaryPath:
		"Chafa binary executable. Enter/Space toggles auto/path · Press 'e' to edit custom path.",
	runtimeStatus:
		"Inspect detected image protocols, host showImages setting, and chafa version.",
	// The RPC/`select` fallback appends a close entry built from this description
	// (a dialog option, not the synthetic row the panel used to carry — #054 removed
	// that one and #059 gave the fallback its own entry back).
	done: "Close the settings panel",
} as const;

/** Which source supplied the effective image capability (spec §6.4 ladder). */
export type CapsImagesSource =
	| "getCapabilities()"
	| "terminal.images"
	| "PI_IMAGE_PROTOCOL"
	| "none";

export interface RuntimeCaps {
	capsImages: AgentCapsImages;
	capsSource: CapsImagesSource;
}

export interface RuntimeFacts {
	capsImages: AgentCapsImages;
	capsSource: CapsImagesSource;
	showImages: boolean;
	prettyRead: boolean;
	chafa:
		| { present: true; binary: string; version: string }
		| { present: false; error: string };
}

/**
 * Resolve the effective native-image capability with the same exported ladder
 * show_image uses (§6.4: #026 environment guard → getCapabilities() → host
 * terminal.images → PI_IMAGE_PROTOCOL), plus the provenance of whichever
 * source won. The panel is diagnostic: the raw caps singleton can read `null`
 * while native delivery still works via a host setting or the env var.
 */
export function resolveRuntimeCaps(
	hostCaps: AgentCapsImages,
	hostImages: AgentCapsImages,
	envProtocol: string | undefined,
	env: ImageEnv = {},
	platform: string = "",
): RuntimeCaps {
	const capsImages = resolveCapsImages(
		hostCaps,
		hostImages,
		envProtocol,
		env,
		platform,
	);
	if (capsImages === null) return { capsImages: null, capsSource: "none" };
	// Under tmux the ladder ignores caps/settings (#026), so a non-null value can
	// only have come from the explicit PI_IMAGE_PROTOCOL opt-in.
	if (isTmux(env)) return { capsImages, capsSource: "PI_IMAGE_PROTOCOL" };
	if (hostCaps !== null) return { capsImages, capsSource: "getCapabilities()" };
	if (resolveCapsImages(null, hostImages, undefined, env, platform) !== null)
		return { capsImages, capsSource: "terminal.images" };
	return { capsImages, capsSource: "PI_IMAGE_PROTOCOL" };
}

/**
 * pi-pretty detection is informational only (spec §4.4): a non-"builtin" read
 * source means a pretty reader overrides the built-in read tool (spec §3.5 —
 * the real 0.84.4 field is sourceInfo.source, not a top-level source).
 */
export function collectRuntimeFacts(
	pi: Pick<ExtensionAPI, "getAllTools">,
	caps: RuntimeCaps,
	showImages: boolean,
	chafa: RuntimeFacts["chafa"],
): RuntimeFacts {
	const readTool = pi.getAllTools().find((tool) => tool.name === "read");
	const prettyRead =
		readTool !== undefined && readTool.sourceInfo.source !== "builtin";
	return { ...caps, showImages, prettyRead, chafa };
}

/** Pure status lines for the /images informational section (spec §4.2). */
export function describeRuntime(facts: RuntimeFacts): string[] {
	const protocol = facts.capsImages ?? "none";
	const source =
		facts.capsSource === "none" ? "" : ` (source: ${facts.capsSource})`;
	const show = facts.showImages ? "on" : "off";
	const pretty = facts.prettyRead ? "detected" : "not detected";
	const chafa = facts.chafa.present
		? `${facts.chafa.version} (${facts.chafa.binary})`
		: `NOT FOUND — ${facts.chafa.error}`;
	return [
		`Detected image protocol: ${protocol}${source}`,
		`Host showImages: ${show}`,
		`pi-pretty-style read override: ${pretty}`,
		`chafa: ${chafa}`,
	];
}

function parsePositiveInt(value: string): number | undefined {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** The command's one-line usage — the remedy every refusal has to name. */
export const IMAGES_USAGE = "usage: /images [status | <key> <value>]";

/**
 * Levenshtein distance, abandoned once it passes `max`: the only caller compares
 * against a six-character token, so there is no reason to finish the matrix.
 */
function editDistanceAtMost(a: string, b: string, max: number): number {
	if (Math.abs(a.length - b.length) > max) return max + 1;
	let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		const curr: number[] = [i];
		let best = i;
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			const value = Math.min(
				(prev[j] ?? 0) + 1,
				(curr[j - 1] ?? 0) + 1,
				(prev[j - 1] ?? 0) + cost,
			);
			curr[j] = value;
			if (value < best) best = value;
		}
		if (best > max) return max + 1;
		prev = curr;
	}
	return prev[b.length] ?? max + 1;
}

/**
 * The near-miss correction for an unknown `/images` argument (#055): a typo, a
 * prefix, or the accepted token followed by extra text. Returns the accepted
 * token, or undefined when the argument is simply something else — a refusal
 * must not invent a correction, and a two-character prefix is too little to go on.
 */
export function nearMiss(rawArg: string, known = "status"): string | undefined {
	const arg = rawArg.trim().toLowerCase();
	if (!arg || arg === known) return undefined;
	if (arg.startsWith(known)) return known;
	if (known.startsWith(arg) && arg.length >= 3) return known;
	return editDistanceAtMost(arg, known, 2) <= 2 ? known : undefined;
}

/**
 * The runtime facts as a host `SettingsList` submenu (#049).
 *
 * While a submenu is open the host list routes **every** key to it and renders it
 * in place of the rows (`settings-list.js:50-53, 160-164`), so it has to close
 * itself — a submenu without `handleInput` is a dead end. Cancel (remap-safe),
 * Enter/Space and `q` close it; closing with no value leaves the row's value and
 * the list's selection untouched.
 */
export function runtimeStatusSubmenu(
	lines: string[],
	kb: KeybindingsManager,
	close: () => void,
): Component {
	const body = new Text(lines.join("\n"), 1, 1);
	return {
		render: (width: number) => body.render(width),
		invalidate: () => body.invalidate(),
		handleInput: (data: string) => {
			if (
				kb.matches(data, "tui.select.cancel") ||
				kb.matches(data, "tui.select.confirm") ||
				matchesKey(data, Key.enter) ||
				matchesKey(data, "space") ||
				matchesKey(data, "q")
			) {
				close();
			}
		},
	};
}

/**
 * Build SettingItem rows for SettingsList (spec §4.2) with inline cycling values
 * and rich contextual descriptions. `runtimeSubmenu` wires the runtime-facts
 * submenu onto the status row (#049); the RPC fallback omits it and keeps its own
 * select-based status flow.
 */
export function buildSettingItems(
	config: ChafaConfig,
	detectedBinary?: string,
	runtimeSubmenu?: SettingItem["submenu"],
): SettingItem[] {
	const currentWidthStr = String(config.cellWidth);
	const widthValues = WIDTH_PRESETS.includes(currentWidthStr)
		? [...WIDTH_PRESETS]
		: [currentWidthStr, ...WIDTH_PRESETS];

	const currentRowStr = String(config.maxRows);
	const rowValues = ROW_PRESETS.includes(currentRowStr)
		? [...ROW_PRESETS]
		: [currentRowStr, ...ROW_PRESETS];

	const currentTimeoutStr = String(config.timeoutMs);
	const timeoutValues = TIMEOUT_PRESETS.includes(currentTimeoutStr)
		? [...TIMEOUT_PRESETS]
		: [currentTimeoutStr, ...TIMEOUT_PRESETS];

	const currentSymbols = stripControls(config.symbolsSet);
	const currentBinary = config.binaryPath
		? stripControls(config.binaryPath)
		: null;

	// The two free-text fields carry whatever the file holds, and a hand-edited
	// pi-chafa.json can hold control bytes (#060): the funnel refuses new ones, but
	// these are rendered into a row's Text and offered for cycling, so they are
	// sanitized at this boundary (invariant 3).
	const symbolValues = SYMBOL_PRESETS.includes(currentSymbols)
		? [...SYMBOL_PRESETS]
		: [currentSymbols, ...SYMBOL_PRESETS];

	const binaryValues: string[] = ["(auto on PATH)"];
	if (detectedBinary && detectedBinary !== "(auto on PATH)") {
		binaryValues.push(detectedBinary);
	}
	if (
		currentBinary &&
		currentBinary !== detectedBinary &&
		currentBinary !== "(auto on PATH)"
	) {
		binaryValues.push(currentBinary);
	}

	return [
		{
			id: "preferNative",
			label: "Prefer native",
			description: SETTING_DESCRIPTIONS.preferNative,
			currentValue: config.preferNative ? "true" : "false",
			values: ["true", "false"],
		},
		{
			id: "colors",
			label: "Color mode",
			description: SETTING_DESCRIPTIONS.colors,
			currentValue: config.colors,
			values: [...COLOR_MODES],
		},
		{
			id: "dither",
			label: "Dither mode",
			description: SETTING_DESCRIPTIONS.dither,
			currentValue: config.dither,
			values: [...DITHER_MODES],
		},
		{
			id: "symbolsSet",
			label: "Symbols set",
			description: SETTING_DESCRIPTIONS.symbolsSet,
			currentValue: currentSymbols,
			values: symbolValues,
		},
		{
			id: "cellWidth",
			label: "Cell width",
			description: SETTING_DESCRIPTIONS.cellWidth,
			currentValue: currentWidthStr,
			values: widthValues,
		},
		{
			id: "maxRows",
			label: "Max rows",
			description: SETTING_DESCRIPTIONS.maxRows,
			currentValue: currentRowStr,
			values: rowValues,
		},
		{
			id: "timeoutMs",
			label: "Timeout (ms)",
			description: SETTING_DESCRIPTIONS.timeoutMs,
			currentValue: currentTimeoutStr,
			values: timeoutValues,
		},
		{
			id: "binaryPath",
			label: "Binary path",
			description: SETTING_DESCRIPTIONS.binaryPath,
			currentValue: currentBinary ?? "(auto on PATH)",
			values: binaryValues,
		},
		{
			id: "runtimeStatus",
			label: "Runtime status",
			description: SETTING_DESCRIPTIONS.runtimeStatus,
			currentValue: "view",
			// Opens as a host submenu; without one (the fallback flow) the row is inert.
			...(runtimeSubmenu ? { submenu: runtimeSubmenu } : {}),
		},
	];
}

/**
 * The panel's row theme is the host's own `getSettingsListTheme()`, so its rows
 * match pi's `/settings` panel instead of a local look-alike (#051).
 *
 * The host publishes its theme through a proxy that throws until `initTheme()`
 * has run ("Theme not initialized. Call initTheme() first."), and a mounted panel
 * must never take the session down with it: an uninitialised theme degrades to
 * unstyled text — never to a hardcoded colour.
 */
const UNSTYLED_SETTINGS_THEME: SettingsListTheme = {
	label: (text) => text,
	value: (text) => text,
	description: (text) => text,
	cursor: "→ ",
	hint: (text) => text,
};

function hostSettingsListTheme(): SettingsListTheme {
	try {
		return getSettingsListTheme();
	} catch {
		return UNSTYLED_SETTINGS_THEME;
	}
}

/**
 * Refusal copy for a value carrying control characters. One home for the
 * sentence, because three paths report it: the CLI's `parseSettingArg` reason
 * and the two dialog paths' warnings (#060).
 */
export function controlCharReason(key: string): string {
	return `invalid ${key} (control characters are not allowed)`;
}

/**
 * Apply one wizard choice to the in-memory config. Returns null when the
 * choice is unknown or the value is invalid (the caller re-prompts).
 *
 * A value carrying control characters is refused here — in the funnel every
 * input path already shares — rather than stripped, and rather than only in
 * `parseSettingArg` (#060): the value is persisted and later re-rendered in the
 * panel's rows, so a stripped path is a different path than the user typed
 * (invariant 3). The check is on the value as typed, not post-`trim()`, so the
 * dialog paths and the CLI agree byte for byte.
 */
export function applyMenuChange(
	current: ChafaConfig,
	choice: string,
	value: string,
): ChafaConfig | null {
	if (hasControlChars(value)) return null;
	switch (choice) {
		case "cellWidth": {
			const parsed = parsePositiveInt(value.trim());
			return parsed === undefined ? null : { ...current, cellWidth: parsed };
		}
		case "colors": {
			const trimmed = value.trim() as ColorsMode;
			if (!(COLOR_MODES as readonly string[]).includes(trimmed)) return null;
			return { ...current, colors: trimmed };
		}
		case "symbolsSet": {
			const trimmed = value.trim();
			return trimmed === "" ? null : { ...current, symbolsSet: trimmed };
		}
		case "dither": {
			const trimmed = value.trim() as DitherMode;
			if (!(DITHER_MODES as readonly string[]).includes(trimmed)) return null;
			return { ...current, dither: trimmed };
		}
		case "maxRows": {
			const parsed = parsePositiveInt(value.trim());
			return parsed === undefined ? null : { ...current, maxRows: parsed };
		}
		case "timeoutMs": {
			const parsed = parsePositiveInt(value.trim());
			return parsed === undefined ? null : { ...current, timeoutMs: parsed };
		}
		case "preferNative": {
			const trimmed = value.trim().toLowerCase();
			if (trimmed === "true") return { ...current, preferNative: true };
			if (trimmed === "false") return { ...current, preferNative: false };
			if (trimmed === "")
				return { ...current, preferNative: !current.preferNative };
			return null;
		}
		case "binaryPath": {
			const trimmed = value.trim();
			return {
				...current,
				binaryPath:
					trimmed === "" || trimmed === "(auto on PATH)" ? null : trimmed,
			};
		}
		default:
			return null;
	}
}

// Module-level success-only cache (#007): an /images panel opened repeatedly
// reuses the first successful probe instead of respawning `chafa --version`.
// Kept separate from the tool's per-instance cache so a panel probe can never
// be poisoned by a transient tool-side failure path (rejections are not cached).
const cachedProbe = createCachedProbe();

/**
 * Injected side effects for `/images` (AGENTS.md "TDD & Injected Dependencies").
 * Production wires the real probe cache, the real host settings read, and the
 * real terminal capability singleton; tests inject fakes so the hermetic unit
 * suite never spawns chafa or reads the developer's real `settings.json` (#019).
 */
export interface ImagesCommandDeps {
	/** Success-only chafa probe cache, shared with the panel's status output. */
	probeChafa: (binaryPath: string | null) => Promise<ChafaProbe>;
	/** Host `settings.json` read (spec §6.4). */
	readHostImageSettings: (agentDir: string) => HostImageSettings;
	/** Terminal image capability singleton (`getCapabilities().images`). */
	capsImages: () => AgentCapsImages;
	/** Atomic pi-chafa.json write — injectable for write-count assertions (#045). */
	writeConfigFile: (agentDir: string, config: Partial<ChafaConfig>) => void;
	/** Row theme for the panel's `SettingsList` — the host's own by default (#051). */
	settingsListTheme: () => SettingsListTheme;
}

export function defaultImagesDeps(): ImagesCommandDeps {
	return {
		probeChafa: cachedProbe,
		readHostImageSettings,
		capsImages: () => getCapabilities().images,
		writeConfigFile,
		settingsListTheme: hostSettingsListTheme,
	};
}

async function probeToFact(
	binaryPath: string | null,
	probeChafa: ImagesCommandDeps["probeChafa"],
): Promise<RuntimeFacts["chafa"]> {
	try {
		const probe = await probeChafa(binaryPath);
		return {
			present: true,
			binary: probe.binary,
			version: `${probe.version.major}.${probe.version.minor}`,
		};
	} catch (error) {
		return { present: false, error: (error as Error).message };
	}
}

/**
 * Refusal copy for a dialog-staged value (#060). `applyMenuChange` is the
 * enforcement; this is only the sentence, shared by both dialog paths so the
 * same rejection reads the same way: the control-character sentence when that is
 * what refused the value, else the field's own copy from `EDITABLE_FIELDS`
 * (which is why that table is the copy's home), else a generic line.
 */
function refusalText(id: string, value: string): string {
	if (hasControlChars(value)) return `pi-chafa: ${controlCharReason(id)}`;
	const copy = EDITABLE_FIELDS.find((field) => field.id === id)?.invalid;
	return copy ?? `pi-chafa: invalid ${id} value`;
}

/**
 * Apply one menu choice, persist it, and emit the caller's notification
 * (spec §4.2). Returns the updated config, or null when the value was invalid —
 * which is reported rather than swallowed, because a dialog that does nothing
 * reads as a broken key (#039). Message text is supplied by the caller so every
 * notification stays byte-identical to the hand-written flow it replaces.
 */
function persistSetting(
	config: ChafaConfig,
	agentDir: string,
	ui: Pick<ExtensionUIContext, "notify">,
	write: ImagesCommandDeps["writeConfigFile"],
	id: SettingKey,
	value: string,
	message: (next: ChafaConfig) => string,
): ChafaConfig | null {
	const next = applyMenuChange(config, id, value);
	if (!next) {
		ui.notify(refusalText(id, value), "warning");
		return null;
	}
	// Sparse write (D25, #058): the file's own keys keep the file's values, and only
	// the key this step changed takes the new one — a full-config write would make
	// every key explicitly present and override pi's own terminal.imageWidthCells
	// for `cellWidth` (#010). Read per step: the fallback writes immediately, so the
	// current file is what the next step layers onto.
	write(agentDir, mergeForWrite(loadFileConfig(agentDir).config, next, [id]));
	// Sanitize at the single notification funnel: every template (generic
	// "updated to", binaryPath, symbolsSet) carries user-entered values, and
	// invariant 3 requires no raw control bytes reach the TUI (#038).
	ui.notify(stripControls(message(next)), "info");
	return next;
}

/** `persistSetting` message for the binaryPath field (set or cleared). */
function binaryPathMessage(next: ChafaConfig): string {
	return next.binaryPath
		? `pi-chafa: saved binaryPath = ${next.binaryPath}`
		: "pi-chafa: cleared binaryPath (using system PATH)";
}

/**
 * Effective capability + provenance from the §6.4 ladder, host showImages
 * flag, pretty-read detection, and a live chafa probe (spec §4.2).
 */
async function buildRuntimeFacts(
	pi: Pick<ExtensionAPI, "getAllTools">,
	config: ChafaConfig,
	agentDir: string,
	deps: ImagesCommandDeps,
): Promise<RuntimeFacts> {
	const hostImages = deps.readHostImageSettings(agentDir);
	const caps = resolveRuntimeCaps(
		deps.capsImages(),
		hostImages.images,
		process.env.PI_IMAGE_PROTOCOL,
		process.env,
		process.platform,
	);
	const chafa = await probeToFact(config.binaryPath, deps.probeChafa);
	return collectRuntimeFacts(pi, caps, hostImages.showImages, chafa);
}

type WizardAction =
	| { action: "done"; report?: string }
	| { action: "cancelled" }
	| { action: "edit" };

/** The eight user-settable fields of pi-chafa.json (spec §6.1), for staged-change counting (#045). */
export const SETTING_KEYS = [
	"preferNative",
	"colors",
	"dither",
	"symbolsSet",
	"cellWidth",
	"maxRows",
	"timeoutMs",
	"binaryPath",
] as const;

/** A user-settable field of pi-chafa.json (spec §6.1). */
export type SettingKey = (typeof SETTING_KEYS)[number];

/**
 * What a valid value looks like, per key (#050). Used verbatim as the tail of a
 * command-line refusal ("expected …"), so it must complete that sentence.
 * binaryPath never rejects (any path is valid, empty clears it) — its entry is
 * documentation, kept so the record stays exhaustive by construction.
 */
const SETTING_ARG_REASONS = {
	preferNative: "true or false (or no value to toggle)",
	colors: `one of ${COLOR_MODES.join(", ")}`,
	dither: `one of ${DITHER_MODES.join(", ")}`,
	symbolsSet: "a non-empty symbols set",
	cellWidth: "a positive integer",
	maxRows: "a positive integer",
	timeoutMs: "a positive integer",
	binaryPath: "any path (empty clears it)",
} satisfies Record<SettingKey, string>;

/** Values offered for the second token of `/images <key> <value>` (#050); binaryPath is free-form. */
export const SETTING_ARG_VALUES: Partial<
	Record<SettingKey, readonly string[]>
> = {
	preferNative: ["true", "false"],
	colors: COLOR_MODES,
	dither: DITHER_MODES,
	symbolsSet: SYMBOL_PRESETS,
	cellWidth: WIDTH_PRESETS,
	maxRows: ROW_PRESETS,
	timeoutMs: TIMEOUT_PRESETS,
};

/**
 * Short command-line copy per key (#050). The panel's own descriptions name panel
 * keys ("Enter/Space cycles · Press 'e' …"), so the two surfaces keep their own
 * copy rather than one being edited out of the other.
 */
const SETTING_ARG_SUMMARIES = {
	preferNative: "Prefer native Kitty/iTerm2 protocols when supported",
	colors:
		"Chafa color mode: full (24-bit truecolor), 256, 240, 16, 8, 2, or none",
	dither: "Chafa dithering algorithm: none, ordered, diffusion, or noise",
	symbolsSet: "Chafa symbol classes (e.g. block+border, ascii, braille)",
	cellWidth: "Width in terminal columns",
	maxRows: "Row height limit cap",
	timeoutMs: "Per-invocation chafa wall-clock limit in ms",
	binaryPath: "Chafa binary executable (empty clears it back to PATH)",
} satisfies Record<SettingKey, string>;

/** One-line description of a key for the command-line surface (completion copy). */
export function settingArgSummary(key: SettingKey): string {
	return SETTING_ARG_SUMMARIES[key];
}

/** Canonical key for a user-typed token, or undefined when it names no setting. */
export function resolveSettingKey(raw: string): SettingKey | undefined {
	const lower = raw.toLowerCase();
	return SETTING_KEYS.find((key) => key.toLowerCase() === lower);
}

/** Result of one `/images <key> <value>` attempt (#050). */
export type SettingArgResult =
	| { ok: true; next: ChafaConfig }
	| { ok: false; reason: string };

/**
 * Pure parse + validation for `/images <key> <value>` (#050). The value rules
 * stay in `applyMenuChange` (their single home); this turns a rejection into the
 * caller's copy. A value carrying control characters is refused rather than
 * stripped: it would be persisted and then rendered in the panel's rows, and a
 * silently stripped path is a different path than the user typed (invariant 3).
 */
export function parseSettingArg(
	current: ChafaConfig,
	key: string,
	value: string,
): SettingArgResult {
	const canonical = resolveSettingKey(key);
	if (!canonical) {
		return {
			ok: false,
			reason: `unknown setting '${stripControls(key)}' — accepted: ${SETTING_KEYS.join(", ")}`,
		};
	}
	if (hasControlChars(value)) {
		return { ok: false, reason: controlCharReason(canonical) };
	}
	const next = applyMenuChange(current, canonical, value);
	if (!next) {
		return {
			ok: false,
			reason: `invalid ${canonical} = '${stripControls(value)}' (expected ${SETTING_ARG_REASONS[canonical]})`,
		};
	}
	return { ok: true, next };
}

/** The settings that differ between two configs, field-by-field (#045, #058). */
function changedKeys(a: ChafaConfig, b: ChafaConfig): SettingKey[] {
	return SETTING_KEYS.filter((key) => a[key] !== b[key]);
}

/** Number of settings that differ between two configs (field-by-field, #045). */
function countChanges(a: ChafaConfig, b: ChafaConfig): number {
	return changedKeys(a, b).length;
}

/**
 * The fields the `e` chord can edit, in list order, with each field's dialog copy
 * and its rejection message (#052). The chord opens a picker over these instead of
 * targeting the highlighted row: the wrapper then keeps no selection state at all,
 * so nothing can make `e` edit a field the user is not looking at — and the host is
 * free to own navigation and mouse (#049).
 */
const EDITABLE_FIELDS: Array<{
	id: string;
	label: string;
	title: string;
	placeholder: string;
	invalid: string | null;
}> = [
	{
		id: "cellWidth",
		label: "Cell width",
		title: "New cellWidth (columns)",
		placeholder: "integer columns (e.g. 72)",
		invalid: "pi-chafa: invalid cellWidth (must be positive integer)",
	},
	{
		id: "maxRows",
		label: "Max rows",
		title: "New maxRows (row cap)",
		placeholder: "integer row cap (e.g. 60)",
		invalid: "pi-chafa: invalid maxRows (must be positive integer)",
	},
	{
		id: "timeoutMs",
		label: "Timeout (ms)",
		title: "New timeoutMs (milliseconds)",
		placeholder: "integer milliseconds (e.g. 8000)",
		invalid: "pi-chafa: invalid timeoutMs (must be positive integer)",
	},
	{
		id: "symbolsSet",
		label: "Symbols set",
		title: "New symbols set",
		placeholder: "chafa --symbols class list (e.g. block+border)",
		invalid: "pi-chafa: invalid symbolsSet (cannot be empty)",
	},
	{
		id: "binaryPath",
		label: "Binary path",
		title: "Chafa binary path",
		placeholder: "absolute path to chafa, or empty to clear",
		// Any string is a valid binaryPath (empty clears it), so there is nothing to reject.
		invalid: null,
	},
];

/**
 * Split `/images <key> <value…>` at the first whitespace run: the key is the first
 * token, the value is everything after it (a binaryPath may contain spaces), and
 * the value is trimmed at its ends.
 */
function splitSettingArg(raw: string): { key: string; value: string } {
	const at = raw.search(/\s/);
	return at === -1
		? { key: raw, value: "" }
		: { key: raw.slice(0, at), value: raw.slice(at + 1).trim() };
}

/** The value as the panel's own rows show it (binaryPath null reads as auto). */
function settingValueText(key: SettingKey, config: ChafaConfig): string {
	const value = config[key];
	return value === null ? "(auto on PATH)" : String(value);
}

/**
 * Deliver command output on the channel the mode owns (#039, #050): a notification
 * where a UI exists, else the mode's stream — stdout in print, stderr in json,
 * where stdout is a JSONL event stream.
 */
function reportCommandText(
	ctx: Pick<ExtensionCommandContext, "mode" | "hasUI">,
	ui: Pick<ExtensionUIContext, "notify">,
	text: string,
	severity: "info" | "warning",
): void {
	if (ctx.mode === "tui" || ctx.hasUI) {
		ui.notify(text, severity);
		return;
	}
	const sink = ctx.mode === "json" ? process.stderr : process.stdout;
	sink.write(`${text}\n`);
}

/**
 * Interactive wizard: pick or cycle settings inline with descriptions,
 * persist immediately (spec §4.2).
 */
export async function runImagesCommand(
	pi: Pick<ExtensionAPI, "getAllTools">,
	args: string,
	ctx: ExtensionCommandContext,
	deps: Partial<ImagesCommandDeps> = {},
): Promise<void> {
	const d = { ...defaultImagesDeps(), ...deps };
	const ui = ctx.ui;
	const agentDir = getConfigDir();
	// The file's own view, captured once: what a save persists is exactly this plus
	// the keys the save changed (D25, #058), never the resolved config.
	const fileValues = loadFileConfig(agentDir).config;
	let config = loadConfig(agentDir);

	// Argument surface (#016 partial, decision D5, #050 complete): `status` prints
	// the runtime facts; `<key> <value>` sets exactly one setting and returns — both
	// work headless and neither opens the panel. An unknown key warns (usage, the
	// accepted keys, a near miss) and then opens the panel, which keeps this
	// forward-compatible with the deferred show/open/reset subcommands.
	const rawArg = typeof args === "string" ? args.trim() : "";
	const arg = rawArg.toLowerCase();
	if (arg === "status") {
		const facts = await buildRuntimeFacts(pi, config, agentDir, d);
		reportCommandText(ctx, ui, describeRuntime(facts).join("\n"), "info");
		return;
	}
	if (rawArg !== "") {
		const split = splitSettingArg(rawArg);
		const canonical = resolveSettingKey(split.key);
		if (canonical) {
			const parsed = parseSettingArg(config, canonical, split.value);
			if (!parsed.ok) {
				// A real key with a bad value is a finished command: refuse, do not write,
				// and do not open the panel — the reason is the whole remedy.
				reportCommandText(ctx, ui, `pi-chafa: ${parsed.reason}`, "warning");
				return;
			}
			// A failed write is reported, not thrown (#061): an fs error escaping as a raw
			// exception reads as a pi-chafa crash, with no attribution and no hint of
			// which setting failed. The panel's save path catches the identical call.
			try {
				d.writeConfigFile(
					agentDir,
					mergeForWrite(fileValues, parsed.next, [canonical]),
				);
			} catch (error) {
				reportCommandText(
					ctx,
					ui,
					`pi-chafa: could not save ${canonical} — ${stripControls((error as Error).message)}`,
					"warning",
				);
				return;
			}
			reportCommandText(
				ctx,
				ui,
				`pi-chafa: ${canonical} is now ${settingValueText(canonical, parsed.next)} — saved to ${agentDir}/pi-chafa.json`,
				"info",
			);
			return;
		}
		// Unknown key: sanitize before it reaches the TUI (the argument is user input
		// and must never carry ANSI/control bytes into a notification, invariant 3), and
		// name the remedy — the usage line, the accepted keys, plus a correction when the
		// argument is a neighbour of the one accepted subcommand (#055).
		const shownArg = stripControls(rawArg);
		const correction = nearMiss(shownArg);
		reportCommandText(
			ctx,
			ui,
			`pi-chafa: unknown /images argument '${shownArg}' — opening settings\n${IMAGES_USAGE}\nkeys: ${SETTING_KEYS.join(", ")}${
				correction ? `\ndid you mean '/images ${correction}'?` : ""
			}`,
			"warning",
		);
	}

	// The chafa --version probe feeds the panel's "Binary path" choices; it is
	// spawned only where a consumer exists — never on the headless print/json
	// path (#039).
	const probeDetected = async (): Promise<string | undefined> => {
		const systemChafa = await probeToFact(null, d.probeChafa);
		return systemChafa.present ? systemChafa.binary : undefined;
	};

	// Interactive TUI panel only in an interactive session: `ctx.mode` is the
	// guard, not the presence of `ui.custom` — the host supplies custom() in
	// every mode, and outside the TUI it no-ops (RPC returns undefined; print/
	// json binds a no-op UI context), which left the command silently doing
	// nothing (#039).
	if (ctx.mode === "tui" && typeof ui.custom === "function") {
		const detectedBinary = await probeDetected();
		// The runtime facts are informational and static for the panel's lifetime:
		// read them once and hand the lines to the status row's submenu (#049).
		const runtimeLines = describeRuntime(
			await buildRuntimeFacts(pi, config, agentDir, d),
		);

		// #045 staged persistence: the host SettingsList frame promises "Esc to
		// cancel" (its hint line is fixed), so no edit may reach the file before
		// an explicit confirm. `base` = the file state at panel open; `draft`
		// accumulates edits; Ctrl+S is the only writer (the synthetic Done row was
		// removed, #054, superseding #047); Esc discards. The fallback select flow keeps its per-step persistence
		// (dialog frames promise nothing — honest as-is).
		const base = config;
		// What the FILE holds (not the resolved config): a save writes these values back
		// plus the draft's changed keys (D25, #058). Captured at open, like `base`.
		const fileBase = fileValues;
		let draft = config;
		for (;;) {
			const result = await ui.custom<WizardAction>((tui, theme, kb, done) => {
				// Built per mount: the status row's submenu needs the keybindings the
				// factory hands us (#049), and the mirror starts on the first row.
				const items = buildSettingItems(
					draft,
					detectedBinary,
					(_current, close) =>
						runtimeStatusSubmenu(runtimeLines, kb, () => close()),
				);
				const list = new SettingsList(
					items,
					Math.min(items.length + 2, 12),
					d.settingsListTheme(),
					(id, newValue) => {
						// Stage only: parse + validate into the draft; nothing touches
						// the file until the confirm (#045).
						const next = applyMenuChange(draft, id, newValue);
						if (next) draft = next;
						tui.requestRender();
					},
					() => done({ action: "cancelled" }),
					{ enableSearch: false },
				);

				const container = new Container();
				// The host's own full-width rule frames the panel, top and bottom, exactly
				// as pi's /settings panel does (settings-selector.js:626/736). DynamicBorder's
				// default colour reads a module-level theme that may be undefined for an
				// extension loaded via jiti, so it is constructed with the per-mount theme
				// the factory handed us — which also tracks a live theme switch (#057).
				const frame = (): DynamicBorder =>
					new DynamicBorder((line) => theme.fg("border", line));
				const title = new Text("", 2, 0);
				// The footer switches on dirty state: the save chord is advertised
				// only while the draft differs from the file (#045). Navigation,
				// confirm and cancel are named from the LIVE bindings (#053) — the host
				// list matches keys through the same manager, so a remapped binding
				// reads correctly here. The chords this wrapper matches by hand
				// (Ctrl+S, `e`, `q`) are written literally, which is what the contract
				// asks for a literal chord.
				const hint = new Text("", 0, 0);
				const dim = (text: string): string => theme.fg("dim", text);
				const cancelKey = `${keyText("tui.select.cancel")}/q`;
				// Both chrome lines are (re)built from the theme the factory handed us, so
				// a live theme switch lands on the next input instead of leaving a styled
				// string frozen from mount; the title sits in the same two-column gutter
				// as the list's rows (#056).
				const refreshHint = (): void => {
					title.setText(theme.bold("pi-chafa Settings"));
					hint.setText(
						dim(
							countChanges(draft, base) > 0
								? `unsaved changes — Ctrl+S saves and closes · ${cancelKey} discards`
								: `  ${keyText("tui.select.up")}/${keyText("tui.select.down")} navigate · ${keyText("tui.select.confirm")}/space cycle · e edit · ${cancelKey} close`,
						),
					);
				};
				refreshHint();
				container.addChild(frame());
				container.addChild(title);
				container.addChild(new Spacer(1));
				container.addChild(list);
				// Below the list, beside the host's own hint line: the two key lines that
				// describe this panel belong together, and the save chord is the one
				// closest to the rows it saves (#056).
				container.addChild(hint);
				container.addChild(frame());

				// The one confirm: write once, close, report the count and file.
				// A failed write warns, keeps the draft, and leaves the panel open
				// for a retry (#045).
				const saveAndClose = (): void => {
					const changed = changedKeys(draft, base);
					if (changed.length === 0) {
						done({ action: "done", report: "pi-chafa: settings unchanged" });
						return;
					}
					try {
						d.writeConfigFile(
							agentDir,
							mergeForWrite(fileBase, draft, changed),
						);
						done({
							action: "done",
							report: `pi-chafa: ${changed.length} setting${changed.length === 1 ? "" : "s"} saved to ${agentDir}/pi-chafa.json`,
						});
					} catch (error) {
						ui.notify(
							`pi-chafa: could not save settings — ${stripControls((error as Error).message)}`,
							"warning",
						);
						tui.requestRender();
					}
				};

				// The mounted component is the one that receives mouse events (tui.js:14),
				// and `Container.handleMouse` is what forwards them to a child — the same
				// device pi's own settings wrapper uses. So the panel has to BE the
				// container rather than wrap it (#049); grafting handleInput onto the
				// instance makes one object that is both.
				return Object.assign(container, {
					handleInput: (data: string) => {
						// Ctrl+S = confirm, intercepted BEFORE the list can route the
						// key anywhere (search/submenu keys would swallow it otherwise;
						// #045).
						if (matchesKey(data, Key.ctrl("s"))) {
							saveAndClose();
							return;
						}
						// No selection mirror (#052): the host list owns navigation, activation,
						// submenus and (through the Container wrapper) mouse, and nothing here
						// depends on which row is highlighted — the `e` chord picks its field in
						// a dialog instead of assuming the highlight.
						// 'q'/'Q' is an exact alias of Esc (#048): it cancels and is reported,
						// so a dirty draft is never discarded silently. Letter keys go through
						// the host matcher so kitty-protocol input still lands on them (#041) —
						// a raw compare would never fire for CSI-u.
						if (matchesKey(data, "q") || matchesKey(data, "shift+q")) {
							done({ action: "cancelled" });
							return;
						}

						// 'e'/'E' edits a field chosen in a picker (#052): not knowing the
						// highlighted row is exactly what lets the host own the selection.
						if (matchesKey(data, "e") || matchesKey(data, "shift+e")) {
							done({ action: "edit" });
							return;
						}

						list.handleInput(data);
						tui.requestRender();
						refreshHint();
					},
				});
			});

			if (!result || result.action === "done") {
				// Outcome reports ride OUT of the panel (the toast outlives the
				// modal; #045); a clean Ctrl+S carries a report too.
				if (result?.report) ui.notify(result.report, "info");
				return;
			}

			if (result.action === "cancelled") {
				// Esc: the draft is discarded (closure-only) and the file is
				// byte-identical; say so — silence reads as failure (#045).
				ui.notify("pi-chafa: settings unchanged (cancelled)", "info");
				return;
			}

			if (result.action === "edit") {
				// Picker first (#052), then the field's own dialog. Both dialogs promise
				// nothing, so staging here is honest: the draft is written only by the
				// Ctrl+S confirm (#046). Invalid values warn and stage nothing.
				const label = await ui.select(
					"Edit which setting?",
					EDITABLE_FIELDS.map((field) => field.label),
				);
				const field =
					label === undefined
						? undefined
						: EDITABLE_FIELDS.find((f) => f.label === label);
				if (field) {
					const value = await ui.input(field.title, field.placeholder);
					if (value !== undefined) {
						const next = applyMenuChange(draft, field.id, value);
						if (next) draft = next;
						else ui.notify(refusalText(field.id, value), "warning");
					}
				}
			}
		}
	}

	// Dialog-capable non-TUI (RPC): hasUI is true in RPC per the host contract
	// (#042), so the sequential select/input flow works there. The panel itself
	// stays TUI-only: the host's SettingsList is an interactive component.
	if (ctx.hasUI) {
		const detectedBinary = await probeDetected();

		// Fallback interface when ui.custom is not available: ui.select with descriptions & sub-selects
		for (;;) {
			const items = buildSettingItems(config, detectedBinary);
			// The explicit close entry (#059). The TUI panel confirms with Ctrl+S; the
			// fallback cannot — no component is mounted to intercept a key — so its exit
			// is an option, in the position the removed Done row held. The copy comes
			// from the constant so the sentence keeps one home.
			const closeEntry = `Close — ${SETTING_DESCRIPTIONS.done}`;
			const options = [
				...items.map((item) =>
					item.id === "runtimeStatus"
						? `${item.label} — ${item.description}`
						: `${item.label}: [${item.currentValue}] — ${item.description}`,
				),
				closeEntry,
			];

			const choice = await ui.select("pi-chafa settings", options);
			if (!choice || choice.startsWith("Close")) return;

			if (choice.startsWith("Runtime status")) {
				const facts = await buildRuntimeFacts(pi, config, agentDir, d);
				const statusOptions = [...describeRuntime(facts), "Close"];
				await ui.select("Runtime status (informational)", statusOptions);
				continue;
			}

			if (choice.startsWith("Prefer native")) {
				const next = persistSetting(
					config,
					agentDir,
					ui,
					d.writeConfigFile,
					"preferNative",
					"",
					(next) =>
						`pi-chafa: preferNative is now ${next.preferNative ? "true (native preferred)" : "false (symbols forced)"}`,
				);
				if (next) config = next;
				continue;
			}

			if (choice.startsWith("Color mode")) {
				const picked = await ui.select("Select color mode", [...COLOR_MODES]);
				if (picked) {
					const next = persistSetting(
						config,
						agentDir,
						ui,
						d.writeConfigFile,
						"colors",
						picked,
						(next) => `pi-chafa: color mode is now ${next.colors}`,
					);
					if (next) config = next;
				}
				continue;
			}

			if (choice.startsWith("Dither mode")) {
				const picked = await ui.select("Select dither mode", [...DITHER_MODES]);
				if (picked) {
					const next = persistSetting(
						config,
						agentDir,
						ui,
						d.writeConfigFile,
						"dither",
						picked,
						(next) => `pi-chafa: dither mode is now ${next.dither}`,
					);
					if (next) config = next;
				}
				continue;
			}

			if (choice.startsWith("Symbols set")) {
				const picked = await ui.select("Select symbols set", [
					...SYMBOL_PRESETS,
				]);
				if (picked) {
					const next = persistSetting(
						config,
						agentDir,
						ui,
						d.writeConfigFile,
						"symbolsSet",
						picked,
						(next) => `pi-chafa: symbolsSet is now ${next.symbolsSet}`,
					);
					if (next) config = next;
				}
				continue;
			}

			if (choice.startsWith("Cell width")) {
				const picked = await ui.select("Select cell width (columns)", [
					...WIDTH_PRESETS,
					"Custom...",
				]);
				const value =
					picked === "Custom..."
						? await ui.input("Enter custom cellWidth", "positive integer")
						: picked;
				if (value) {
					const next = persistSetting(
						config,
						agentDir,
						ui,
						d.writeConfigFile,
						"cellWidth",
						value,
						(next) => `pi-chafa: cellWidth is now ${next.cellWidth}`,
					);
					if (next) config = next;
				}
				continue;
			}

			if (choice.startsWith("Max rows")) {
				const picked = await ui.select("Select max rows (row cap)", [
					...ROW_PRESETS,
					"Custom...",
				]);
				const value =
					picked === "Custom..."
						? await ui.input("Enter custom maxRows", "positive integer")
						: picked;
				if (value) {
					const next = persistSetting(
						config,
						agentDir,
						ui,
						d.writeConfigFile,
						"maxRows",
						value,
						(next) => `pi-chafa: maxRows is now ${next.maxRows}`,
					);
					if (next) config = next;
				}
				continue;
			}

			if (choice.startsWith("Timeout")) {
				const picked = await ui.select("Select timeout (ms)", [
					...TIMEOUT_PRESETS,
					"Custom...",
				]);
				const value =
					picked === "Custom..."
						? await ui.input(
								"Enter custom timeoutMs (milliseconds)",
								"positive integer ms",
							)
						: picked;
				if (value) {
					const next = persistSetting(
						config,
						agentDir,
						ui,
						d.writeConfigFile,
						"timeoutMs",
						value,
						(next) => `pi-chafa: timeoutMs is now ${next.timeoutMs}`,
					);
					if (next) config = next;
				}
				continue;
			}

			if (choice.startsWith("Binary path")) {
				const binaryChoices = [
					"Auto (system PATH)",
					...(detectedBinary ? [`Detected: ${detectedBinary}`] : []),
					"Type custom path...",
				];
				const picked = await ui.select("Chafa binary path", binaryChoices);
				if (picked === "Type custom path...") {
					const val = await ui.input(
						"Chafa binary path",
						"absolute path, or empty to clear",
					);
					if (val !== undefined) {
						const next = persistSetting(
							config,
							agentDir,
							ui,
							d.writeConfigFile,
							"binaryPath",
							val,
							binaryPathMessage,
						);
						if (next) config = next;
					}
				} else if (picked?.startsWith("Detected:")) {
					const pathOnly = picked.replace("Detected: ", "").trim();
					const next = persistSetting(
						config,
						agentDir,
						ui,
						d.writeConfigFile,
						"binaryPath",
						pathOnly,
						binaryPathMessage,
					);
					if (next) config = next;
				} else if (picked === "Auto (system PATH)") {
					const next = persistSetting(
						config,
						agentDir,
						ui,
						d.writeConfigFile,
						"binaryPath",
						"",
						binaryPathMessage,
					);
					if (next) config = next;
				}
			}
		}
	}

	// print/json: no dialogs, no custom component, no probe — say what still works.
	const sink = ctx.mode === "json" ? process.stderr : process.stdout;
	sink.write(
		"pi-chafa: no panel here — set one setting with '/images <key> <value>' (e.g. '/images colors 256'), or run '/images status' for the runtime facts\n",
	);
}
