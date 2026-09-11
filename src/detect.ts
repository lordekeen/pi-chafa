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
 * Normalize a protocol-ish value coming from pi settings (`terminal.images`)
 * or the environment (`PI_IMAGE_PROTOCOL`) to a native capability. Anything
 * other than "kitty"/"iterm2" — including false, "auto", "none", absent —
 * means "no override".
 */
function asNativeProtocol(value: unknown): AgentCapsImages {
	return value === "kitty" || value === "iterm2" ? value : null;
}

/**
 * Resolve the effective native-image capability with an instance-independent
 * fallback ladder (spec §7.1 step 3). Priority:
 * 1. pi-tui `getCapabilities().images` when non-null (host truth).
 * 2. pi settings `terminal.images` ("kitty"/"iterm2"; false/"auto"/absent/
 *    unrecognised → no override, which also covers a user disabling images).
 * 3. `PI_IMAGE_PROTOCOL` when it names "kitty"/"iterm2"; otherwise no override.
 * 4. `null`.
 *
 * Pure: all three sources are parameters, so it is testable headlessly and
 * does not depend on which pi-tui module instance happens to be bound (the
 * dual-instance hazard that made `getCapabilities().images` report `null`).
 */
export function resolveCapsImages(
	caps: AgentCapsImages,
	hostImages: unknown,
	envProtocol: string | undefined,
): AgentCapsImages {
	if (caps !== null) return caps;
	const fromHost = asNativeProtocol(hostImages);
	if (fromHost !== null) return fromHost;
	return asNativeProtocol(
		typeof envProtocol === "string" ? envProtocol.trim() : envProtocol,
	);
}

/**
 * Decide native vs symbols delivery (spec §5.1, §7.2 decision table).
 * Pure: capabilities + host flag + config + per-call override in, DeliveryMode out.
 * A forced format=native errors only when the session is not native-capable;
 * a native-capable host with images off degrades to symbols (spec §7.2 row 3, §8)
 * rather than returning image blocks the host would suppress.
 */
export function decideDelivery(input: DeliveryInput): DeliveryMode {
	const { capsImages, showImages, preferNative, format } = input;
	const nativeCapable = capsImages === "kitty" || capsImages === "iterm2";

	if (format === "native") {
		if (!nativeCapable) {
			throw new Error(
				`format=native was requested but this session cannot render native images ` +
					`(detected protocol: ${capsImages ?? "none"}). ` +
					`Use format=symbols, or fix terminal detection (PI_IMAGE_PROTOCOL / terminal.images).`,
			);
		}
		// Capable terminal, but the host has images off: fall through to symbols
		// (spec §7.2 row 3, §8) instead of emitting blocks the host suppresses.
		return showImages ? "native" : "symbols";
	}
	if (format === "symbols") return "symbols";

	// format === "auto"
	if (!nativeCapable) return "symbols";
	if (!showImages) return "symbols"; // host won't render blocks; never emit protocols it suppresses
	return preferNative ? "native" : "symbols";
}
