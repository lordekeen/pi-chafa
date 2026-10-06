import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionUIContext,
	ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	getCapabilities,
	Key,
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
	readHostImageSettings,
	writeConfigFile,
} from "../config.js";
import { type ImageEnv, isTmux, resolveCapsImages } from "../detect.js";
import { stripControls } from "../sanitize.js";
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
	done: "Save and close (Ctrl+S)", // #047: the row is the second confirm, same as the chord
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

/**
 * Build SettingItem rows for SettingsList (spec §4.2) with inline cycling values
 * and rich contextual descriptions.
 */
export function buildSettingItems(
	config: ChafaConfig,
	detectedBinary?: string,
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

	const symbolValues = SYMBOL_PRESETS.includes(config.symbolsSet)
		? [...SYMBOL_PRESETS]
		: [config.symbolsSet, ...SYMBOL_PRESETS];

	const binaryValues: string[] = ["(auto on PATH)"];
	if (detectedBinary && detectedBinary !== "(auto on PATH)") {
		binaryValues.push(detectedBinary);
	}
	if (
		config.binaryPath &&
		config.binaryPath !== detectedBinary &&
		config.binaryPath !== "(auto on PATH)"
	) {
		binaryValues.push(config.binaryPath);
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
			currentValue: config.symbolsSet,
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
			currentValue: config.binaryPath ?? "(auto on PATH)",
			values: binaryValues,
		},
		{
			id: "runtimeStatus",
			label: "Runtime status",
			description: SETTING_DESCRIPTIONS.runtimeStatus,
			currentValue: "view",
		},
		{
			id: "done",
			label: "Done",
			description: SETTING_DESCRIPTIONS.done,
			currentValue: "exit",
		},
	];
}

/**
 * Format SettingsListTheme safely adapting the host Theme if present.
 */
export function createSettingsTheme(theme?: {
	bold?: (text: string) => string;
	fg?: (color: ThemeColor, text: string) => string;
}): SettingsListTheme {
	const fg = (color: ThemeColor, text: string) =>
		theme?.fg ? theme.fg(color, text) : text;
	const bold = (text: string) => (theme?.bold ? theme.bold(text) : text);

	return {
		label: (text: string, selected: boolean) =>
			selected ? bold(fg("accent", text)) : fg("text", text),
		value: (text: string, selected: boolean) =>
			selected ? bold(fg("accent", text)) : fg("muted", text),
		description: (text: string) => fg("muted", text),
		cursor: fg("accent", "→ "),
		hint: (text: string) => fg("dim", text),
	};
}

/**
 * Apply one wizard choice to the in-memory config. Returns null when the
 * choice is unknown or the value is invalid (the caller re-prompts).
 */
export function applyMenuChange(
	current: ChafaConfig,
	choice: string,
	value: string,
): ChafaConfig | null {
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
	writeConfigFile: (agentDir: string, config: ChafaConfig) => void;
}

function defaultImagesDeps(): ImagesCommandDeps {
	return {
		probeChafa: cachedProbe,
		readHostImageSettings,
		capsImages: () => getCapabilities().images,
		writeConfigFile,
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
 * Apply one menu choice, persist it, and emit the caller's notification
 * (spec §4.2). Returns the updated config, or null when the value was invalid
 * (callers warn / re-prompt). Message text is supplied by the caller so every
 * notification stays byte-identical to the hand-written flow it replaces.
 */
function persistSetting(
	config: ChafaConfig,
	agentDir: string,
	ui: Pick<ExtensionUIContext, "notify">,
	id: string,
	value: string,
	message: (next: ChafaConfig) => string,
): ChafaConfig | null {
	const next = applyMenuChange(config, id, value);
	if (!next) return null;
	writeConfigFile(agentDir, next);
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
	| { action: "status" }
	| { action: "input"; id: string };

/** The eight user-settable fields of pi-chafa.json (spec §6.1), for staged-change counting (#045). */
const SETTING_KEYS = [
	"preferNative",
	"colors",
	"dither",
	"symbolsSet",
	"cellWidth",
	"maxRows",
	"timeoutMs",
	"binaryPath",
] as const;

/** Number of settings that differ between two configs (field-by-field, #045). */
function countChanges(a: ChafaConfig, b: ChafaConfig): number {
	return SETTING_KEYS.filter((key) => a[key] !== b[key]).length;
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
	let config = loadConfig(agentDir);

	// Argument surface (#016 partial, decision D5): `status` prints the runtime
	// facts and returns without opening the panel; an unknown argument warns and
	// then opens the panel, which keeps this forward-compatible with the deferred
	// show/open/reset subcommands. No argument = the interactive panel.
	const rawArg = typeof args === "string" ? args.trim() : "";
	const arg = rawArg.toLowerCase();
	if (arg === "status") {
		const facts = await buildRuntimeFacts(pi, config, agentDir, d);
		const lines = describeRuntime(facts).join("\n");
		// TUI and RPC notify; print/json write to the mode's channel — stdout in
		// print, stderr in json, where stdout must stay a clean JSONL stream (#039).
		if (ctx.mode === "tui" || ctx.hasUI) {
			ui.notify(lines, "info");
		} else {
			const sink = ctx.mode === "json" ? process.stderr : process.stdout;
			sink.write(`${lines}\n`);
		}
		return;
	}
	if (arg !== "") {
		// Sanitize before it reaches the TUI: the argument is user input and must
		// never carry ANSI/control bytes into a notification (AGENTS.md invariant 3).
		ui.notify(
			`pi-chafa: unknown /images argument '${stripControls(rawArg)}' — opening settings`,
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

		// #045 staged persistence: the host SettingsList frame promises "Esc to
		// cancel" (its hint line is fixed), so no edit may reach the file before
		// an explicit confirm. `base` = the file state at panel open; `draft`
		// accumulates edits; Ctrl+S and the Done row (#047) are the only writers;
		// Esc discards. The fallback select flow keeps its per-step persistence
		// (dialog frames promise nothing — honest as-is).
		const base = config;
		let draft = config;
		for (;;) {
			const items = buildSettingItems(draft, detectedBinary);
			let currentIndex = 0;

			const result = await ui.custom<WizardAction>((tui, theme, kb, done) => {
				const list = new SettingsList(
					items,
					Math.min(items.length + 2, 12),
					createSettingsTheme(theme),
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
				container.addChild(new Text("pi-chafa Settings", 1, 0));
				// The footer switches on dirty state: the save chord is advertised
				// only while the draft differs from the file (#045).
				const hint = new Text("", 0, 0);
				const dim = (text: string): string =>
					theme && typeof theme.fg === "function"
						? theme.fg("dim", text)
						: text;
				const refreshHint = (): void => {
					hint.setText(
						dim(
							countChanges(draft, base) > 0
								? "unsaved changes — Ctrl+S saves and closes · Esc discards"
								: "  ↑/↓ navigate · Enter/Space cycle · 'e' edit custom · Esc/q close",
						),
					);
				};
				refreshHint();
				container.addChild(hint);
				container.addChild(new Spacer(1));
				container.addChild(list);

				// The one confirm: write once, close, report the count and file.
				// A failed write warns, keeps the draft, and leaves the panel open
				// for a retry (#045).
				const saveAndClose = (): void => {
					const n = countChanges(draft, base);
					if (n === 0) {
						done({ action: "done", report: "pi-chafa: settings unchanged" });
						return;
					}
					try {
						d.writeConfigFile(agentDir, draft);
						done({
							action: "done",
							report: `pi-chafa: ${n} setting${n === 1 ? "" : "s"} saved to ${agentDir}/pi-chafa.json`,
						});
					} catch (error) {
						ui.notify(
							`pi-chafa: could not save settings — ${(error as Error).message}`,
							"warning",
						);
						tui.requestRender();
					}
				};

				return {
					render: (w: number) => container.render(w),
					invalidate: () => container.invalidate(),
					handleInput: (data: string) => {
						// Ctrl+S = confirm, intercepted BEFORE the list can route the
						// key anywhere (search/submenu keys would swallow it otherwise;
						// #045).
						if (matchesKey(data, Key.ctrl("s"))) {
							saveAndClose();
							return;
						}
						// Single selection owner (#041): the mirror moves ONLY on the
						// same factory-keybinding predicate the list itself uses, so it
						// can never drift from the rendered highlight under remapped
						// keybindings (the old raw-arrow fallback did).
						if (kb.matches(data, "tui.select.up")) {
							currentIndex =
								currentIndex === 0 ? items.length - 1 : currentIndex - 1;
						} else if (kb.matches(data, "tui.select.down")) {
							currentIndex =
								currentIndex === items.length - 1 ? 0 : currentIndex + 1;
						}

						const currentItem = items[currentIndex];
						if (
							(matchesKey(data, Key.enter) ||
								kb.matches(data, "tui.select.confirm")) &&
							currentItem
						) {
							// Pseudo-rows (values-less actions) belong to the wrapper;
							// value rows fall through so the list cycles them. The Done
							// row is the second confirm — identical to Ctrl+S (#047) —
							// so the two cannot drift.
							if (currentItem.id === "done") {
								saveAndClose();
								return;
							}
							if (currentItem.id === "runtimeStatus") {
								done({ action: "status" });
								return;
							}
						}

						// 'q'/'Q' exits (README documents Esc / q; #003). Letter keys go
						// through the host matcher so kitty-protocol input still lands
						// on them (#041) — a raw compare would never fire for CSI-u.
						if (matchesKey(data, "q") || matchesKey(data, "shift+q")) {
							done({ action: "done" });
							return;
						}

						// 'e'/'E' edit editable fields
						if (
							(matchesKey(data, "e") || matchesKey(data, "shift+e")) &&
							currentItem &&
							(currentItem.id === "binaryPath" ||
								currentItem.id === "cellWidth" ||
								currentItem.id === "maxRows" ||
								currentItem.id === "timeoutMs" ||
								currentItem.id === "symbolsSet")
						) {
							done({ action: "input", id: currentItem.id });
							return;
						}

						list.handleInput(data);
						tui.requestRender();
						refreshHint();
					},
				};
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

			if (result.action === "status") {
				const facts = await buildRuntimeFacts(pi, config, agentDir, d);
				const options = [...describeRuntime(facts), "Close"];
				await ui.select("Runtime status (informational)", options);
				continue;
			}

			if (result.action === "input") {
				const id = result.id;
				// #046: the 'e' dialogs STAGE into the draft — no write, no per-field
				// notification; the save report (Ctrl+S / Done) covers them, and Esc
				// after an 'e'-edit leaves the file byte-identical. Invalid values
				// keep the warn + re-prompt, never writing. The non-custom fallback
				// flow below keeps its per-step persistence (dialog frames promise
				// no cancel — honest as-is).
				if (id === "cellWidth") {
					const value = await ui.input(
						"New cellWidth (columns)",
						"integer columns (e.g. 72)",
					);
					if (value !== undefined) {
						const next = applyMenuChange(draft, "cellWidth", value);
						if (next) draft = next;
						else
							ui.notify(
								"pi-chafa: invalid cellWidth (must be positive integer)",
								"warning",
							);
					}
				} else if (id === "maxRows") {
					const value = await ui.input(
						"New maxRows (row cap)",
						"integer row cap (e.g. 60)",
					);
					if (value !== undefined) {
						const next = applyMenuChange(draft, "maxRows", value);
						if (next) draft = next;
						else
							ui.notify(
								"pi-chafa: invalid maxRows (must be positive integer)",
								"warning",
							);
					}
				} else if (id === "timeoutMs") {
					const value = await ui.input(
						"New timeoutMs (milliseconds)",
						"integer milliseconds (e.g. 8000)",
					);
					if (value !== undefined) {
						const next = applyMenuChange(draft, "timeoutMs", value);
						if (next) draft = next;
						else
							ui.notify(
								"pi-chafa: invalid timeoutMs (must be positive integer)",
								"warning",
							);
					}
				} else if (id === "symbolsSet") {
					const value = await ui.input(
						"New symbols set",
						"chafa --symbols class list (e.g. block+border)",
					);
					if (value !== undefined) {
						const next = applyMenuChange(draft, "symbolsSet", value);
						if (next) draft = next;
						else
							ui.notify(
								"pi-chafa: invalid symbolsSet (cannot be empty)",
								"warning",
							);
					}
				} else if (id === "binaryPath") {
					const value = await ui.input(
						"Chafa binary path",
						"absolute path to chafa, or empty to clear",
					);
					if (value !== undefined) {
						const next = applyMenuChange(draft, "binaryPath", value);
						if (next) draft = next;
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
			const options = items.map((item) => {
				if (item.id === "done" || item.id === "runtimeStatus") {
					return `${item.label} — ${item.description}`;
				}
				return `${item.label}: [${item.currentValue}] — ${item.description}`;
			});

			const choice = await ui.select("pi-chafa settings", options);
			if (!choice || choice.startsWith("Done")) return;

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
						"binaryPath",
						"",
						binaryPathMessage,
					);
					if (next) config = next;
				}
			}
		}
	}

	// print/json: no dialogs, no custom component, no probe — say so.
	const sink = ctx.mode === "json" ? process.stderr : process.stdout;
	sink.write(
		"pi-chafa: /images settings are interactive-only — run '/images status' for the runtime facts\n",
	);
}
