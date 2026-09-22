import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionUIContext,
	ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	getCapabilities,
	getKeybindings,
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
import { resolveCapsImages } from "../detect.js";
import {
	type AgentCapsImages,
	type ChafaConfig,
	COLOR_MODES,
	type ColorsMode,
	DITHER_MODES,
	type DitherMode,
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
	done: "Save changes and return to conversation.",
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
 * show_image uses (§6.4: getCapabilities() → host terminal.images →
 * PI_IMAGE_PROTOCOL), plus the provenance of whichever source won. The panel
 * is diagnostic: the raw caps singleton can read `null` while native delivery
 * still works via a host setting or the env var.
 */
export function resolveRuntimeCaps(
	hostCaps: AgentCapsImages,
	hostImages: AgentCapsImages,
	envProtocol: string | undefined,
): RuntimeCaps {
	const capsImages = resolveCapsImages(hostCaps, hostImages, envProtocol);
	if (capsImages === null) return { capsImages: null, capsSource: "none" };
	if (hostCaps !== null) return { capsImages, capsSource: "getCapabilities()" };
	if (resolveCapsImages(null, hostImages, undefined) !== null)
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

async function probeToFact(
	binaryPath: string | null,
): Promise<RuntimeFacts["chafa"]> {
	try {
		const probe = await cachedProbe(binaryPath);
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
	ui.notify(message(next), "info");
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
): Promise<RuntimeFacts> {
	const hostImages = readHostImageSettings(agentDir);
	const caps = resolveRuntimeCaps(
		getCapabilities().images,
		hostImages.images,
		process.env.PI_IMAGE_PROTOCOL,
	);
	const chafa = await probeToFact(config.binaryPath);
	return collectRuntimeFacts(pi, caps, hostImages.showImages, chafa);
}

type WizardAction =
	| { action: "done" }
	| { action: "status" }
	| { action: "input"; id: string };

/**
 * Interactive wizard: pick or cycle settings inline with descriptions,
 * persist immediately (spec §4.2).
 */
export async function runImagesCommand(
	pi: Pick<ExtensionAPI, "getAllTools">,
	_args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const ui = ctx.ui;
	const agentDir = getConfigDir();
	let config = loadConfig(agentDir);
	const systemChafa = await probeToFact(null);
	const detectedBinary = systemChafa.present ? systemChafa.binary : undefined;

	// Primary interactive TUI interface: SettingsList with inline cycling & descriptions
	if (typeof ui.custom === "function") {
		for (;;) {
			const items = buildSettingItems(config, detectedBinary);
			let currentIndex = 0;

			const result = await ui.custom<WizardAction>((tui, theme, _kb, done) => {
				const list = new SettingsList(
					items,
					Math.min(items.length + 2, 12),
					createSettingsTheme(theme),
					(id, newValue) => {
						const next = persistSetting(
							config,
							agentDir,
							ui,
							id,
							newValue,
							() => `pi-chafa: ${id} updated to ${newValue}`,
						);
						if (next) {
							config = next;
							tui.requestRender();
						}
					},
					() => done({ action: "done" }),
					{ enableSearch: false },
				);

				const container = new Container();
				container.addChild(new Text("⚙  pi-chafa Settings", 1, 0));
				container.addChild(
					new Text(
						theme && typeof theme.fg === "function"
							? theme.fg(
									"dim",
									"  ↑/↓ navigate · Enter/Space cycle · 'e' edit custom · Esc/q close",
								)
							: "  ↑/↓ navigate · Enter/Space cycle · 'e' edit custom · Esc/q close",
						0,
						0,
					),
				);
				container.addChild(new Spacer(1));
				container.addChild(list);

				const kb = getKeybindings();

				return {
					render: (w: number) => container.render(w),
					invalidate: () => container.invalidate(),
					handleInput: (data: string) => {
						if (kb.matches(data, "tui.select.up") || matchesKey(data, "up")) {
							currentIndex =
								currentIndex === 0 ? items.length - 1 : currentIndex - 1;
						} else if (
							kb.matches(data, "tui.select.down") ||
							matchesKey(data, "down")
						) {
							currentIndex =
								currentIndex === items.length - 1 ? 0 : currentIndex + 1;
						}

						const currentItem = items[currentIndex];
						if (
							(matchesKey(data, Key.enter) ||
								kb.matches(data, "tui.select.confirm")) &&
							currentItem
						) {
							if (currentItem.id === "done") {
								done({ action: "done" });
								return;
							}
							if (currentItem.id === "runtimeStatus") {
								done({ action: "status" });
								return;
							}
						}

						// Press 'q' or 'Q' to exit (README documents Esc / q)
						if (data === "q" || data === "Q") {
							done({ action: "done" });
							return;
						}

						// Press 'e' or 'E' to edit editable fields
						if (
							(data === "e" || data === "E") &&
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
					},
				};
			});

			if (!result || result.action === "done") {
				return;
			}

			if (result.action === "status") {
				const facts = await buildRuntimeFacts(pi, config, agentDir);
				const options = [...describeRuntime(facts), "Close"];
				await ui.select("Runtime status (informational)", options);
				continue;
			}

			if (result.action === "input") {
				const id = result.id;
				if (id === "cellWidth") {
					const value = await ui.input(
						"New cellWidth (columns)",
						"integer columns (e.g. 72)",
					);
					if (value !== undefined) {
						const next = persistSetting(
							config,
							agentDir,
							ui,
							"cellWidth",
							value,
							(next) => `pi-chafa: saved cellWidth = ${next.cellWidth}`,
						);
						if (next) config = next;
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
						const next = persistSetting(
							config,
							agentDir,
							ui,
							"maxRows",
							value,
							(next) => `pi-chafa: saved maxRows = ${next.maxRows}`,
						);
						if (next) config = next;
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
						const next = persistSetting(
							config,
							agentDir,
							ui,
							"timeoutMs",
							value,
							(next) => `pi-chafa: saved timeoutMs = ${next.timeoutMs}`,
						);
						if (next) config = next;
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
						const next = persistSetting(
							config,
							agentDir,
							ui,
							"symbolsSet",
							value,
							(next) => `pi-chafa: saved symbolsSet = ${next.symbolsSet}`,
						);
						if (next) config = next;
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
						const next = persistSetting(
							config,
							agentDir,
							ui,
							"binaryPath",
							value,
							binaryPathMessage,
						);
						if (next) config = next;
					}
				}
			}
		}
	}

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
			const facts = await buildRuntimeFacts(pi, config, agentDir);
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
			const picked = await ui.select("Select symbols set", [...SYMBOL_PRESETS]);
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
