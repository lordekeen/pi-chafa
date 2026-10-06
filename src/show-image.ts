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
import { abortError } from "./abort.js";
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
	type ImageEnv,
	NATIVE_SAFE_MIMES,
	resolveCapsImages,
} from "./detect.js";
import {
	expandTargets,
	MAX_NATIVE_BYTES,
	readBytes,
	readSniffHead,
	sniffMime,
	statFileSize,
} from "./images.js";
import { stripControls } from "./sanitize.js";
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
					"A single image file path: absolute, home-relative (~/...), or relative to the working directory.",
			}),
		),
		glob: Type.Optional(
			Type.String({
				description:
					"A glob pattern: absolute, home-relative (~/...), or relative to the working directory, e.g. screenshots/*.png.",
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

/**
 * Bound on concurrently running chafa subprocesses for a multi-file run
 * (spec §7.1/§7.3, #036). Renders are single-core-bound, so files can overlap;
 * results are assembled in match order regardless of completion order.
 */
export const MAX_CONCURRENT_RENDERS = 4;

/** Injectable seams so execute() is testable without a terminal, chafa, or config file (spec §5.3). */
export interface ShowImageDeps {
	resolveConfig: (
		overrides: ChafaOverrides,
		agentDir?: string,
		hostSettings?: HostImageSettings,
	) => ResolvedConfig;
	/** Host settings source; execute() reads it exactly once per call (#044). */
	readHostImages: () => HostImageSettings;
	/** First rung of the §6.4 ladder: the host's pi-tui capability singleton. */
	getCapsImages: () => AgentCapsImages;
	expandTargets: (
		target: string,
		cwd: string,
		signal?: AbortSignal,
	) => string[];
	/** First ≤512 bytes for mime sniffing; the symbols path never full-reads (#037). */
	readHead: (filePath: string, size?: number) => Promise<Buffer>;
	/** File size in bytes; the native path checks it against the ceiling first (#037). */
	fileSize: (filePath: string) => number;
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
	/** Real environment + platform the #026 guard and the #030 hint read. */
	env: () => ImageEnv;
	platform: () => string;
}

function defaultDeps(): ShowImageDeps {
	// One success-only probe cache per tool instance (#007): repeat invocations
	// in a session never respawn `chafa --version`, while a failed probe is
	// retried so a missing-then-installed chafa recovers.
	const cachedProbe = createCachedProbe();
	const readEnv = () => process.env;
	const readPlatform = () => process.platform;
	return {
		resolveConfig,
		readHostImages: readHostImageSettings,
		getCapsImages: () => getCapabilities().images,
		// The spec §6.4 ladder (getCapabilities() → terminal.images →
		// PI_IMAGE_PROTOCOL) is computed in execute() from the single injectable
		// host-settings read + the injectable caps rung + env + platform (#044);
		// there is no host-settings read inside the ladder itself.
		env: readEnv,
		platform: readPlatform,
		// Rebind: expandTargets is (target, cwd, home?, signal?) but the seam
		// exposes (target, cwd, signal?) — execute never overrides the home dir.
		expandTargets: (target, cwd, signal) =>
			expandTargets(target, cwd, undefined, signal),
		readHead: readSniffHead,
		fileSize: statFileSize,
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

			// Single host-settings read for the whole execute (#044): config's
			// imageWidthCells rung, the §6.4 ladder, and the delivery decision all
			// consume this one value (per-call freshness, no module cache).
			const hostImages = d.readHostImages();

			// Step 1 — resolve inputs (spec §7.1). expandTargets throws for a
			// directory target, a zero-match glob and a >50-match glob (#035); a
			// missing literal path expands to [] and is reported here (spec §8).
			const matched = d.expandTargets(target, cwd, signal);
			if (matched.length === 0) {
				throw new Error(
					`no files matched ${stripControls(target)}. Try a narrower or wider pattern, or pass an explicit file path.`,
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
				const resolved = d.resolveConfig({}, undefined, hostImages);
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
			const resolved = d.resolveConfig(overrides, undefined, hostImages);

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

			// Step 3 — capability decision (spec §5.1, §7.2): the §6.4 ladder
			// (getCapabilities() → terminal.images → PI_IMAGE_PROTOCOL) computed
			// from the single host-settings read above (#044). decideDelivery
			// throws for a forced format=native this session cannot render; the
			// real env/platform word that error's fix hint for tmux (#030).
			const env = d.env();
			const platform = d.platform();
			const mode: DeliveryMode = decideDelivery({
				capsImages: resolveCapsImages(
					d.getCapsImages(),
					hostImages.images,
					env.PI_IMAGE_PROTOCOL,
					env,
					platform,
				),
				showImages: hostImages.showImages,
				preferNative: resolved.preferNative,
				format: overrides.format ?? "auto",
				env,
				platform,
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
			// Failures are per-file, never batch-fatal. Chafa subprocesses run
			// through a bounded pool (#036): at most MAX_CONCURRENT_RENDERS in
			// flight, results land in index-keyed slots so assembly stays in
			// match order (byte-identical to the serial baseline). Per-file
			// metadata needed after the chafa await (mime, size, degrade note) is
			// stashed in the job record — the read buffer itself is not retained.
			const slots: Array<ShowImageFile | undefined> = new Array(matched.length);
			const nativeBlocks = new Map<
				number,
				{ data: string; mimeType: string }
			>();
			const payloadByIndex = new Map<number, string>();
			interface ChafaJob {
				index: number;
				mimeType: string;
				byteSize: number;
				planNote?: string;
				job: Promise<string>;
			}
			const chafaJobs: ChafaJob[] = [];
			// Simple bounded-pool gate: at most one waiter can exist because pass 1
			// awaits the gate per file, sequentially.
			let activeChafa = 0;
			let wake: (() => void) | null = null;
			const poolGate = async (): Promise<void> => {
				if (activeChafa >= MAX_CONCURRENT_RENDERS) {
					await new Promise<void>((resolve) => {
						wake = resolve;
					});
				}
			};
			const releasePool = (): void => {
				activeChafa -= 1;
				const w = wake;
				wake = null;
				w?.();
			};
			let progress = 0;
			for (const [index, filePath] of matched.entries()) {
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
					// Sniff head + stat for both paths (#037): the delivery decision needs
					// the mime before choosing native vs symbols (#014/#015), and the full
					// read is only ever taken on the native route, gated by the ceiling.
					// Reads stay serial (bounded by the #035 cap); only chafa overlaps.
					const head = await d.readHead(filePath);
					const mimeType = d.sniffMime(head);
					const fileSize = d.fileSize(filePath);
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
						// Ceiling check BEFORE the full read: an oversized file fails
						// per-file with an actionable note instead of being buffered and
						// base64-retained (1.33×) in session history (#037, spec §8).
						if (fileSize > MAX_NATIVE_BYTES) {
							throw new Error(
								`image exceeds ${MAX_NATIVE_BYTES} bytes (native-delivery ceiling); pass format=symbols or use a smaller file`,
							);
						}
						const bytes = await d.readBytes(filePath);
						slots[index] = {
							path: filePath,
							ok: true,
							mode: "native",
							mimeType,
							byteSize: bytes.byteLength,
						};
						nativeBlocks.set(index, {
							data: bytes.toString("base64"),
							mimeType,
						});
					} else {
						// Step 4b — symbols delivery (spec §7.1, §7.3): chat-safe
						// args, bounded exec, cleaned payload. The subprocess runs
						// through the pool; per-file outcomes settle in pass 2.
						await poolGate();
						activeChafa += 1;
						const job = d
							.runChafa(
								chafaBinary,
								buildSymbolsArgs(filePath, symbolsSettings),
								{ timeoutMs: resolved.symbols.timeoutMs, signal },
							)
							.then((stdout) => d.cleanPayload(stdout));
						// Settle-tracking only: prevents unhandled rejections for jobs a
						// prompt abort rethrow leaves behind; does not change outcomes.
						void job.then(
							() => releasePool(),
							() => releasePool(),
						);
						chafaJobs.push({
							index,
							mimeType,
							byteSize: fileSize,
							planNote: plan.note,
							job,
						});
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
					slots[index] = {
						path: filePath,
						ok: false,
						mode,
						note: (error as Error).message,
					};
				}
			}

			// Pass 2 — settle every chafa job. All in-flight jobs share the tool
			// signal, so a genuine abort rejects them all promptly; the first
			// abort-classified outcome rethrows the original error (invariant 4), a
			// per-file failure records and continues (spec §8).
			const outcomes = await Promise.allSettled(
				chafaJobs.map((entry) => entry.job),
			);
			for (let i = 0; i < chafaJobs.length; i++) {
				const entry = chafaJobs[i] as ChafaJob;
				const filePath = matched[entry.index] as string;
				const outcome = outcomes[i] as PromiseSettledResult<string>;
				if (outcome.status === "rejected") {
					const err = outcome.reason as
						| { name?: string; code?: string }
						| undefined;
					if (
						err?.name === "AbortError" ||
						err?.code === "ABORT_ERR" ||
						signal?.aborted
					) {
						throw outcome.reason ?? abortError(signal);
					}
					slots[entry.index] = {
						path: filePath,
						ok: false,
						mode,
						note: (outcome.reason as Error).message,
					};
					continue;
				}
				const payload = outcome.value;
				const rows = payload === "" ? 0 : payload.split("\n").length;
				const maxRows = resolved.symbols.maxRows;
				let note: string | undefined = entry.planNote;
				if (payload === "") {
					note = "chafa produced no output";
				} else if (rows >= maxRows) {
					note = `output capped at maxRows=${maxRows} rows; the image was scaled down to fit`;
				} else if (!note) {
					// A format-degrade note (plan.note) outranks the width clamp,
					// which outranks the forced-native-off degrade.
					note =
						widthClampNote ?? (nativeDegraded ? NATIVE_OFF_NOTE : undefined);
				}
				slots[entry.index] = {
					path: filePath,
					ok: true,
					mode: "symbols",
					mimeType: entry.mimeType,
					byteSize: entry.byteSize,
					note,
				};
				payloadByIndex.set(entry.index, payload);
			}

			// Assembly in match order from the slots — same shapes as the serial
			// implementation consumed downstream (files, imageBlocks, payloads), so
			// ordering, mixed-success handling and notes stay byte-identical (#036).
			const files: ShowImageFile[] = [];
			const imageBlocks: Array<{ data: string; mimeType: string }> = [];
			// Per-file payloads are collected as { path, payload } pairs so a label can
			// never drift out of alignment with its art (#005); the previous parallel
			// arrays plus a filtered join could mis-pair blocks with names.
			const payloads: Array<{ path: string; payload: string }> = [];
			for (let i = 0; i < matched.length; i++) {
				const file = slots[i] as ShowImageFile;
				files.push(file);
				const block = nativeBlocks.get(i);
				if (block) imageBlocks.push(block);
				const payload = payloadByIndex.get(i);
				if (payload !== undefined) {
					payloads.push({ path: matched[i] as string, payload });
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
