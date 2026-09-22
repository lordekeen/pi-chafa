import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanSymbolsPayload } from "../src/chafa.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { resolveCapsImages } from "../src/detect.js";
import {
	buildShowImageTool,
	summaryText,
	type ShowImageDeps,
} from "../src/show-image.js";
import type {
	AgentCapsImages,
	ChafaOverrides,
	HostImageSettings,
	ResolvedConfig,
	ShowImageDetails,
	ShowImageFile,
} from "../src/types.js";

// A real, valid 1x1 PNG (red pixel).
const PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const RAW_ART = "\x1b[?25l\x1b[38;5;1m█\x1b[0m\n\x1b[?25h";
const CLEAN_ART = "\x1b[38;5;1m█\x1b[0m";

let dir: string;
let pngPath: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-chafa-show-"));
	pngPath = join(dir, "pic.png");
	writeFileSync(pngPath, Buffer.from(PNG_BASE64, "base64"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function resolvedConfig(overrides: ChafaOverrides = {}): ResolvedConfig {
	const base = DEFAULT_CONFIG;
	return {
		preferNative: base.preferNative,
		formatOrder: base.formatOrder,
		symbols: {
			cellWidth: overrides.cellWidth ?? base.cellWidth,
			maxRows: base.maxRows,
			colors: overrides.colors ?? base.colors,
			symbolsSet: overrides.symbolsSet ?? base.symbolsSet,
			dither: overrides.dither ?? base.dither,
			timeoutMs: base.timeoutMs,
			binaryPath: base.binaryPath,
		},
	};
}

function makeTool(overrides: {
	capsImages?: AgentCapsImages;
	hostImages?: AgentCapsImages;
	envProtocol?: string;
	showImages?: boolean;
	format?: "auto" | "native" | "symbols";
	hasUI?: boolean;
	columns?: number;
	runStdout?: string;
	probeChafa?: ShowImageDeps["probeChafa"];
	runChafa?: ShowImageDeps["runChafa"];
	sniffMime?: ShowImageDeps["sniffMime"];
} = {}) {
	const capsImages = overrides.capsImages === undefined ? "kitty" : overrides.capsImages;
	const hostImages = overrides.hostImages ?? null;
	const envProtocol = overrides.envProtocol;
	const showImages = overrides.showImages ?? true;
	const hasUI = overrides.hasUI ?? true;
	const tool = buildShowImageTool({
		resolveConfig: (perCall) => resolvedConfig(perCall),
		readHostImages: (): HostImageSettings => ({
			showImages,
			imageWidthCells: 60,
			images: hostImages,
		}),
		// The injected seam mirrors defaultDeps: the raw pi-tui read is pushed
		// through the real fallback ladder against the injected host settings.
		capsImages: () => resolveCapsImages(capsImages, hostImages, envProtocol),
		expandTargets: (target, cwd) => {
			const abs = join(cwd, target);
			if (abs === pngPath) return [abs];
			return [];
		},
		readBytes: async (path) => {
			if (path !== pngPath) throw new Error(`failed to read ${path}: ENOENT`);
			return Buffer.from(PNG_BASE64, "base64");
		},
		sniffMime: overrides.sniffMime ?? (() => "image/png"),
		// Hermetic viewport: never read the developer's real TTY in tests (#011).
		terminalColumns: () => overrides.columns,
		probeChafa:
			overrides.probeChafa ?? (async () => ({ binary: "/usr/bin/chafa", version: { major: 1, minor: 18 } })),
		runChafa: overrides.runChafa ?? (async () => overrides.runStdout ?? RAW_ART),
		// Real cleaner: RAW_ART (cursor toggles wrapped) must become CLEAN_ART.
		cleanPayload: cleanSymbolsPayload,
	});
	return { tool, ctx: makeCtx(hasUI) };
}

function makeCtx(hasUI: boolean) {
	return {
		hasUI,
		mode: hasUI ? "tui" : "print",
		cwd: dir,
		ui: {},
	} as never;
}

const noop = () => {};
const neverAbort = () => undefined as AbortSignal | undefined;

describe("summaryText (locked wording, open question 5)", () => {
	it("single native file", () => {
		const files: ShowImageFile[] = [{ path: pngPath, ok: true, mode: "native", mimeType: "image/png", byteSize: 100 }];
		expect(summaryText(files, "native")).toBe("Showed image pic.png to the user via terminal-native rendering.");
	});
	it("single symbols file", () => {
		const files: ShowImageFile[] = [{ path: pngPath, ok: true, mode: "symbols" }];
		expect(summaryText(files, "symbols")).toBe("Showed image pic.png to the user as ANSI art.");
	});
	it("many files includes the count", () => {
		const files: ShowImageFile[] = [
			{ path: join(dir, "1.png"), ok: true, mode: "symbols" },
			{ path: join(dir, "2.png"), ok: true, mode: "symbols" },
		];
		expect(summaryText(files, "symbols")).toBe("Showed 2 image(s) to the user as ANSI art.");
	});
	it("mixed success reports the shown-of-total count so the header never contradicts the tail (#006)", () => {
		const files: ShowImageFile[] = [
			{ path: join(dir, "1.png"), ok: true, mode: "symbols" },
			{ path: join(dir, "2.png"), ok: false, mode: "symbols", note: "failed to read" },
		];
		expect(summaryText(files, "symbols")).toBe(
			"Showed 1 of 2 image(s) to the user as ANSI art. 1 file(s) could not be shown.",
		);
	});
	it("keeps the total-count phrase when every file succeeds (#006)", () => {
		const files: ShowImageFile[] = [
			{ path: join(dir, "1.png"), ok: true, mode: "symbols" },
			{ path: join(dir, "2.png"), ok: true, mode: "symbols" },
		];
		expect(summaryText(files, "symbols")).toBe("Showed 2 image(s) to the user as ANSI art.");
	});
	it("keeps the Note clause on a mixed-success run (#006)", () => {
		const files: ShowImageFile[] = [
			{ path: join(dir, "1.png"), ok: true, mode: "symbols", note: "chafa produced no output" },
			{ path: join(dir, "2.png"), ok: false, mode: "symbols", note: "failed to read" },
			{ path: join(dir, "3.png"), ok: false, mode: "symbols", note: "failed to read" },
		];
		expect(summaryText(files, "symbols")).toBe(
			"Showed 1 of 3 image(s) to the user as ANSI art. 2 file(s) could not be shown. Note: chafa produced no output.",
		);
	});
	it("strips control characters from a path in the summary", () => {
		const files: ShowImageFile[] = [
			{ path: `${dir}/pic\u001b[31m.png`, ok: true, mode: "symbols" },
		];
		const text = summaryText(files, "symbols");
		expect(text).not.toContain("\u001b");
		expect(text).toBe("Showed image pic.png to the user as ANSI art.");
	});
	it("appends a de-duplicated Note clause when shown files carry notes", () => {
		const files: ShowImageFile[] = [
			{ path: join(dir, "1.png"), ok: true, mode: "native", note: "unknown image format" },
			{ path: join(dir, "2.png"), ok: true, mode: "native", note: "unknown image format" },
			{ path: join(dir, "3.png"), ok: true, mode: "native" },
		];
		expect(summaryText(files, "native")).toBe(
			"Showed 3 image(s) to the user via terminal-native rendering. Note: unknown image format.",
		);
	});
	it("omits the Note clause when no shown file carries a note", () => {
		const files: ShowImageFile[] = [
			{ path: pngPath, ok: true, mode: "symbols" },
			{ path: join(dir, "2.png"), ok: false, mode: "symbols", note: "failed to read" },
		];
		expect(summaryText(files, "symbols")).toBe(
			"Showed 1 of 2 image(s) to the user as ANSI art. 1 file(s) could not be shown.",
		);
	});
});

describe("show_image execute — native path", () => {
	it("returns a text note plus an image content block for a native-capable session", async () => {
		const { tool, ctx } = makeTool({ capsImages: "kitty" });
		const result = await tool.execute("t1", { path: "pic.png" }, neverAbort(), noop as never, ctx);
		const text = result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
		expect(text).toBe("Showed image pic.png to the user via terminal-native rendering.");
		const images = result.content.filter((c) => c.type === "image");
		expect(images).toHaveLength(1);
		const image = images[0] as { type: "image"; data: string; mimeType: string };
		expect(image.mimeType).toBe("image/png");
		expect(Buffer.from(image.data, "base64").subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
		const details = result.details as ShowImageDetails;
		expect(details.mode).toBe("native");
		expect(details.payload).toBeUndefined();
		expect(details.files[0]?.ok).toBe(true);
		expect(details.settings.format).toBe("auto");
	});
	it("native path rejects a non-image mime so no image block is emitted", async () => {
		const { tool, ctx } = makeTool({
			capsImages: "kitty",
			sniffMime: () => "application/octet-stream",
		});
		const promise = tool.execute("t11", { path: "pic.png" }, neverAbort(), noop as never, ctx);
		await expect(promise).rejects.toThrow(/not a recognized image format/);
	});
	it("preferNative=false routes a native-capable session to symbols (never chafa on native by default is the default, not the only route)", async () => {
		const { tool, ctx } = makeTool({ capsImages: "kitty" });
		const params = { path: "pic.png", format: "symbols" as const };
		const result = await tool.execute("t2", params, neverAbort(), noop as never, ctx);
		const details = result.details as ShowImageDetails;
		expect(details.mode).toBe("symbols");
		expect(details.payload).toBeDefined();
	});
});

describe("show_image execute — symbols path", () => {
	it("keeps ANSI out of text, stashes cleaned payload in details, and notes truncation-free size", async () => {
		const { tool, ctx } = makeTool({ capsImages: null, runStdout: RAW_ART });
		const result = await tool.execute("t3", { path: "pic.png" }, neverAbort(), noop as never, ctx);
		const text = result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
		expect(text).not.toContain("\x1b[");
		expect(text).toBe("Showed image pic.png to the user as ANSI art.");
		const details = result.details as ShowImageDetails;
		expect(details.mode).toBe("symbols");
		expect(details.payload).toBe(CLEAN_ART);
	});
	it("notes a chafa-produced-no-output result in the model-visible summary (§8)", async () => {
		const { tool, ctx } = makeTool({ capsImages: null, runStdout: "" });
		const result = await tool.execute("t12", { path: "pic.png" }, neverAbort(), noop as never, ctx);
		const text = result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
		expect(text).toBe(
			"Showed image pic.png to the user as ANSI art. Note: chafa produced no output.",
		);
	});
	it("notes the maxRows cap when the cleaned payload reaches maxRows (spec §7.3)", async () => {
		const capped = Array.from({ length: 50 }, () => "X").join("\n");
		const cappedTool = makeTool({ capsImages: null, runStdout: capped });
		const cappedResult = await cappedTool.tool.execute(
			"t13",
			{ path: "pic.png" },
			neverAbort(),
			noop as never,
			cappedTool.ctx,
		);
		expect((cappedResult.details as ShowImageDetails).files[0]?.note).toBe(
			"output capped at maxRows=50 rows; the image was scaled down to fit",
		);
		const shorter = Array.from({ length: 49 }, () => "X").join("\n");
		const shorterTool = makeTool({ capsImages: null, runStdout: shorter });
		const shorterResult = await shorterTool.tool.execute(
			"t14",
			{ path: "pic.png" },
			neverAbort(),
			noop as never,
			shorterTool.ctx,
		);
		expect((shorterResult.details as ShowImageDetails).files[0]?.note).toBeUndefined();
	});
	it("throws an actionable error when chafa is missing on the symbols path", async () => {
		const { tool, ctx } = makeTool({
			capsImages: null,
			probeChafa: async () => {
				throw new Error("chafa was not found on PATH (looked for chafa). Install it with: apt install chafa (or your distro's package). Or set CHAFA_BIN to its absolute path.");
			},
		});
		await expect(tool.execute("t4", { path: "pic.png" }, neverAbort(), noop as never, ctx)).rejects.toThrow(
			/not found on PATH/,
		);
	});
	it("propagates an abort from runChafa as an abort, not a timeout or per-file failure", async () => {
		const controller = new AbortController();
		const { tool, ctx } = makeTool({
			capsImages: null,
			runChafa: async () => {
				controller.abort();
				const err = new Error("The operation was aborted") as Error & { code?: string };
				err.name = "AbortError";
				err.code = "ABORT_ERR";
				throw err;
			},
		});
		await expect(
			tool.execute("t10", { path: "pic.png" }, controller.signal, noop as never, ctx),
		).rejects.toThrow(/aborted/);
		await expect(
			tool.execute("t10", { path: "pic.png" }, controller.signal, noop as never, ctx),
		).rejects.not.toThrow(/timed out/);
	});
	it("throws an AbortError-shaped error when the signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const { tool, ctx } = makeTool({ capsImages: "kitty" });
		const err = await tool
			.execute("t15", { path: "pic.png" }, controller.signal, noop as never, ctx)
			.then(
				() => undefined,
				(e: unknown) => e,
			);
		expect((err as Error).name).toBe("AbortError");
	});
});

describe("probe plumbing (#007/#008)", () => {
it("passes the tool abort signal into the chafa probe", async () => {
const controller = new AbortController();
let seen: AbortSignal | undefined;
const { tool, ctx } = makeTool({
capsImages: null,
probeChafa: async (_binaryPath, signal) => {
seen = signal;
return { binary: "/usr/bin/chafa", version: { major: 1, minor: 18 } };
},
});
await tool.execute("t20", { path: "pic.png" }, controller.signal, noop as never, ctx);
expect(seen).toBe(controller.signal);
});
});

describe("show_image execute — live width clamp (#011)", () => {
function captureTool(columns: number | undefined) {
let args: string[] = [];
const { tool, ctx } = makeTool({
capsImages: null,
columns,
runChafa: async (_bin, a) => {
args = a;
return RAW_ART;
},
});
return { tool, ctx, args: () => args };
}
const sizeOf = (args: string[]) => args[args.indexOf("--size") + 1];
it("clamps cellWidth to columns - 2 and notes the clamp", async () => {
const { tool, ctx, args } = captureTool(50);
const result = await tool.execute(
"c1",
{ path: "pic.png", cellWidth: 120 },
neverAbort(),
noop as never,
ctx,
);
expect(sizeOf(args())).toBe("48x50");
const details = result.details as ShowImageDetails;
expect(details.files[0]?.note).toBe(
"width clamped from 120 to 48 columns to fit the terminal",
);
const text = result.content
.filter((c) => c.type === "text")
.map((c) => c.text)
.join("\n");
expect(text).toContain(
"Note: width clamped from 120 to 48 columns to fit the terminal.",
);
});
it("leaves the configured width alone when the terminal width is unknown", async () => {
const { tool, ctx, args } = captureTool(undefined);
const result = await tool.execute(
"c2",
{ path: "pic.png", cellWidth: 120 },
neverAbort(),
noop as never,
ctx,
);
expect(sizeOf(args())).toBe("120x50");
expect((result.details as ShowImageDetails).files[0]?.note).toBeUndefined();
});
it("does not clamp for a terminal below the 8-column guard", async () => {
const { tool, ctx, args } = captureTool(5);
const result = await tool.execute(
"c3",
{ path: "pic.png", cellWidth: 120 },
neverAbort(),
noop as never,
ctx,
);
expect(sizeOf(args())).toBe("120x50");
expect((result.details as ShowImageDetails).files[0]?.note).toBeUndefined();
});
it("does not clamp when the configured width already fits", async () => {
const { tool, ctx, args } = captureTool(200);
const result = await tool.execute(
"c4",
{ path: "pic.png", cellWidth: 120 },
neverAbort(),
noop as never,
ctx,
);
expect(sizeOf(args())).toBe("120x50");
expect((result.details as ShowImageDetails).files[0]?.note).toBeUndefined();
});
it("leaves colors and symbolsSet untouched by the clamp", async () => {
const { tool, ctx, args } = captureTool(50);
await tool.execute(
"c5",
{ path: "pic.png", cellWidth: 120, colors: "16", symbolsSet: "block" },
neverAbort(),
noop as never,
ctx,
);
expect(args()).toContain("16");
expect(args()).toContain("block");
});
});

describe("show_image execute — no-UI degrade (spec §7.5)", () => {
	it("returns a plain-text summary with no image blocks and no ANSI when hasUI is false", async () => {
		const { tool, ctx } = makeTool({ hasUI: false });
		const result = await tool.execute("t5", { path: "pic.png" }, neverAbort(), noop as never, ctx);
		expect(result.content.every((c) => c.type === "text")).toBe(true);
		const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
		expect(text).toBe("Showed image pic.png to the user [image display unavailable in this session].");
		expect(text).not.toContain("\x1b[");
		expect((result.details as ShowImageDetails).mode).toBe("none");
	});
});

describe("show_image execute — input validation", () => {
	it("rejects providing both path and glob", async () => {
		const { tool, ctx } = makeTool();
		await expect(
			tool.execute("t6", { path: "pic.png", glob: "**/*.png" }, neverAbort(), noop as never, ctx),
		).rejects.toThrow(/exactly one of "path" or "glob"/);
	});
	it("rejects providing neither", async () => {
		const { tool, ctx } = makeTool();
		await expect(tool.execute("t7", {}, neverAbort(), noop as never, ctx)).rejects.toThrow(
			/exactly one of "path" or "glob"/,
		);
	});
	it("throws no-files-matched for an unmatched explicit path", async () => {
		const { tool, ctx } = makeTool();
		await expect(tool.execute("t8", { path: "gone.png" }, neverAbort(), noop as never, ctx)).rejects.toThrow(
			/no files matched/,
		);
	});
});

describe("show_image execute — forced native on non-native caps errors (spec §7.2 last row)", () => {
	it("does not silently degrade", async () => {
		const { tool, ctx } = makeTool({ capsImages: null, format: "native" });
		await expect(
			tool.execute("t9", { path: "pic.png", format: "native" }, neverAbort(), noop as never, ctx),
		).rejects.toThrow(/format=native/);
	});
});

describe("show_image execute — capability fallback ladder (headline fix)", () => {
	it("chooses native when getCapabilities() is null but host settings report terminal.images=kitty", async () => {
		// The dual pi-tui instance hazard: caps seen by the extension are null,
		// while pi's own settings (and host rendering) say kitty.
		const { tool, ctx } = makeTool({ capsImages: null, hostImages: "kitty" });
		const result = await tool.execute("t16", { path: "pic.png" }, neverAbort(), noop as never, ctx);
		const details = result.details as ShowImageDetails;
		expect(details.mode).toBe("native");
		const images = result.content.filter((c) => c.type === "image");
		expect(images).toHaveLength(1);
		const text = result.content
			.filter((c) => c.type === "text")
			.map((c) => c.text)
			.join("\n");
		expect(text).toBe("Showed image pic.png to the user via terminal-native rendering.");
	});
	it("still chooses native when only PI_IMAGE_PROTOCOL names a supported protocol", async () => {
		const { tool, ctx } = makeTool({
			capsImages: null,
			hostImages: null,
			envProtocol: "iterm2",
		});
		const result = await tool.execute("t17", { path: "pic.png" }, neverAbort(), noop as never, ctx);
		expect((result.details as ShowImageDetails).mode).toBe("native");
	});
});

describe("show_image execute — forced native with images off degrades with a note (spec §7.2 row 3)", () => {
	it("delivers symbols, no throw, and surfaces the degradation note in the summary", async () => {
		const { tool, ctx } = makeTool({ capsImages: "kitty", showImages: false });
		const result = await tool.execute(
			"t18",
			{ path: "pic.png", format: "native" },
			neverAbort(),
			noop as never,
			ctx,
		);
		const details = result.details as ShowImageDetails;
		expect(details.mode).toBe("symbols");
		expect(details.payload).toBeDefined();
		expect(details.files[0]?.note).toBe(
			"format=native was requested but the host has images off; delivered as ANSI art",
		);
		const text = result.content
			.filter((c) => c.type === "text")
			.map((c) => c.text)
			.join("\n");
		expect(text).toContain(
			"Note: format=native was requested but the host has images off; delivered as ANSI art.",
		);
		expect(result.content.every((c) => c.type === "text")).toBe(true);
	});
	it("lets the more specific no-output note take precedence over the degradation note", async () => {
		const { tool, ctx } = makeTool({
			capsImages: "kitty",
			showImages: false,
			runStdout: "",
		});
		const result = await tool.execute(
			"t19",
			{ path: "pic.png", format: "native" },
			neverAbort(),
			noop as never,
			ctx,
		);
		expect((result.details as ShowImageDetails).files[0]?.note).toBe(
			"chafa produced no output",
		);
	});
});

describe("show_image execute — multi-image symbols output (#005)", () => {
	type Entry = { name: string; payload?: string; fail?: boolean };
	const ART_A = "\x1b[38;5;1mA\x1b[0m";
	const ART_B = "\x1b[38;5;2mB\x1b[0m";

	function multiTool(entries: Entry[]) {
		const paths = entries.map((entry) => join(dir, entry.name));
		const byPath = new Map(
			entries.map((entry, index) => [paths[index] as string, entry] as const),
		);
		return buildShowImageTool({
			resolveConfig: (perCall) => resolvedConfig(perCall),
			readHostImages: (): HostImageSettings => ({
				showImages: true,
				imageWidthCells: 60,
				images: null,
			}),
			capsImages: () => null,
			expandTargets: () => paths,
			readBytes: async () => Buffer.from(PNG_BASE64, "base64"),
			sniffMime: () => "image/png",
			probeChafa: async () => ({
				binary: "/usr/bin/chafa",
				version: { major: 1, minor: 18 },
			}),
			runChafa: async (_bin, args) => {
				const entry = byPath.get(args[args.length - 1] as string);
				if (entry?.fail) throw new Error("chafa exited with an error: boom");
				return entry?.payload ?? "";
			},
			cleanPayload: cleanSymbolsPayload,
		});
	}

	it("labels each block and separates them with exactly one blank line", async () => {
		const tool = multiTool([
			{ name: "a.png", payload: ART_A },
			{ name: "b.png", payload: ART_B },
		]);
		const result = await tool.execute(
			"m1",
			{ glob: "*.png" },
			neverAbort(),
			noop as never,
			makeCtx(true),
		);
		const payload = (result.details as ShowImageDetails).payload;
		expect(payload).toBe(`[a.png]\n${ART_A}\n\n[b.png]\n${ART_B}`);
		expect(payload?.match(/\n\n/g)).toHaveLength(1);
	});
	it("leaves a single-file payload unlabeled", async () => {
		const tool = multiTool([{ name: "a.png", payload: ART_A }]);
		const result = await tool.execute(
			"m2",
			{ glob: "*.png" },
			neverAbort(),
			noop as never,
			makeCtx(true),
		);
		expect((result.details as ShowImageDetails).payload).toBe(ART_A);
	});
	it("strips control characters and escapes from the label", async () => {
		const tool = multiTool([
			{ name: "a\u001b[31m.png", payload: ART_A },
			{ name: "b.png", payload: ART_B },
		]);
		const result = await tool.execute(
			"m3",
			{ glob: "*.png" },
			neverAbort(),
			noop as never,
			makeCtx(true),
		);
		const payload = (result.details as ShowImageDetails).payload as string;
		expect(payload).toContain("[a.png]");
		expect(payload).not.toContain("\u001b[31m");
	});
	it("contributes no block for a file whose chafa run produced nothing", async () => {
		const tool = multiTool([
			{ name: "a.png", payload: "" },
			{ name: "b.png", payload: ART_B },
		]);
		const result = await tool.execute(
			"m4",
			{ glob: "*.png" },
			neverAbort(),
			noop as never,
			makeCtx(true),
		);
		expect((result.details as ShowImageDetails).payload).toBe(`[b.png]\n${ART_B}`);
	});
	it("contributes no block for a per-file failure", async () => {
		const tool = multiTool([
			{ name: "a.png", payload: ART_A },
			{ name: "b.png", fail: true },
			{ name: "c.png", payload: ART_B },
		]);
		const result = await tool.execute(
			"m5",
			{ glob: "*.png" },
			neverAbort(),
			noop as never,
			makeCtx(true),
		);
		const details = result.details as ShowImageDetails;
		expect(details.payload).toBe(`[a.png]\n${ART_A}\n\n[c.png]\n${ART_B}`);
		expect(details.files.map((file) => file.ok)).toEqual([true, false, true]);
	});
});
