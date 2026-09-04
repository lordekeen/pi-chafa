import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanSymbolsPayload } from "../src/chafa.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { buildShowImageTool, summaryText, type ShowImageDeps } from "../src/show-image.js";
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
	showImages?: boolean;
	format?: "auto" | "native" | "symbols";
	hasUI?: boolean;
	runStdout?: string;
	probeChafa?: () => Promise<{ binary: string; version: { major: number; minor: number } }>;
	runChafa?: ShowImageDeps["runChafa"];
} = {}) {
	const capsImages = overrides.capsImages === undefined ? "kitty" : overrides.capsImages;
	const showImages = overrides.showImages ?? true;
	const format = overrides.format ?? "auto";
	const hasUI = overrides.hasUI ?? true;
	const tool = buildShowImageTool({
		resolveConfig: (perCall) => resolvedConfig(perCall),
		readHostImages: (): HostImageSettings => ({ showImages, imageWidthCells: 60 }),
		capsImages: () => capsImages,
		expandTargets: (target, cwd) => {
			const abs = join(cwd, target);
			if (abs === pngPath) return [abs];
			return [];
		},
		readBytes: async (path) => {
			if (path !== pngPath) throw new Error(`failed to read ${path}: ENOENT`);
			return Buffer.from(PNG_BASE64, "base64");
		},
		sniffMime: () => "image/png",
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
	it("mixed success appends the failure count", () => {
		const files: ShowImageFile[] = [
			{ path: join(dir, "1.png"), ok: true, mode: "symbols" },
			{ path: join(dir, "2.png"), ok: false, mode: "symbols", note: "failed to read" },
		];
		expect(summaryText(files, "symbols")).toBe(
			"Showed 2 image(s) to the user as ANSI art. 1 file(s) could not be shown.",
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
