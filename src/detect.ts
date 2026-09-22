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
 * Mimes the native path may emit as image blocks (#014/#015). Emitted image
 * blocks are persisted in session history and re-sent to providers on later
 * turns, so only the mimes both providers and the host renderer accept may
 * travel natively; everything else routes to chafa symbols or a per-file error.
 */
export const NATIVE_SAFE_MIMES: readonly string[] = [
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
];

/**
 * chafa loader name per recognized-but-unsafe mime. A `null` loader list means
 * the build did not report one — callers must attempt and let chafa report
 * rather than assume the loader is missing (#015).
 */
const MIME_LOADERS: Record<string, string> = {
	"image/svg+xml": "SVG",
	"image/avif": "AVIF",
	"image/bmp": "BMP",
	"image/x-icon": "ICO",
};

export type FileDelivery = "native" | "symbols" | "error";

export interface FileDeliveryInput {
	mime: string;
	/** Session delivery mode chosen by decideDelivery(). */
	mode: DeliveryMode;
	/** Per-call format override ("auto" when absent). */
	format: DeliveryFormat;
	/** chafa's reported loaders; null = unknown. */
	chafaLoaders: string[] | null;
}

export interface FileDeliveryPlan {
	delivery: FileDelivery;
	/** True when a native-capable session falls back to symbols for this file. */
	degraded?: boolean;
	/** Per-file note carrying a non-fatal degradation (spec §4.1.2 Note clause). */
	note?: string;
	/** Per-file, model-visible error text when delivery is "error" (spec §8). */
	error?: string;
}

/** The §8 wording for a mime that is not an image at all. */
export function unrecognizedMimeMessage(mime: string): string {
	return `not a recognized image format (${mime}); use format="symbols" to try rendering it with Chafa`;
}

/** Forced-native refusal for a recognized image mime that providers reject. */
export function nativeRefusalMessage(mime: string): string {
	if (!mime.startsWith("image/")) return unrecognizedMimeMessage(mime);
	return (
		`format="native" was requested but ${mime} cannot be delivered as a native image block: ` +
		`pi persists image blocks in session history and providers reject anything but png/jpeg/gif/webp ` +
		`on later turns. Use format="symbols" to render it with Chafa.`
	);
}

/** Note attached when a recognized-but-unsafe mime is rendered as ANSI art. */
export function symbolsDegradeNote(mime: string): string {
	const loader = MIME_LOADERS[mime];
	return loader
		? `showing ${loader} as ANSI art; native ${loader} preview needs a rasterizer`
		: `showing ${mime} as ANSI art; it has no native image-block path`;
}

/** Per-file error when the local chafa build cannot decode a recognized format. */
export function missingLoaderMessage(mime: string, loader: string): string {
	return (
		`chafa cannot decode ${mime} on this system: its build has no ${loader} loader. ` +
		`Convert the file to PNG, or install a chafa built with ${loader} support.`
	);
}

/**
 * Per-file delivery decision (#014/#015). Pure: mime, session mode, format
 * override and chafa's loader list in; route + rationale out.
 *
 * The invariant this encodes: **native is only ever chosen for a
 * NATIVE_SAFE_MIMES entry**, on any combination of inputs.
 */
export function decideFileDelivery(input: FileDeliveryInput): FileDeliveryPlan {
	const { mime, mode, format, chafaLoaders } = input;
	const loader = MIME_LOADERS[mime] ?? null;
	const loaderMissing =
		loader !== null && chafaLoaders !== null && !chafaLoaders.includes(loader);

	if (mode === "native") {
		if (NATIVE_SAFE_MIMES.includes(mime)) return { delivery: "native" };
		// The model forced native on a session that *could* render natively:
		// refusing is the only honest answer — an unsupported block is dropped by
		// the host at best and poisons provider history at worst (spec §7.4).
		if (format === "native") {
			return { delivery: "error", error: nativeRefusalMessage(mime) };
		}
		if (!mime.startsWith("image/")) {
			return { delivery: "error", error: unrecognizedMimeMessage(mime) };
		}
		if (loaderMissing) {
			return {
				delivery: "error",
				error: missingLoaderMessage(mime, loader as string),
			};
		}
		return {
			delivery: "symbols",
			degraded: true,
			note: symbolsDegradeNote(mime),
		};
	}

	// mode === "symbols": chafa is the delivery mechanism, so a known-missing
	// loader is fatal for this file; otherwise attempt (including unknown loaders,
	// and including an unrecognized mime — chafa is format-flexible).
	if (loaderMissing) {
		return {
			delivery: "error",
			error: missingLoaderMessage(mime, loader as string),
		};
	}
	return { delivery: "symbols" };
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
