import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import {
	resolveSettingKey,
	runImagesCommand,
	SETTING_ARG_VALUES,
	SETTING_KEYS,
	settingArgSummary,
} from "./commands/images.js";
import { buildShowImageTool } from "./show-image.js";

/**
 * Argument completion for `/images` (#050): the subcommand and every setting key
 * before the first space, then that key's value ladder after it. Items carry the
 * *whole* argument text, because the host replaces the whole argument prefix with
 * the accepted item's `value` (pi-tui autocomplete.js applyCompletion).
 */
function completeImagesArgument(prefix: string): AutocompleteItem[] {
	const text = prefix.trimStart();
	const at = text.search(/\s/);
	if (at === -1) {
		return [
			{
				value: "status",
				label: "status",
				description: "Print the runtime facts without opening the panel",
			},
			...SETTING_KEYS.map((key) => ({
				value: key,
				label: key,
				description: settingArgSummary(key),
			})),
		].filter((item) => item.value.toLowerCase().startsWith(text.toLowerCase()));
	}
	const canonical = resolveSettingKey(text.slice(0, at));
	if (!canonical) return [];
	// Trim like the parser does (splitSettingArg): the host forwards the argument
	// text verbatim, so `colors  8` (an extra space, a pasted tab) would otherwise
	// complete to nothing even though the command accepts it (#063).
	const typed = text
		.slice(at + 1)
		.trim()
		.toLowerCase();
	return (SETTING_ARG_VALUES[canonical] ?? [])
		.filter((value) => value.toLowerCase().startsWith(typed))
		.map((value) => ({ value: `${canonical} ${value}`, label: value }));
}

/**
 * pi-chafa extension entrypoint.
 * - registers the show_image tool (Task 7/8 definition)
 * - registers the /images slash command (Task 9)
 * The bundled skills/pi-chafa/SKILL.md is auto-discovered from the package's
 * conventional skills/ directory — no active wiring (spec §5.3).
 */
export default function piChafaExtension(pi: ExtensionAPI): void {
	pi.registerTool(buildShowImageTool());
	pi.registerCommand("images", {
		description:
			"Tune pi-chafa defaults and inspect runtime image/terminal status",
		handler: (args, ctx) => runImagesCommand(pi, args, ctx),
		// #050: the first token completes to `status` or a setting key, the second to
		// that key's values — so the grammar is discoverable without the panel.
		getArgumentCompletions: completeImagesArgument,
	});
}
