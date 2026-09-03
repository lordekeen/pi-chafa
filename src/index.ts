import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * pi-chafa extension entrypoint.
 * Registration of the show_image tool and /images command is added in the
 * wiring task; the bundled skills/pi-chafa/SKILL.md is auto-discovered from
 * the package's conventional skills/ directory (no code required).
 */
export default function piChafaExtension(_pi: ExtensionAPI): void {
	// registered in a later task
}
