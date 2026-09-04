import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, loadConfig } from "../src/config.js";
import {
	MENU,
	SETTING_DESCRIPTIONS,
	applyMenuChange,
	buildSettingItems,
	collectRuntimeFacts,
	createSettingsTheme,
	describeRuntime,
	runImagesCommand,
} from "../src/commands/images.js";
import { COLOR_MODES, DITHER_MODES, type ChafaConfig } from "../src/types.js";

describe("MENU", () => {
	it("covers every persistent config key a user may tune", () => {
		expect(MENU).toEqual([
			"Change cellWidth",
			"Change colors",
			"Change symbols set",
			"Change dither",
			"Change maxRows",
			"Toggle preferNative",
			"Set chafa binary path",
			"Runtime status",
			"Done",
		]);
	});
});

describe("SETTING_DESCRIPTIONS", () => {
	it("provides non-empty descriptions for all settings and actions", () => {
		const expectedKeys = [
			"preferNative",
			"colors",
			"dither",
			"symbolsSet",
			"cellWidth",
			"maxRows",
			"binaryPath",
			"runtimeStatus",
			"done",
		] as const;
		for (const key of expectedKeys) {
			expect(SETTING_DESCRIPTIONS[key]).toBeDefined();
			expect(SETTING_DESCRIPTIONS[key].length).toBeGreaterThan(10);
		}
	});
});

describe("buildSettingItems", () => {
	it("builds settings list items matching config and presets", () => {
		const config: ChafaConfig = {
			...DEFAULT_CONFIG,
			cellWidth: 80,
			maxRows: 75,
			preferNative: true,
			colors: "full",
			dither: "diffusion",
			symbolsSet: "ascii",
			binaryPath: "/usr/bin/chafa",
		};
		const items = buildSettingItems(config);
		expect(items.map((i) => i.id)).toEqual([
			"preferNative",
			"colors",
			"dither",
			"symbolsSet",
			"cellWidth",
			"maxRows",
			"binaryPath",
			"runtimeStatus",
			"done",
		]);

		const preferNativeItem = items.find((i) => i.id === "preferNative")!;
		expect(preferNativeItem.currentValue).toBe("true");
		expect(preferNativeItem.values).toEqual(["true", "false"]);
		expect(preferNativeItem.description).toBe(SETTING_DESCRIPTIONS.preferNative);

		const colorsItem = items.find((i) => i.id === "colors")!;
		expect(colorsItem.currentValue).toBe("full");
		expect(colorsItem.values).toEqual([...COLOR_MODES]);

		const ditherItem = items.find((i) => i.id === "dither")!;
		expect(ditherItem.currentValue).toBe("diffusion");
		expect(ditherItem.values).toEqual([...DITHER_MODES]);

		const symbolsItem = items.find((i) => i.id === "symbolsSet")!;
		expect(symbolsItem.currentValue).toBe("ascii");
		expect(symbolsItem.values).toContain("ascii");
		expect(symbolsItem.values).toContain("custom...");

		const cellWidthItem = items.find((i) => i.id === "cellWidth")!;
		expect(cellWidthItem.currentValue).toBe("80");
		expect(cellWidthItem.values).toContain("80");
		expect(cellWidthItem.values).toContain("custom...");

		const maxRowsItem = items.find((i) => i.id === "maxRows")!;
		expect(maxRowsItem.currentValue).toBe("75");
		expect(maxRowsItem.values).toContain("75");

		const binaryItem = items.find((i) => i.id === "binaryPath")!;
		expect(binaryItem.currentValue).toBe("/usr/bin/chafa");
		expect(binaryItem.values).toBeUndefined();
	});

	it("prepends custom numeric and symbol values when not in preset list", () => {
		const customConfig: ChafaConfig = {
			...DEFAULT_CONFIG,
			cellWidth: 77,
			maxRows: 99,
			symbolsSet: "braille+ascii",
			binaryPath: null,
		};
		const items = buildSettingItems(customConfig);
		const cellWidth = items.find((i) => i.id === "cellWidth")!;
		expect(cellWidth.values?.[0]).toBe("77");

		const maxRows = items.find((i) => i.id === "maxRows")!;
		expect(maxRows.values?.[0]).toBe("99");

		const symbols = items.find((i) => i.id === "symbolsSet")!;
		expect(symbols.values?.[0]).toBe("braille+ascii");

		const binary = items.find((i) => i.id === "binaryPath")!;
		expect(binary.currentValue).toBe("(auto on PATH)");
	});
});

describe("createSettingsTheme", () => {
	it("renders fallback formatting safely without theme functions", () => {
		const theme = createSettingsTheme();
		expect(theme.label("label", true)).toBe("label");
		expect(theme.label("label", false)).toBe("label");
		expect(theme.value("val", true)).toBe("val");
		expect(theme.value("val", false)).toBe("val");
		expect(theme.description("desc")).toBe("desc");
		expect(theme.cursor).toBe("→ ");
		expect(theme.hint("hint")).toBe("hint");
	});

	it("delegates to host theme fg and bold when provided", () => {
		const mockTheme = {
			fg: (color: string, text: string) => `[${color}]${text}`,
			bold: (text: string) => `*${text}*`,
		};
		const theme = createSettingsTheme(mockTheme);
		expect(theme.label("label", true)).toBe("*[accent]label*");
		expect(theme.label("label", false)).toBe("[text]label");
		expect(theme.value("val", true)).toBe("*[accent]val*");
		expect(theme.value("val", false)).toBe("[muted]val");
		expect(theme.description("desc")).toBe("[muted]desc");
		expect(theme.cursor).toBe("[accent]→ ");
		expect(theme.hint("hint")).toBe("[dim]hint");
	});
});

describe("applyMenuChange", () => {
	const base: ChafaConfig = { ...DEFAULT_CONFIG };

	it("parses numeric cellWidth and maxRows using legacy and canonical keys", () => {
		expect(applyMenuChange(base, "Change cellWidth", "  84  ")!.cellWidth).toBe(84);
		expect(applyMenuChange(base, "cellWidth", "100")!.cellWidth).toBe(100);
		expect(applyMenuChange(base, "Change cellWidth", "-5")).toBeNull();
		expect(applyMenuChange(base, "cellWidth", "abc")).toBeNull();

		expect(applyMenuChange(base, "Change maxRows", "  40  ")!.maxRows).toBe(40);
		expect(applyMenuChange(base, "maxRows", "65")!.maxRows).toBe(65);
		expect(applyMenuChange(base, "Change maxRows", "0")).toBeNull();
	});

	it("validates colors against the enum and rejects bad input", () => {
		expect(applyMenuChange(base, "Change colors", "16")!.colors).toBe("16");
		expect(applyMenuChange(base, "colors", "full")!.colors).toBe("full");
		expect(applyMenuChange(base, "Change colors", "neon")).toBeNull();
		expect(applyMenuChange(base, "colors", "")).toBeNull();
	});

	it("validates dither mode against the enum and rejects bad input", () => {
		expect(applyMenuChange(base, "Change dither", "diffusion")!.dither).toBe("diffusion");
		expect(applyMenuChange(base, "dither", "ordered")!.dither).toBe("ordered");
		expect(applyMenuChange(base, "Change dither", "invalid")).toBeNull();
	});

	it("validates symbolsSet rejects empty string", () => {
		expect(applyMenuChange(base, "Change symbols set", "ascii")!.symbolsSet).toBe("ascii");
		expect(applyMenuChange(base, "symbolsSet", "braille")!.symbolsSet).toBe("braille");
		expect(applyMenuChange(base, "symbolsSet", "   ")).toBeNull();
	});

	it("toggles preferNative without reading a value, or parses true/false", () => {
		expect(applyMenuChange(base, "Toggle preferNative", "")!.preferNative).toBe(false);
		expect(
			applyMenuChange({ ...base, preferNative: false }, "Toggle preferNative", "")!
				.preferNative,
		).toBe(true);
		expect(applyMenuChange(base, "preferNative", "true")!.preferNative).toBe(true);
		expect(applyMenuChange(base, "preferNative", "false")!.preferNative).toBe(false);
		expect(applyMenuChange(base, "preferNative", "")!.preferNative).toBe(false);
		expect(applyMenuChange(base, "preferNative", "maybe")).toBeNull();
	});

	it("accepts a binary path or clears it", () => {
		expect(
			applyMenuChange(base, "Set chafa binary path", "/opt/chafa")!.binaryPath,
		).toBe("/opt/chafa");
		expect(applyMenuChange(base, "binaryPath", "/usr/bin/chafa")!.binaryPath).toBe(
			"/usr/bin/chafa",
		);
		expect(applyMenuChange(base, "Set chafa binary path", "")!.binaryPath).toBeNull();
		expect(applyMenuChange(base, "binaryPath", "   ")!.binaryPath).toBeNull();
	});

	it("returns null for an unknown menu choice", () => {
		expect(applyMenuChange(base, "Nope", "")).toBeNull();
	});
});

describe("collectRuntimeFacts + describeRuntime", () => {
	it("reports protocol, showImages, pretty-read override, and chafa version", () => {
		const pi = {
			getAllTools: () => [
				{ name: "read", sourceInfo: { source: "pi-pretty" } },
				{ name: "bash", sourceInfo: { source: "builtin" } },
			],
		};
		const facts = collectRuntimeFacts(
			pi as never,
			"kitty",
			true,
			{ present: true, binary: "/usr/bin/chafa", version: "1.18.2" },
		);
		expect(facts.prettyRead).toBe(true);
		expect(describeRuntime(facts)).toEqual([
			"Detected image protocol: kitty",
			"Host showImages: on",
			"pi-pretty-style read override: detected",
			"chafa: 1.18.2 (/usr/bin/chafa)",
		]);
	});
	it("detects builtin read as no pretty override", () => {
		const pi = {
			getAllTools: () => [{ name: "read", sourceInfo: { source: "builtin" } }],
		};
		const facts = collectRuntimeFacts(pi as never, null, false, {
			present: false,
			error: "chafa was not found on PATH (looked for chafa).",
		});
		expect(facts.prettyRead).toBe(false);
		expect(describeRuntime(facts)).toEqual([
			"Detected image protocol: none",
			"Host showImages: off",
			"pi-pretty-style read override: not detected",
			"chafa: NOT FOUND — chafa was not found on PATH (looked for chafa).",
		]);
	});
});

describe("runImagesCommand", () => {
	let testDir: string;
	const originalConfigDir = process.env.CHAFA_CONFIG_DIR;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "pi-chafa-test-cmd-"));
		process.env.CHAFA_CONFIG_DIR = testDir;
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
		if (originalConfigDir !== undefined) {
			process.env.CHAFA_CONFIG_DIR = originalConfigDir;
		} else {
			delete process.env.CHAFA_CONFIG_DIR;
		}
	});

	it("runs in fallback mode and toggles preferNative and changes color mode", async () => {
		const pi = { getAllTools: () => [] };
		const notifyMock = vi.fn();
		const selectMock = vi
			.fn()
			.mockResolvedValueOnce(
				`Prefer native: [true] — ${SETTING_DESCRIPTIONS.preferNative}`,
			)
			.mockResolvedValueOnce(
				`Color mode: [240] — ${SETTING_DESCRIPTIONS.colors}`,
			)
			.mockResolvedValueOnce("16")
			.mockResolvedValueOnce(`Done — ${SETTING_DESCRIPTIONS.done}`);

		const ctx = {
			ui: {
				select: selectMock,
				notify: notifyMock,
				input: vi.fn(),
			},
		};

		await runImagesCommand(pi as never, "", ctx as never);

		const updated = loadConfig(testDir);
		expect(updated.preferNative).toBe(false);
		expect(updated.colors).toBe("16");
		expect(notifyMock).toHaveBeenCalledWith(
			expect.stringContaining("preferNative is now false"),
			"info",
		);
		expect(notifyMock).toHaveBeenCalledWith(
			expect.stringContaining("color mode is now 16"),
			"info",
		);
	});

	it("runs in custom TUI mode and mounts SettingsList", async () => {
		const pi = { getAllTools: () => [] };
		const notifyMock = vi.fn();
		let componentCreated: { render: (w: number) => string[] } | undefined;

		const customMock = vi.fn().mockImplementation(async (cb) => {
			const tui = { requestRender: vi.fn() };
			const theme = {
				fg: (_c: string, text: string) => text,
				bold: (text: string) => text,
			};
			componentCreated = cb(tui, theme, {}, () => {});
			return { action: "done" };
		});

		const ctx = {
			ui: {
				custom: customMock,
				select: vi.fn(),
				notify: notifyMock,
				input: vi.fn(),
			},
		};

		await runImagesCommand(pi as never, "", ctx as never);

		expect(customMock).toHaveBeenCalledTimes(1);
		expect(componentCreated).toBeDefined();
		expect(typeof componentCreated?.render).toBe("function");
		const rendered = componentCreated?.render(80);
		expect(rendered?.join("\n")).toContain("pi-chafa Settings");
	});
});

