import type {
	ExtensionAPI,
	ExtensionCommandContext,
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
import { probeChafa } from "../chafa.js";
import {
	getConfigDir,
	loadConfig,
	readHostImageSettings,
	writeConfigFile,
} from "../config.js";
import {
	type AgentCapsImages,
	type ChafaConfig,
	COLOR_MODES,
	type ColorsMode,
	DITHER_MODES,
	type DitherMode,
} from "../types.js";

export const MENU = [
	"Change cellWidth",
	"Change colors",
	"Change symbols set",
	"Change dither",
	"Change maxRows",
	"Toggle preferNative",
	"Set chafa binary path",
	"Runtime status",
	"Done",
] as const;

export const SETTING_DESCRIPTIONS = {
	preferNative:
		"Prefer native Kitty/iTerm2 protocols when supported; false forces Chafa symbols art.",
	colors:
		"Chafa color mode: full (24-bit truecolor), 256, 240, 16, 8, 2, or none.",
	dither: "Chafa dithering algorithm: none, ordered, diffusion, or noise.",
	symbolsSet:
		"Chafa symbol classes: block+border, block, border, ascii, braille, all, or custom.",
	cellWidth: "Width in terminal columns for symbols rendering (default 60).",
	maxRows: "Row height limit cap for symbols rendering (default 50).",
	binaryPath:
		"Absolute path to chafa binary (leave empty to discover on system PATH).",
	runtimeStatus:
		"Inspect detected image protocols, host showImages setting, and chafa version.",
	done: "Save changes and return to conversation.",
} as const;

export interface RuntimeFacts {
	capsImages: AgentCapsImages;
	showImages: boolean;
	prettyRead: boolean;
	chafa:
		| { present: true; binary: string; version: string }
		| { present: false; error: string };
}

/**
 * pi-pretty detection is informational only (spec §4.4): a non-"builtin" read
 * source means a pretty reader overrides the built-in read tool (spec §3.5 —
 * the real 0.84.4 field is sourceInfo.source, not a top-level source).
 */
export function collectRuntimeFacts(
	pi: Pick<ExtensionAPI, "getAllTools">,
	capsImages: AgentCapsImages,
	showImages: boolean,
	chafa: RuntimeFacts["chafa"],
): RuntimeFacts {
	const readTool = pi.getAllTools().find((tool) => tool.name === "read");
	const prettyRead =
		readTool !== undefined && readTool.sourceInfo.source !== "builtin";
	return { capsImages, showImages, prettyRead, chafa };
}

/** Pure status lines for the /images informational section (spec §4.2). */
export function describeRuntime(facts: RuntimeFacts): string[] {
	const protocol = facts.capsImages ?? "none";
	const show = facts.showImages ? "on" : "off";
	const pretty = facts.prettyRead ? "detected" : "not detected";
	const chafa = facts.chafa.present
		? `${facts.chafa.version} (${facts.chafa.binary})`
		: `NOT FOUND — ${facts.chafa.error}`;
	return [
		`Detected image protocol: ${protocol}`,
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
export function buildSettingItems(config: ChafaConfig): SettingItem[] {
	const widthPresets = ["40", "50", "60", "80", "100", "120"];
	const currentWidthStr = String(config.cellWidth);
	const widthValues = widthPresets.includes(currentWidthStr)
		? [...widthPresets, "custom..."]
		: [currentWidthStr, ...widthPresets, "custom..."];

	const rowPresets = ["25", "35", "50", "75", "100"];
	const currentRowStr = String(config.maxRows);
	const rowValues = rowPresets.includes(currentRowStr)
		? [...rowPresets, "custom..."]
		: [currentRowStr, ...rowPresets, "custom..."];

	const symbolPresets = [
		"block+border",
		"block",
		"border",
		"ascii",
		"braille",
		"all",
	];
	const symbolValues = symbolPresets.includes(config.symbolsSet)
		? [...symbolPresets, "custom..."]
		: [config.symbolsSet, ...symbolPresets, "custom..."];

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
			id: "binaryPath",
			label: "Binary path",
			description: SETTING_DESCRIPTIONS.binaryPath,
			currentValue: config.binaryPath ?? "(auto on PATH)",
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
		case "Change cellWidth":
		case "cellWidth": {
			const parsed = parsePositiveInt(value.trim());
			return parsed === undefined ? null : { ...current, cellWidth: parsed };
		}
		case "Change colors":
		case "colors": {
			const trimmed = value.trim() as ColorsMode;
			if (!(COLOR_MODES as readonly string[]).includes(trimmed)) return null;
			return { ...current, colors: trimmed };
		}
		case "Change symbols set":
		case "symbolsSet": {
			const trimmed = value.trim();
			return trimmed === "" ? null : { ...current, symbolsSet: trimmed };
		}
		case "Change dither":
		case "dither": {
			const trimmed = value.trim() as DitherMode;
			if (!(DITHER_MODES as readonly string[]).includes(trimmed)) return null;
			return { ...current, dither: trimmed };
		}
		case "Change maxRows":
		case "maxRows": {
			const parsed = parsePositiveInt(value.trim());
			return parsed === undefined ? null : { ...current, maxRows: parsed };
		}
		case "Toggle preferNative":
			return { ...current, preferNative: !current.preferNative };
		case "preferNative": {
			const trimmed = value.trim().toLowerCase();
			if (trimmed === "true") return { ...current, preferNative: true };
			if (trimmed === "false") return { ...current, preferNative: false };
			if (trimmed === "")
				return { ...current, preferNative: !current.preferNative };
			return null;
		}
		case "Set chafa binary path":
		case "binaryPath": {
			const trimmed = value.trim();
			return { ...current, binaryPath: trimmed === "" ? null : trimmed };
		}
		default:
			return null;
	}
}

async function probeToFact(
	binaryPath: string | null,
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

	// Primary interactive TUI interface: SettingsList with inline cycling & descriptions
	if (typeof ui.custom === "function") {
		for (;;) {
			const items = buildSettingItems(config);
			let currentIndex = 0;

			const result = await ui.custom<WizardAction>((tui, theme, _kb, done) => {
				const list = new SettingsList(
					items,
					Math.min(items.length + 2, 12),
					createSettingsTheme(theme),
					(id, newValue) => {
						if (newValue === "custom...") {
							done({ action: "input", id });
							return;
						}
						const next = applyMenuChange(config, id, newValue);
						if (next) {
							config = next;
							writeConfigFile(agentDir, config);
							ui.notify(`pi-chafa: ${id} updated to ${newValue}`, "info");
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
									"  ↑/↓ navigate · Enter/Space cycle inline · Esc close",
								)
							: "  ↑/↓ navigate · Enter/Space cycle inline · Esc close",
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
							if (currentItem.id === "binaryPath") {
								done({ action: "input", id: "binaryPath" });
								return;
							}
						}

						list.handleInput(data);
					},
				};
			});

			if (!result || result.action === "done") {
				return;
			}

			if (result.action === "status") {
				const hostImages = readHostImageSettings(agentDir);
				const chafa = await probeToFact(config.binaryPath);
				const facts = collectRuntimeFacts(
					pi,
					getCapabilities().images,
					hostImages.showImages,
					chafa,
				);
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
						const next = applyMenuChange(config, "cellWidth", value);
						if (next) {
							config = next;
							writeConfigFile(agentDir, config);
							ui.notify(
								`pi-chafa: saved cellWidth = ${config.cellWidth}`,
								"info",
							);
						} else {
							ui.notify(
								"pi-chafa: invalid cellWidth (must be positive integer)",
								"warning",
							);
						}
					}
				} else if (id === "maxRows") {
					const value = await ui.input(
						"New maxRows (row cap)",
						"integer row cap (e.g. 60)",
					);
					if (value !== undefined) {
						const next = applyMenuChange(config, "maxRows", value);
						if (next) {
							config = next;
							writeConfigFile(agentDir, config);
							ui.notify(`pi-chafa: saved maxRows = ${config.maxRows}`, "info");
						} else {
							ui.notify(
								"pi-chafa: invalid maxRows (must be positive integer)",
								"warning",
							);
						}
					}
				} else if (id === "symbolsSet") {
					const value = await ui.input(
						"New symbols set",
						"chafa --symbols class list (e.g. block+border)",
					);
					if (value !== undefined) {
						const next = applyMenuChange(config, "symbolsSet", value);
						if (next) {
							config = next;
							writeConfigFile(agentDir, config);
							ui.notify(
								`pi-chafa: saved symbolsSet = ${config.symbolsSet}`,
								"info",
							);
						} else {
							ui.notify(
								"pi-chafa: invalid symbolsSet (cannot be empty)",
								"warning",
							);
						}
					}
				} else if (id === "binaryPath") {
					const value = await ui.input(
						"Chafa binary path",
						"absolute path to chafa, or empty to clear",
					);
					if (value !== undefined) {
						const next = applyMenuChange(config, "binaryPath", value);
						if (next) {
							config = next;
							writeConfigFile(agentDir, config);
							ui.notify(
								config.binaryPath
									? `pi-chafa: saved binaryPath = ${config.binaryPath}`
									: "pi-chafa: cleared binaryPath (using system PATH)",
								"info",
							);
						}
					}
				}
			}
		}
	}

	// Fallback interface when ui.custom is not available: ui.select with descriptions & sub-selects
	for (;;) {
		const items = buildSettingItems(config);
		const options = items.map((item) => {
			if (item.id === "done" || item.id === "runtimeStatus") {
				return `${item.label} — ${item.description}`;
			}
			return `${item.label}: [${item.currentValue}] — ${item.description}`;
		});

		const choice = await ui.select("pi-chafa settings", options);
		if (!choice || choice.startsWith("Done")) return;

		if (choice.startsWith("Runtime status")) {
			const hostImages = readHostImageSettings(agentDir);
			const chafa = await probeToFact(config.binaryPath);
			const facts = collectRuntimeFacts(
				pi,
				getCapabilities().images,
				hostImages.showImages,
				chafa,
			);
			const statusOptions = [...describeRuntime(facts), "Close"];
			await ui.select("Runtime status (informational)", statusOptions);
			continue;
		}

		if (choice.startsWith("Prefer native")) {
			config.preferNative = !config.preferNative;
			writeConfigFile(agentDir, config);
			ui.notify(
				`pi-chafa: preferNative is now ${config.preferNative ? "true (native preferred)" : "false (symbols forced)"}`,
				"info",
			);
			continue;
		}

		if (choice.startsWith("Color mode")) {
			const picked = await ui.select("Select color mode", [...COLOR_MODES]);
			if (picked) {
				const next = applyMenuChange(config, "colors", picked);
				if (next) {
					config = next;
					writeConfigFile(agentDir, config);
					ui.notify(`pi-chafa: color mode is now ${config.colors}`, "info");
				}
			}
			continue;
		}

		if (choice.startsWith("Dither mode")) {
			const picked = await ui.select("Select dither mode", [...DITHER_MODES]);
			if (picked) {
				const next = applyMenuChange(config, "dither", picked);
				if (next) {
					config = next;
					writeConfigFile(agentDir, config);
					ui.notify(`pi-chafa: dither mode is now ${config.dither}`, "info");
				}
			}
			continue;
		}

		if (choice.startsWith("Symbols set")) {
			const symbolPresets = [
				"block+border",
				"block",
				"border",
				"ascii",
				"braille",
				"all",
				"Custom...",
			];
			const picked = await ui.select("Select symbols set", symbolPresets);
			if (picked === "Custom...") {
				const val = await ui.input(
					"Enter custom symbols set",
					"class list, e.g. block+border",
				);
				if (val) {
					const next = applyMenuChange(config, "symbolsSet", val);
					if (next) {
						config = next;
						writeConfigFile(agentDir, config);
						ui.notify(
							`pi-chafa: saved symbolsSet = ${config.symbolsSet}`,
							"info",
						);
					}
				}
			} else if (picked) {
				const next = applyMenuChange(config, "symbolsSet", picked);
				if (next) {
					config = next;
					writeConfigFile(agentDir, config);
					ui.notify(`pi-chafa: symbolsSet is now ${config.symbolsSet}`, "info");
				}
			}
			continue;
		}

		if (choice.startsWith("Cell width")) {
			const widthPresets = ["40", "50", "60", "80", "100", "120", "Custom..."];
			const picked = await ui.select(
				"Select cell width (columns)",
				widthPresets,
			);
			if (picked === "Custom...") {
				const val = await ui.input(
					"Enter custom cellWidth",
					"positive integer",
				);
				if (val) {
					const next = applyMenuChange(config, "cellWidth", val);
					if (next) {
						config = next;
						writeConfigFile(agentDir, config);
						ui.notify(`pi-chafa: cellWidth is now ${config.cellWidth}`, "info");
					}
				}
			} else if (picked) {
				const next = applyMenuChange(config, "cellWidth", picked);
				if (next) {
					config = next;
					writeConfigFile(agentDir, config);
					ui.notify(`pi-chafa: cellWidth is now ${config.cellWidth}`, "info");
				}
			}
			continue;
		}

		if (choice.startsWith("Max rows")) {
			const rowPresets = ["25", "35", "50", "75", "100", "Custom..."];
			const picked = await ui.select("Select max rows (row cap)", rowPresets);
			if (picked === "Custom...") {
				const val = await ui.input("Enter custom maxRows", "positive integer");
				if (val) {
					const next = applyMenuChange(config, "maxRows", val);
					if (next) {
						config = next;
						writeConfigFile(agentDir, config);
						ui.notify(`pi-chafa: maxRows is now ${config.maxRows}`, "info");
					}
				}
			} else if (picked) {
				const next = applyMenuChange(config, "maxRows", picked);
				if (next) {
					config = next;
					writeConfigFile(agentDir, config);
					ui.notify(`pi-chafa: maxRows is now ${config.maxRows}`, "info");
				}
			}
			continue;
		}

		if (choice.startsWith("Binary path")) {
			const val = await ui.input(
				"Chafa binary path",
				"absolute path, or empty to clear",
			);
			if (val !== undefined) {
				const next = applyMenuChange(config, "binaryPath", val);
				if (next) {
					config = next;
					writeConfigFile(agentDir, config);
					ui.notify(
						config.binaryPath
							? `pi-chafa: saved binaryPath = ${config.binaryPath}`
							: "pi-chafa: cleared binaryPath (using system PATH)",
						"info",
					);
				}
			}
		}
	}
}
