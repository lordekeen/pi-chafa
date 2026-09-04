import type {
	AgentToolResult,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { getCapabilities, Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import {
	buildSymbolsArgs,
	cleanSymbolsPayload,
	probeChafa,
	runChafa,
} from "./chafa.js";
import { readHostImageSettings, resolveConfig } from "./config.js";
import { decideDelivery } from "./detect.js";
import { expandTargets, readBytes, sniffMime } from "./images.js";
import type {
	AgentCapsImages,
	ChafaOverrides,
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
	) => Promise<{ binary: string; version: { major: number; minor: number } }>;
	runChafa: (
		binary: string,
		args: string[],
		opts: { timeoutMs: number; signal?: AbortSignal },
	) => Promise<string>;
	cleanPayload: (raw: string) => string;
}

function defaultDeps(): ShowImageDeps {
	return {
		resolveConfig,
		readHostImages: readHostImageSettings,
		capsImages: () => getCapabilities().images,
		expandTargets,
		readBytes,
		sniffMime,
		probeChafa,
		runChafa,
		cleanPayload: cleanSymbolsPayload,
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

function stripControls(s: string): string {
	return s.replace(CSI_RE, "").replace(CONTROL_RE, "");
}

/** Effective-settings snapshot recorded in details for renderers/transcript (spec §7.1 steps 2/5). */
function settingsRecord(
	resolved: ResolvedConfig,
	overrides: ChafaOverrides,
): ShowImageSettings {
	return {
		format: overrides.format ?? "auto",
		cellWidth: resolved.symbols.cellWidth,
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
	const label =
		mode === "native" ? "via terminal-native rendering" : "as ANSI art";

	if (mode === "none") {
		const head =
			files.length <= 1
				? `Showed image ${name} to the user`
				: `Showed ${files.length} image(s) to the user`;
		return `${head} [image display unavailable in this session].`;
	}
	const head =
		files.length <= 1
			? `Showed image ${name} to the user ${label}`
			: `Showed ${files.length} image(s) to the user ${label}`;
	const tail = failed > 0 ? ` ${failed} file(s) could not be shown.` : "";
	return `${head}.${tail}`;
}

/** Flatten the text blocks of a result — reused by the renderers (Task 8). */
export function textFromContent(
	content: AgentToolResult<ShowImageDetails>["content"],
): string {
	return content
		.filter(
			(block): block is { type: "text"; text: string } => block.type === "text",
		)
		.map((block) => block.text)
		.join("\n");
}

/** User-visible text for a completed result: summary caption + symbols payload (spec §4.1.3). */
export function displayText(
	summary: string,
	details: ShowImageDetails | undefined,
): string {
	if (!details?.payload) return summary;
	return `${summary}\n${details.payload}`;
}

/** renderCall: compact "Show Image <target>" (spec §4.1 registration table). */
export function renderShowCall(args: ShowImageParams): Text {
	const target = stripControls((args.path ?? args.glob ?? "").trim());
	return new Text(`Show Image ${target}`, 0, 0);
}

/**
 * renderResult: single component for both delivery modes.
 * - symbols: caption + ANSI payload read back from details (verbatim lines, §3.3)
 * - native / partial / error: the model-visible text note only (host draws
 *   image blocks itself; error rows get host error styling via context.isError)
 */
export function renderShowResult(
	result: AgentToolResult<ShowImageDetails>,
	isError: boolean,
): Text {
	const summary = textFromContent(result.content);
	if (isError || !result.details) return new Text(summary, 0, 0);
	return new Text(displayText(summary, result.details), 0, 0);
}

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
			"Display one or more image files to the USER in the terminal. Use when the user asks to see/preview a picture, screenshot, plot, icon, or diagram, or when showing an image would help the user understand the task. The image is rendered for the user only; you do not receive its contents.",
		parameters: showImageParams,
		renderShell: "default",
		renderCall: (args: ShowImageParams) => renderShowCall(args),
		renderResult: (
			result: AgentToolResult<ShowImageDetails>,
			_options,
			_theme,
			context,
		) => renderShowResult(result, context.isError),
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

			// Step 3 — capability decision (spec §5.1, §7.2). decideDelivery
			// throws for a forced format=native this session cannot render.
			const mode: DeliveryMode = decideDelivery({
				capsImages: d.capsImages(),
				showImages: d.readHostImages().showImages,
				preferNative: resolved.preferNative,
				format: overrides.format ?? "auto",
			});

			// Symbols delivery needs a working chafa up front (spec §8); the
			// probe result is the single source of truth for the binary path.
			let chafaBinary = "chafa";
			if (mode === "symbols") {
				const probe = await d.probeChafa(resolved.symbols.binaryPath);
				chafaBinary = probe.binary;
			}

			// Steps 4–5 — per-file delivery: native reads once per file, symbols
			// runs chafa once per file. Failures are per-file, never batch-fatal.
			const files: ShowImageFile[] = [];
			const imageBlocks: Array<{ data: string; mimeType: string }> = [];
			const payloads: string[] = [];
			let progress = 0;
			for (const filePath of matched) {
				progress += 1;
				if (signal?.aborted) throw new Error("show_image was aborted");
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
							settings: settingsRecord(resolved, overrides),
						},
					});
				}
				try {
					if (mode === "native") {
						const bytes = await d.readBytes(filePath);
						const mimeType = d.sniffMime(bytes);
						files.push({
							path: filePath,
							ok: true,
							mode,
							mimeType,
							byteSize: bytes.byteLength,
							note:
								mimeType === "application/octet-stream"
									? "unknown image format; the host may not render this natively"
									: undefined,
						});
						imageBlocks.push({ data: bytes.toString("base64"), mimeType });
					} else {
						// Step 4b — symbols delivery (spec §7.1, §7.3): chat-safe
						// args, bounded exec, cleaned payload.
						const stdout = await d.runChafa(
							chafaBinary,
							buildSymbolsArgs(filePath, resolved.symbols),
							{ timeoutMs: resolved.symbols.timeoutMs, signal },
						);
						const payload = d.cleanPayload(stdout);
						files.push({
							path: filePath,
							ok: true,
							mode,
							note: payload === "" ? "chafa produced no output" : undefined,
						});
						payloads.push(payload);
					}
				} catch (error) {
					// A user abort surfaces mid-run (chafa's AbortError); propagate
					// it instead of recording a misleading per-file failure.
					if (signal?.aborted) {
						throw new Error("show_image was aborted");
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
					`none of the ${files.length} matched file(s) could be shown. First error: ${files[0]?.note ?? "unknown error"}`,
				);
			}

			const details: ShowImageDetails = {
				mode,
				files,
				settings: settingsRecord(resolved, overrides),
			};
			const content: AgentToolResult<ShowImageDetails>["content"] = [
				{ type: "text", text: summaryText(files, mode) },
			];

			if (mode === "native") {
				// Native delivery: image content blocks for the host Image
				// component (spec §7.1 step 4a). The host converts non-PNG for
				// kitty and suppresses blocks when caps/showImages are off.
				for (const block of imageBlocks) {
					content.push({ type: "image", ...block });
				}
			} else {
				// Symbols delivery: the ANSI payload rides in details only —
				// never in the model-visible text (spec §4.1.2, §4.1.3, §7.3).
				const nonEmpty = payloads.filter((payload) => payload !== "");
				if (nonEmpty.length > 0) details.payload = nonEmpty.join("\n");
			}

			return { content, details };
		},
	};
}
