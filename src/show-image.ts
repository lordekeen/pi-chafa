import type {
	AgentToolResult,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	getCapabilities,
	Spacer,
	Text,
} from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import {
	buildSymbolsArgs,
	cleanSymbolsPayload,
	createCachedProbe,
	runChafa,
} from "./chafa.js";
import { readHostImageSettings, resolveConfig } from "./config.js";
import {
	decideDelivery,
	decideFileDelivery,
	NATIVE_SAFE_MIMES,
	resolveCapsImages,
} from "./detect.js";
import { expandTargets, readBytes, sniffMime } from "./images.js";
import type {
	AgentCapsImages,
	ChafaOverrides,
	ChafaProbe,
	DeliveryMode,
	HostImageSettings,
	ResolvedConfig,
	ShowImageDetails,
	ShowImageFile,
	ShowImageSettings,
} from "./types.js";

/** Parameter schema (spec §4.1.1) — TypeBox, per host 0.84.4 conventions. */
export const showImageParams = Type.Object(
	{
		path: Type.Optional(
			Type.String({
				description:
					"A single image file path, absolute or relative to the working directory.",
			}),
		),
		glob: Type.Optional(
			Type.String({
				description:
					"A glob pattern relative to the working directory, e.g. screenshots/*.png.",
			}),
		),
		format: Type.Optional(
			Type.Union([
				Type.Literal("auto"),
				Type.Literal("native"),
				Type.Literal("symbols"),
			]),
		),
		cellWidth: Type.Optional(Type.Integer({ minimum: 1 })),
		colors: Type.Optional(
			Type.Union([
				Type.Literal("none"),
				Type.Literal("2"),
				Type.Literal("8"),
				Type.Literal("16"),
				Type.Literal("240"),
				Type.Literal("256"),
				Type.Literal("full"),
			]),
		),
		symbolsSet: Type.Optional(Type.String()),
		dither: Type.Optional(
			Type.Union([
				Type.Literal("none"),
				Type.Literal("ordered"),
				Type.Literal("diffusion"),
				Type.Literal("noise"),
			]),
		),
	},
	{ additionalProperties: false },
);

export type ShowImageParams = Static<typeof showImageParams>;

/** Injectable seams so execute() is testable without a terminal, chafa, or config file (spec §5.3). */
export interface ShowImageDeps {
	resolveConfig: (overrides: ChafaOverrides) => ResolvedConfig;
	readHostImages: () => HostImageSettings;
	capsImages: () => AgentCapsImages;
	expandTargets: (target: string, cwd: string) => string[];
	readBytes: (filePath: string) => Promise<Buffer>;
	sniffMime: (bytes: Buffer) => string;
	probeChafa: (
		binaryPath: string | null,
		signal?: AbortSignal,
	) => Promise<ChafaProbe>;
	runChafa: (
		binary: string,
		args: string[],
		opts: { timeoutMs: number; signal?: AbortSignal },
	) => Promise<string>;
	cleanPayload: (raw: string) => string;
	/** Live viewport width in columns, when known (#011). */
	terminalColumns: () => number | undefined;
}

function defaultDeps(): ShowImageDeps {
	// One success-only probe cache per tool instance (#007): repeat invocations
	// in a session never respawn `chafa --version`, while a failed probe is
	// retried so a missing-then-installed chafa recovers.
	const cachedProbe = createCachedProbe();
	return {
		resolveConfig,
		readHostImages: readHostImageSettings,
		// Instance-independent capability ladder (spec §7.1 step 3): the host's
		// pi-tui `getCapabilities()` is preferred, then pi's own `terminal.images`
		// setting, then `PI_IMAGE_PROTOCOL`. This keeps the default native path
		// reachable when pi-chafa binds its own pi-tui instance and never receives
		// the host's `setCapabilityOverrides()`.
		capsImages: () =>
			resolveCapsImages(
				getCapabilities().images,
				readHostImageSettings().images,
				process.env.PI_IMAGE_PROTOCOL,
				process.env,
				process.platform,
			),
		expandTargets,
		readBytes,
		sniffMime,
		probeChafa: (binaryPath, signal) => cachedProbe(binaryPath, signal),
		runChafa,
		cleanPayload: cleanSymbolsPayload,
		// Mirrors pi-tui's own source: the TTY width, else COLUMNS, else unknown.
		terminalColumns: () => {
			const cols = process.stdout.columns || Number(process.env.COLUMNS);
			return Number.isFinite(cols) && cols > 0 ? cols : undefined;
		},
	};
}

function basenameOf(filePath: string): string {
	const normalized = filePath.replaceAll("\\", "/");
	return normalized.slice(normalized.lastIndexOf("/") + 1);
}

// Strip control characters and ANSI escape sequences from path-derived strings
// before they reach Text/content text (terminal-injection guard). A filename or
// path arg carrying an ESC (or other C0/DEL byte) must never reach the terminal
// verbatim. Built via `new RegExp` from string constants for the same reason as
// the cleaner regexes in chafa.ts: the committed biome gate flags
// control-character escapes inside regex literals
// (lint/suspicious/noControlCharactersInRegex), and its --fix would inline a
// `new RegExp(<static string>)` back into a literal.
const ESC = "\x1b";
const CONTROL_CHARS = "[\x00-\x1f\x7f]";
const CONTROL_RE = new RegExp(CONTROL_CHARS, "g");
const CSI_RE = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, "g");

/** Strip control characters and ANSI escapes from path/label-derived text (AGENTS.md invariant 3). */
export function stripControls(s: string): string {
	return s.replace(CSI_RE, "").replace(CONTROL_RE, "");
}

/**
 * Build an abort-shaped error a caller can classify (AGENTS.md invariant 4;
 * DESIGN.md §4 chose AbortError propagation). Prefers the signal's own reason
 * when it is an Error (Node's DOMException AbortError carries name + code).
 */
function abortError(signal: AbortSignal | undefined): Error {
	const reason = signal?.reason;
	if (reason instanceof Error) return reason;
	const err = new Error("show_image was aborted") as Error & { code?: string };
	err.name = "AbortError";
	err.code = "ABORT_ERR";
	return err;
}

/** Effective-settings snapshot recorded in details for renderers/transcript (spec §7.1 steps 2/5). */
function settingsRecord(
	resolved: ResolvedConfig,
	overrides: ChafaOverrides,
	// #021: the live width clamp means the width that was rendered can differ
	// from the configured one; callers on the symbols path pass the effective
	// value so the snapshot never overstates what chafa was asked for.
	cellWidth: number = resolved.symbols.cellWidth,
): ShowImageSettings {
	return {
		format: overrides.format ?? "auto",
		cellWidth,
		maxRows: resolved.symbols.maxRows,
		colors: resolved.symbols.colors,
		symbolsSet: resolved.symbols.symbolsSet,
		dither: resolved.symbols.dither,
		preferNative: resolved.preferNative,
	};
}

/** Model-visible result text (spec §4.1.2). Exact wording locked in this task (open question 5). */
export function summaryText(
	files: ShowImageFile[],
	mode: DeliveryMode | "none",
): string {
	const shown = files.filter((file) => file.ok);
	const failed = files.length - shown.length;
	const firstPath = (shown[0] ?? files[0])?.path ?? "";
	const name = stripControls(basenameOf(firstPath));
	// The delivery phrase describes the files actually shown, never the session
	// mode: a native session degrades SVG/BMP/ICO/AVIF to symbols (#014/#015),
	// and a header claiming terminal-native rendering for ANSI art would
	// contradict the degrade note in the same sentence (#024). `mode` is only
	// the fallback when no file carries a delivery mode (empty run).
	const nativeShown = shown.filter((file) => file.mode === "native").length;
	const symbolsShown = shown.filter((file) => file.mode === "symbols").length;
	let label: string;
	if (nativeShown > 0 && symbolsShown > 0) {
		label = `via mixed delivery (${nativeShown} native, ${symbolsShown} as ANSI art)`;
	} else if (nativeShown > 0) {
		label = "via terminal-native rendering";
	} else if (symbolsShown > 0) {
		label = "as ANSI art";
	} else {
		label = mode === "native" ? "via terminal-native rendering" : "as ANSI art";
	}

	// Shown-file notes (unknown mime, no output, maxRows cap) belong on the
	// model-visible surface (spec §8). Sanitize (AGENTS.md invariant 3),
	// de-duplicate, and join them in insertion order (spec §4.1.2).
	const notes = [
		...new Set(
			shown
				.map((file) => (file.note ? stripControls(file.note) : ""))
				.filter((note) => note !== ""),
		),
	];
	const noteClause = notes.length > 0 ? ` Note: ${notes.join("; ")}.` : "";

	if (mode === "none") {
		const head =
			files.length <= 1
				? `Showed image ${name} to the user`
				: `Showed ${files.length} image(s) to the user`;
		return `${head} [image display unavailable in this session].${noteClause}`;
	}
	const head =
		files.length <= 1
			? `Showed image ${name} to the user ${label}`
			: failed > 0
				? `Showed ${shown.length} of ${files.length} image(s) to the user ${label}`
				: `Showed ${files.length} image(s) to the user ${label}`;
	const tail = failed > 0 ? ` ${failed} file(s) could not be shown.` : "";
	return `${head}.${tail}${noteClause}`;
}

/** Flatten the text blocks of a result — reused by the renderers (Task 8). */
export function textFromContent(
	content: AgentToolResult<ShowImageDetails>["content"],
): string {
	const texts: string[] = [];
	for (const block of content) {
		if (block.type === "text") texts.push(block.text);
	}
	return texts.join("\n");
}

/**
 * pi-tui theme subset the renderers use (spec §4.1.3). Structural, so tests can
 * inject an identity or recording theme without a real pi theme instance.
 */
export interface RenderThemeLike {
	bg(
		color: "toolPendingBg" | "toolSuccessBg" | "toolErrorBg",
		text: string,
	): string;
}

/** pi render-context subset the renderers use (a `ToolRenderContext` slice). */
export interface RenderStateLike {
	isPartial: boolean;
	isError: boolean;
}

/**
 * The row's state background, mirroring pi's own `ToolExecutionComponent`
 * (pending → `toolPendingBg`, error → `toolErrorBg`, settled → `toolSuccessBg`).
 */
function stateBgFn(
	theme: RenderThemeLike,
	context: RenderStateLike,
): (text: string) => string {
	const color = context.isPartial
		? "toolPendingBg"
		: context.isError
			? "toolErrorBg"
			: "toolSuccessBg";
	return (text) => theme.bg(color, text);
}

/**
 * A full-width themed blank row — what pi's default shell draws as its
 * `Box(paddingY=1)` top/bottom padding. `renderShell: "self"` has to reproduce
 * those rows so the themed header strip keeps the host's shape (#027).
 */
function themedBlankLine(bg: (text: string) => string): Component {
	return {
		render: (width: number) => [bg(" ".repeat(Math.max(1, width)))],
		invalidate: () => {},
	};
}

/**
 * renderCall: compact "Show Image <target>" (spec §4.1 registration table).
 * The tool uses `renderShell: "self"`, so the call paints its own themed header
 * strip — see `renderShowResult` for why (#027).
 */
export function renderShowCall(
	args: ShowImageParams,
	theme: RenderThemeLike,
	context: RenderStateLike,
): Container {
	const target = stripControls((args.path ?? args.glob ?? "").trim());
	const bg = stateBgFn(theme, context);
	const header = new Container();
	header.addChild(themedBlankLine(bg));
	header.addChild(new Text(`Show Image ${target}`, 1, 0, bg));
	return header;
}

/**
 * renderResult: single component for both delivery modes (spec §4.1.3).
 * - symbols: themed caption strip, then the ANSI payload **outside** the themed
 *   background. Chafa leaves fully transparent pixels background-less, so inside
 *   pi's default shell Box they inherit the row color (`toolSuccessBg` dark
 *   green) until chafa's next reset — a green/terminal-background patchwork in
 *   the image (#027). Under `renderShell: "self"` the art sits on the terminal
 *   background, exactly like pi's native image path.
 * - native / partial / error: the model-visible text note only (the host draws
 *   image blocks itself); the strip still follows the row state.
 */
export function renderShowResult(
	result: AgentToolResult<ShowImageDetails>,
	theme: RenderThemeLike,
	context: RenderStateLike,
): Container {
	const summary = textFromContent(result.content);
	const bg = stateBgFn(theme, context);
	const container = new Container();
	container.addChild(new Text(summary, 1, 0, bg));
	container.addChild(themedBlankLine(bg));
	const payload = context.isError ? undefined : result.details?.payload;
	if (payload) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(payload, 1, 0));
	}
	return container;
}

/**
 * Note shown when format=native was forced but the host has images off: the
 * degradation is explicit, never silent (spec §7.1 step 3, §7.2 row 3). It
 * rides the existing summary Note clause; a more specific per-file note wins.
 */
export const NATIVE_OFF_NOTE =
	"format=native was requested but the host has images off; delivered as ANSI art";

/**
 * Build the show_image ToolDefinition with injectable seams. Without overrides,
 * every seam points at the real modules. renderCall/renderResult render the
 * tool call and result as Text components.
 */
export function buildShowImageTool(
	deps?: Partial<ShowImageDeps>,
): ToolDefinition<typeof showImageParams, ShowImageDetails> {
	const d: ShowImageDeps = { ...defaultDeps(), ...deps };

	return {
		name: "show_image",
		label: "Show Image",
		description:
			"Display one or more image files to the USER in the terminal. Use when the user asks to see/preview a picture, screenshot, plot, icon, or diagram, or when showing an image would help the user understand the task. The image is rendered for the user; symbols delivery returns only a text summary, while a native image block may be attached to a vision-capable model.",
		parameters: showImageParams,
		renderShell: "self",
		renderCall: (args, theme, context) => renderShowCall(args, theme, context),
		renderResult: (result, _options, theme, context) =>
			renderShowResult(result, theme, context),
		execute: async (
			_toolCallId: string,
			params: ShowImageParams,
			signal: AbortSignal | undefined,
			onUpdate:
				| ((partial: AgentToolResult<ShowImageDetails>) => void)
				| undefined,
			ctx: ExtensionContext,
		): Promise<AgentToolResult<ShowImageDetails>> => {
			// Input contract: exactly one of path/glob (spec §4.1.1).
			const hasPath =
				typeof params.path === "string" && params.path.trim() !== "";
			const hasGlob =
				typeof params.glob === "string" && params.glob.trim() !== "";
			if (hasPath === hasGlob) {
				throw new Error(`provide exactly one of "path" or "glob"`);
			}
			const target = (hasPath ? params.path : params.glob) as string;
			const cwd = ctx.cwd ?? process.cwd();

			// Step 1 — resolve inputs (spec §7.1). expandTargets throws for a
			// directory target and for a zero-match glob; a missing literal
			// path expands to [] and is reported here (spec §8).
			const matched = d.expandTargets(target, cwd);
			if (matched.length === 0) {
				throw new Error(
					`no files matched ${target}. Try a narrower or wider pattern, or pass an explicit file path.`,
				);
			}

			// no-UI sessions (print/json): plain-text summary only — never image
			// blocks, never terminal sequences (spec §7.5; Task 0 fact 4).
			if (!ctx.hasUI) {
				const files: ShowImageFile[] = matched.map((path) => ({
					path,
					ok: true,
					mode: "none",
				}));
				const resolved = d.resolveConfig({});
				return {
					content: [{ type: "text", text: summaryText(files, "none") }],
					details: {
						mode: "none",
						files,
						settings: settingsRecord(resolved, {}),
					},
				};
			}

			// Step 2 — config: defaults ← file ← CHAFA_* env ← per-call params (spec §6.3).
			const overrides: ChafaOverrides = {
				format: params.format ?? "auto",
				cellWidth: params.cellWidth,
				colors: params.colors,
				symbolsSet: params.symbolsSet,
				dither: params.dither,
			};
			const resolved = d.resolveConfig(overrides);

			// Live width clamp for the symbols path (spec §7.3, #011). chafa runs
			// during execute, so this is the last point where the viewport is known;
			// a resize after it cannot be repaired (accepted limitation, spec §13
			// OQ2). Below the 8-column guard the terminal is too narrow to draw art,
			// so the configured width is left alone rather than clamped to nothing.
			const requestedWidth = resolved.symbols.cellWidth;
			const columns = d.terminalColumns();
			const effectiveWidth =
				typeof columns === "number" && Number.isFinite(columns) && columns >= 8
					? Math.min(requestedWidth, columns - 2)
					: requestedWidth;
			const widthClampNote =
				effectiveWidth < requestedWidth
					? `width clamped from ${requestedWidth} to ${effectiveWidth} columns to fit the terminal`
					: undefined;
			const symbolsSettings = {
				...resolved.symbols,
				cellWidth: effectiveWidth,
			};

			// Step 3 — capability decision (spec §5.1, §7.2). decideDelivery
			// throws for a forced format=native this session cannot render.
			const mode: DeliveryMode = decideDelivery({
				capsImages: d.capsImages(),
				showImages: d.readHostImages().showImages,
				preferNative: resolved.preferNative,
				format: overrides.format ?? "auto",
			});
			// Forced format=native on a capable host with images off degrades to
			// symbols (decideDelivery); record that so the note is not silent.
			const nativeDegraded =
				(overrides.format ?? "auto") === "native" && mode === "symbols";

			// Symbols delivery needs a working chafa; native delivery needs one only
			// when a file's mime cannot be emitted natively (#014/#015). The probe is
			// therefore taken lazily, on first need, so a native session without
			// chafa still renders PNG/JPEG/GIF/WebP (spec §7.1 step 4a, §8).
			let chafaBinary = "chafa";
			let chafaLoaders: string[] | null = null;
			let chafaProbed = false;
			const ensureChafa = async (): Promise<void> => {
				if (chafaProbed) return;
				const probe = await d.probeChafa(resolved.symbols.binaryPath, signal);
				chafaBinary = probe.binary;
				chafaLoaders = probe.loaders;
				chafaProbed = true;
			};

			// Steps 4–5 — per-file delivery: read + sniff once, decide the route
			// (native block vs chafa symbols vs per-file error), then deliver.
			// Failures are per-file, never batch-fatal.
			const files: ShowImageFile[] = [];
			const imageBlocks: Array<{ data: string; mimeType: string }> = [];
			// Per-file payloads are collected as { path, payload } pairs so a label can
			// never drift out of alignment with its art (#005); the previous parallel
			// arrays plus a filtered join could mis-pair blocks with names.
			const payloads: Array<{ path: string; payload: string }> = [];
			let progress = 0;
			for (const filePath of matched) {
				progress += 1;
				if (signal?.aborted) throw abortError(signal);
				if (matched.length > 1 && onUpdate) {
					onUpdate({
						content: [
							{
								type: "text",
								text: `Rendering image ${progress} of ${matched.length}: ${stripControls(basenameOf(filePath))}…`,
							},
						],
						details: {
							mode,
							files: [],
							settings: settingsRecord(resolved, overrides, effectiveWidth),
						},
					});
				}
				try {
					// Read + sniff up front for both paths: the delivery decision needs the
					// mime before it can choose native vs symbols (#014/#015).
					const bytes = await d.readBytes(filePath);
					const mimeType = d.sniffMime(bytes);
					const format = overrides.format ?? "auto";
					// Probe only when chafa is actually needed: a symbols session always
					// needs it, a native session needs it only for a mime that cannot go
					// native in auto mode (a forced format=native refuses instead).
					if (
						mode === "symbols" ||
						(format !== "native" && !NATIVE_SAFE_MIMES.includes(mimeType))
					) {
						await ensureChafa();
					}
					const plan = decideFileDelivery({
						mime: mimeType,
						mode,
						format,
						chafaLoaders,
					});
					if (plan.delivery === "error") {
						throw new Error(plan.error ?? "this file cannot be delivered");
					}
					if (plan.delivery === "native") {
						files.push({
							path: filePath,
							ok: true,
							mode: "native",
							mimeType,
							byteSize: bytes.byteLength,
						});
						imageBlocks.push({ data: bytes.toString("base64"), mimeType });
					} else {
						// Step 4b — symbols delivery (spec §7.1, §7.3): chat-safe
						// args, bounded exec, cleaned payload.
						const stdout = await d.runChafa(
							chafaBinary,
							buildSymbolsArgs(filePath, symbolsSettings),
							{ timeoutMs: resolved.symbols.timeoutMs, signal },
						);
						const payload = d.cleanPayload(stdout);
						const rows = payload === "" ? 0 : payload.split("\n").length;
						const maxRows = resolved.symbols.maxRows;
						let note: string | undefined = plan.note;
						if (payload === "") {
							note = "chafa produced no output";
						} else if (rows >= maxRows) {
							note = `output capped at maxRows=${maxRows} rows; the image was scaled down to fit`;
						} else if (!note) {
							// A format-degrade note (plan.note) outranks the width clamp,
							// which outranks the forced-native-off degrade.
							note =
								widthClampNote ??
								(nativeDegraded ? NATIVE_OFF_NOTE : undefined);
						}
						files.push({
							path: filePath,
							ok: true,
							mode: "symbols",
							mimeType,
							byteSize: bytes.byteLength,
							note,
						});
						payloads.push({ path: filePath, payload });
					}
				} catch (error) {
					// A user abort surfaces mid-run (chafa's AbortError); rethrow the
					// ORIGINAL error so callers can classify it — never report a
					// misleading per-file failure or a bare unclassifiable error
					// (AGENTS.md invariant 4).
					const err = error as { name?: string; code?: string } | undefined;
					if (
						err?.name === "AbortError" ||
						err?.code === "ABORT_ERR" ||
						signal?.aborted
					) {
						throw error ?? abortError(signal);
					}
					// Per-file failure: record and continue (spec §8, mixed results).
					files.push({
						path: filePath,
						ok: false,
						mode,
						note: (error as Error).message,
					});
				}
			}

			if (files.every((file) => !file.ok)) {
				// All files failed → aggregate into a thrown (isError) result
				// (Task 0 fact 2: the host maps a throw to isError with this text).
				throw new Error(
					`none of the ${files.length} matched file(s) could be shown. First error: ${stripControls(files[0]?.note ?? "unknown error")}`,
				);
			}

			const details: ShowImageDetails = {
				mode,
				files,
				settings: settingsRecord(resolved, overrides, effectiveWidth),
			};
			const content: AgentToolResult<ShowImageDetails>["content"] = [
				{ type: "text", text: summaryText(files, mode) },
			];

			if (imageBlocks.length > 0) {
				// Native delivery: image content blocks for the host Image component
				// (spec §7.1 step 4a). The host converts non-PNG for kitty and
				// suppresses blocks when caps/showImages are off.
				for (const block of imageBlocks) {
					content.push({ type: "image", ...block });
				}
			}
			if (payloads.length > 0) {
				// Symbols delivery: the ANSI payload rides in details only — never in
				// the model-visible text (spec §4.1.2, §4.1.3, §7.3). This can coexist
				// with native blocks when a native session degraded some files
				// (#014/#015). A multi-file run labels each block with a sanitized
				// [basename] and separates blocks with one blank line so the user can
				// tell them apart (#005); a single file stays unlabeled.
				const blocks = payloads
					.filter((entry) => entry.payload !== "")
					.map((entry) =>
						matched.length > 1
							? `[${stripControls(basenameOf(entry.path))}]\n${entry.payload}`
							: entry.payload,
					);
				if (blocks.length > 0) details.payload = blocks.join("\n\n");
			}

			return { content, details };
		},
	};
}
