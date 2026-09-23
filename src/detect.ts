import type { AgentCapsImages, DeliveryFormat, DeliveryMode } from "./types.js";

export interface DeliveryInput {
	capsImages: AgentCapsImages;
	/** Host terminal.showImages flag (read from pi settings; default true). */
	showImages: boolean;
	/** Config preferNative (default true). */
	preferNative: boolean;
	/** Per-call format override ("auto" when absent). */
	format: DeliveryFormat;
	/**
	 * Environment + platform only sharpen the forced-native error hint (#030);
	 * the decision itself comes from the already-resolved capabilities.
	 */
	env?: ImageEnv;
	platform?: string;
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

/** Environment slice the capability ladder reads (a `process.env`-compatible record). */
export type ImageEnv = Record<string, string | undefined>;

/** Truthy env marker — pi-tui checks values, not mere presence. */
function envSet(env: ImageEnv, name: string): boolean {
	return Boolean(env[name]);
}

/**
 * Positive image-protocol markers, mirroring pi-tui 0.84.4's detection order:
 * they are checked before the negative table there, so a genuine protocol
 * terminal (e.g. WezTerm on Windows, which also sets `WT_SESSION`) is never
 * denied by an ambient negative marker.
 */
function hasPositiveImageMarker(env: ImageEnv): boolean {
	const termProgram = (env.TERM_PROGRAM ?? "").toLowerCase();
	const term = (env.TERM ?? "").toLowerCase();
	return (
		envSet(env, "KITTY_WINDOW_ID") ||
		termProgram === "kitty" ||
		termProgram === "ghostty" ||
		term.includes("ghostty") ||
		envSet(env, "GHOSTTY_RESOURCES_DIR") ||
		envSet(env, "WEZTERM_PANE") ||
		termProgram === "wezterm" ||
		termProgram === "warpterminal" ||
		envSet(env, "WARP_SESSION_ID") ||
		envSet(env, "WARP_TERMINAL_SESSION_UUID") ||
		envSet(env, "ITERM_SESSION_ID") ||
		termProgram === "iterm.app"
	);
}

/** True when the environment is tmux (matches pi-tui 0.84.4's `TMUX`/`TERM` check). */
export function isTmux(env: ImageEnv): boolean {
	return (
		envSet(env, "TMUX") || (env.TERM ?? "").toLowerCase().startsWith("tmux")
	);
}

/**
 * Terminals pi-tui 0.84.4 positively knows cannot render image protocols
 * (#026), plus the Linux Alacritty markers pi-tui misses (it keys Alacritty on
 * `TERM_PROGRAM`, which Linux Alacritty does not set). Pure: `env` and
 * `platform` in, decision out.
 *
 * `TERM=screen*` is denied before the positive markers, exactly as pi-tui does
 * (GNU screen does not forward kitty sequences). Unknown terminals are
 * deliberately **not** denied, so declared protocols stay the escape hatch
 * (e.g. Konsole). tmux is classified by `isTmux` instead: it can forward kitty
 * sequences with `allow-passthrough on`, so the ladder keeps
 * `PI_IMAGE_PROTOCOL` as an explicit opt-in there.
 */
/**
 * Positive evidence that the *outer* terminal cannot render image protocols,
 * independent of tmux: a marker or program name that survives into the pane's
 * environment (tmux inherits the server's environment, so an `ALACRITTY_*`
 * marker describes the terminal the art would actually land on). `TERM` is
 * deliberately not consulted here — under tmux it names the pane's emulation
 * (`screen*`/`tmux*`), not the terminal pi is drawn on; `knownNoImageSupport`
 * owns the `TERM=screen*` rule.
 */
function outerTerminalDenied(env: ImageEnv, platform: string): boolean {
	if (hasPositiveImageMarker(env)) return false;
	const termProgram = (env.TERM_PROGRAM ?? "").toLowerCase();
	const terminalEmulator = (env.TERMINAL_EMULATOR ?? "").toLowerCase();
	if (envSet(env, "WT_SESSION")) return true;
	if (
		termProgram === "alacritty" ||
		termProgram === "vscode" ||
		termProgram === "zed"
	) {
		return true;
	}
	if (terminalEmulator === "jetbrains-jediterm") return true;
	if (
		envSet(env, "ALACRITTY_LOG") ||
		envSet(env, "ALACRITTY_WINDOW_ID") ||
		envSet(env, "ALACRITTY_SOCKET")
	) {
		return true;
	}
	if (platform === "win32") return true;
	return false;
}

/**
 * The full #026 negative table. `TERM=screen*` is checked before the positive
 * markers, exactly as pi-tui does — and that rule is why the tmux branch of the
 * ladder must not consult this predicate: tmux's upstream default `TERM` is
 * `screen*`, so applying it inside a pane would deny every default tmux (#031).
 */
export function knownNoImageSupport(env: ImageEnv, platform: string): boolean {
	const term = (env.TERM ?? "").toLowerCase();
	if (term.startsWith("screen")) return true;
	return outerTerminalDenied(env, platform);
}

/**
 * Resolve the effective native-image capability with an instance-independent
 * fallback ladder (spec §7.1 step 3). Priority:
 * 1. **Environment guard (#026):** an environment that positively cannot
 *    render image protocols returns `null` before any declaration is read;
 *    under tmux the ambient declarations are ignored but `PI_IMAGE_PROTOCOL`
 *    remains an explicit opt-in — marker-based denials still outvote it (#031).
 * 2. pi-tui `getCapabilities().images` when non-null (host truth).
 * 3. pi settings `terminal.images` ("kitty"/"iterm2"; false/"auto"/absent/
 *    unrecognised → no override, which also covers a user disabling images).
 * 4. `PI_IMAGE_PROTOCOL` when it names "kitty"/"iterm2"; otherwise no override.
 * 5. `null`.
 *
 * Pure: all sources are parameters, so it is testable headlessly and does not
 * depend on which pi-tui module instance happens to be bound (the
 * dual-instance hazard that made `getCapabilities().images` report `null`).
 */
export function resolveCapsImages(
	caps: AgentCapsImages,
	hostImages: unknown,
	envProtocol: string | undefined,
	env: ImageEnv = {},
	platform: string = "",
): AgentCapsImages {
	// The empty defaults exist for hermetic tests: with no environment there is
	// nothing to deny, so the guard is *off*. Production callers must pass the
	// real env/platform (both defaultDeps and /images do).
	const fromEnv = asNativeProtocol(
		typeof envProtocol === "string" ? envProtocol.trim() : envProtocol,
	);
	if (isTmux(env)) {
		// tmux can forward kitty sequences only with `allow-passthrough on`, so the
		// explicit per-session env override stays an opt-in; the ambient
		// declarations (host caps from setCapabilityOverrides and the persistent
		// terminal.images setting) are what produce blank output and are not
		// trusted (#026). Positive evidence that the outer terminal cannot render
		// still wins over the opt-in (#031): tmux inherits the server's
		// environment, so an `ALACRITTY_*`/`WT_SESSION`/VS Code marker describes the
		// terminal the art would actually land on. The `TERM=screen*` rule is
		// excluded here on purpose — tmux's own default `TERM` is `screen*`.
		if (outerTerminalDenied(env, platform)) return null;
		return fromEnv;
	}
	if (knownNoImageSupport(env, platform)) return null;
	if (caps !== null) return caps;
	const fromHost = asNativeProtocol(hostImages);
	if (fromHost !== null) return fromHost;
	return fromEnv;
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
 * The forced-`format=native` refusal, worded for the actual environment so the
 * suggested fix can work there (#030): tmux ignores ambient declarations, a
 * known-incapable terminal cannot be fixed by a setting at all, and anything
 * else keeps the generic advice. Every variant keeps the "cannot render native
 * images" phrase the smoke suite asserts. The order mirrors the ladder
 * exactly, so the hint never contradicts the classification that produced it:
 * a tmux pane whose outer terminal is positively denied gets the
 * incapable-terminal answer, while a plain tmux pane (even with the upstream
 * `TERM=screen*` default) gets the opt-in answer (#031).
 */
function nativeUnavailableMessage(
	capsImages: AgentCapsImages,
	env: ImageEnv = {},
	platform: string = "",
): string {
	const head =
		`format=native was requested but this session cannot render native images ` +
		`(detected protocol: ${capsImages ?? "none"}). `;
	if (isTmux(env) && !outerTerminalDenied(env, platform)) {
		return (
			head +
			"Under tmux, pi's ambient declarations are ignored — export " +
			"PI_IMAGE_PROTOCOL=kitty before launching pi (with tmux " +
			"allow-passthrough on) to opt in explicitly, or use format=symbols."
		);
	}
	if (knownNoImageSupport(env, platform)) {
		return (
			head +
			"This terminal is known not to support image protocols — use " +
			"format=symbols, or run pi in a kitty/iTerm2-capable terminal."
		);
	}
	return (
		head +
		"Use format=symbols, or set PI_IMAGE_PROTOCOL or pi's terminal.images setting."
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
				nativeUnavailableMessage(capsImages, input.env, input.platform),
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
