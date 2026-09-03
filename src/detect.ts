import type { AgentCapsImages, DeliveryFormat, DeliveryMode } from "./types.js";

export interface DeliveryInput {
	capsImages: AgentCapsImages;
	/** Host terminal.showImages flag (read from pi settings; default true). */
	showImages: boolean;
	/** Config preferNative (default true). */
	preferNative: boolean;
	/** Per-call format override ("auto" when absent). */
	format: DeliveryFormat;
}

/**
 * Decide native vs symbols delivery (spec §5.1, §7.2 decision table).
 * Pure: capabilities + host flag + config + per-call override in, DeliveryMode out.
 * Never silently degrades a forced format=native.
 */
export function decideDelivery(input: DeliveryInput): DeliveryMode {
	const { capsImages, showImages, preferNative, format } = input;
	const nativeCapable = capsImages === "kitty" || capsImages === "iterm2";

	if (format === "native") {
		if (!nativeCapable || !showImages) {
			throw new Error(
				`format=native was requested but this session cannot render native images ` +
					`(detected protocol: ${capsImages ?? "none"}; host showImages: ${showImages ? "on" : "off"}). ` +
					`Use format=symbols, or fix terminal detection (PI_IMAGE_PROTOCOL / terminal.images) and enable images.`,
			);
		}
		return "native";
	}
	if (format === "symbols") return "symbols";

	// format === "auto"
	if (!nativeCapable) return "symbols";
	if (!showImages) return "symbols"; // host won't render blocks; never emit protocols it suppresses
	return preferNative ? "native" : "symbols";
}
