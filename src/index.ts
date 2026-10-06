import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { runImagesCommand } from "./commands/images.js";
import { buildShowImageTool } from "./show-image.js";

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
		// #041: `status` is the only accepted argument; an empty prefix offers it,
		// any other input matches nothing ([] = no suggestions, host contract).
		getArgumentCompletions: (prefix: string): AutocompleteItem[] =>
			prefix.trim() === "" ? [{ value: "status", label: "status" }] : [],
	});
}
