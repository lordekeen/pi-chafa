/** Shared types for the pi-chafa extension. No runtime dependencies. */

/** Chafa --colors modes exposed by pi-chafa (spec §4.1.1 / §6.1). */
export const COLOR_MODES = [
	"none",
	"2",
	"8",
	"16",
	"240",
	"256",
	"full",
] as const;
export type ColorsMode = (typeof COLOR_MODES)[number];

/** Chafa --dither modes (spec §4.1.1 / §6.1). */
export const DITHER_MODES = ["none", "ordered", "diffusion", "noise"] as const;
export type DitherMode = (typeof DITHER_MODES)[number];

/** Per-invocation delivery format override values (spec §4.1.1). */
export const DELIVERY_FORMATS = ["auto", "native", "symbols"] as const;
export type DeliveryFormat = (typeof DELIVERY_FORMATS)[number];

/** Delivery modes the extension can choose (spec §5.3, §7.2). */
export type DeliveryMode = "native" | "symbols";

/** Value of getCapabilities().images (verified 0.84.4 pi-tui). */
export type AgentCapsImages = "kitty" | "iterm2" | null;

/** Parsed chafa --version, e.g. { major: 1, minor: 18 } for "1.18.2". */
export interface ChafaVersion {
	major: number;
	minor: number;
}

/** The resolved chafa binary + parsed version. */
export interface ChafaProbe {
	binary: string;
	version: ChafaVersion;
}

/**
 * Persistent config, mirroring ~/.pi/agent/pi-chafa.json (spec §6.1).
 * `version` is the top-level config schema version (spec §12).
 */
export interface ChafaConfig {
	version: number;
	preferNative: boolean;
	cellWidth: number;
	maxRows: number;
	colors: ColorsMode;
	symbolsSet: string;
	dither: DitherMode;
	formatOrder: DeliveryMode[];
	binaryPath: string | null;
	timeoutMs: number;
}

/** Per-invocation tool params that layer above env/file/defaults (spec §4.1.1, §6.3). */
export interface ChafaOverrides {
	format?: DeliveryFormat;
	cellWidth?: number;
	colors?: ColorsMode;
	symbolsSet?: string;
	dither?: DitherMode;
}

/** Symbols-path effective settings after precedence resolution (spec §6.3). */
export interface EffectiveSymbolsSettings {
	cellWidth: number;
	maxRows: number;
	colors: ColorsMode;
	symbolsSet: string;
	dither: DitherMode;
	timeoutMs: number;
	binaryPath: string | null;
}

/** Fully resolved per-call configuration (Task 3 produces this). */
export interface ResolvedConfig {
	preferNative: boolean;
	formatOrder: DeliveryMode[];
	symbols: EffectiveSymbolsSettings;
}

/** Host image state pi-chafa reads (never writes) from pi settings (spec §6.4). */
export interface HostImageSettings {
	showImages: boolean;
	imageWidthCells: number;
	/**
	 * `terminal.images` protocol override, normalized: `"kitty"` / `"iterm2"`,
	 * else `null` for `false` / `"auto"` / absent / unrecognised (spec §6.4).
	 */
	images: AgentCapsImages;
}

/** Per-file outcome recorded in tool details (spec §5.3). */
export interface ShowImageFile {
	/** Absolute path of the file. */
	path: string;
	ok: boolean;
	/** Delivery used for this file, or "none" for no-UI sessions. */
	mode: DeliveryMode | "none";
	mimeType?: string;
	byteSize?: number;
	/** Failure/limitation note, when any. */
	note?: string;
}

/** The Chafa symbols knobs shared by the resolved config and the details snapshot (spec §6.3, §7.1). */
export type SymbolsKnobs = Pick<
	EffectiveSymbolsSettings,
	"cellWidth" | "maxRows" | "colors" | "symbolsSet" | "dither"
>;

/** Effective settings snapshot recorded in details for renderers/transcript (spec §7.1 step 2/5). */
export interface ShowImageSettings extends SymbolsKnobs {
	format: DeliveryFormat;
	preferNative: boolean;
}

/** Structured details for the show_image tool result (spec §4.1.2, §7.3). */
export interface ShowImageDetails {
	/** Delivery used across the invocation; "none" only in no-UI sessions. */
	mode: DeliveryMode | "none";
	files: ShowImageFile[];
	/** Cleaned Chafa ANSI payload for symbols mode; absent otherwise (spec §7.3). */
	payload?: string;
	settings: ShowImageSettings;
}
