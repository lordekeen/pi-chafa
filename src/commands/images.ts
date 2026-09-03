import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { getCapabilities } from "@earendil-works/pi-tui";
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
 * Apply one wizard choice to the in-memory config. Returns null when the
 * choice is unknown or the value is invalid (the caller re-prompts).
 */
export function applyMenuChange(
	current: ChafaConfig,
	choice: string,
	value: string,
): ChafaConfig | null {
	switch (choice) {
		case "Change cellWidth": {
			const parsed = parsePositiveInt(value.trim());
			return parsed === undefined ? null : { ...current, cellWidth: parsed };
		}
		case "Change colors": {
			const trimmed = value.trim() as ColorsMode;
			if (!(COLOR_MODES as readonly string[]).includes(trimmed)) return null;
			return { ...current, colors: trimmed };
		}
		case "Change symbols set": {
			const trimmed = value.trim();
			return trimmed === "" ? null : { ...current, symbolsSet: trimmed };
		}
		case "Change dither": {
			const trimmed = value.trim() as DitherMode;
			if (!(DITHER_MODES as readonly string[]).includes(trimmed)) return null;
			return { ...current, dither: trimmed };
		}
		case "Change maxRows": {
			const parsed = parsePositiveInt(value.trim());
			return parsed === undefined ? null : { ...current, maxRows: parsed };
		}
		case "Toggle preferNative":
			return { ...current, preferNative: !current.preferNative };
		case "Set chafa binary path": {
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

/**
 * Interactive wizard: pick a setting, enter a value, persist immediately
 * (spec §4.2). The pure helpers above are unit-tested; the ui-driven loop is
 * covered by the Task 11 manual smoke.
 */
export async function runImagesCommand(
	pi: Pick<ExtensionAPI, "getAllTools">,
	_args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const ui = ctx.ui;
	const agentDir = getConfigDir();
	let config = loadConfig(agentDir);

	for (;;) {
		const choice = await ui.select("pi-chafa settings", [...MENU]);
		if (!choice || choice === "Done") return;

		if (choice === "Runtime status") {
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

		if (choice === "Toggle preferNative") {
			const next = applyMenuChange(config, choice, "");
			if (next === null) continue;
			config = next;
			writeConfigFile(agentDir, config);
			ui.notify(
				`pi-chafa: preferNative is now ${config.preferNative ? "true (native preferred)" : "false (symbols forced)"}`,
				"info",
			);
			continue;
		}

		const hint =
			choice === "Change cellWidth"
				? "integer columns (default 60)"
				: choice === "Change colors"
					? `one of ${COLOR_MODES.join(", ")}`
					: choice === "Change symbols set"
						? "chafa --symbols class list, e.g. block+border or ascii"
						: choice === "Change dither"
							? `one of ${DITHER_MODES.join(", ")}`
							: choice === "Change maxRows"
								? "integer row cap (default 50)"
								: "absolute path to a chafa binary, or empty to clear";
		const value = await ui.input(`New value — ${choice}`, hint);
		if (value === undefined) continue;
		const next = applyMenuChange(config, choice, value);
		if (next === null) {
			ui.notify(`pi-chafa: invalid value for ${choice}`, "warning");
			continue;
		}
		config = next;
		writeConfigFile(agentDir, config);
		ui.notify(`pi-chafa: saved ${choice.toLowerCase()}`, "info");
	}
}
