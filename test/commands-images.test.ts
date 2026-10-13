import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSettingsListTheme, initTheme, keyText } from "@earendil-works/pi-coding-agent";
import {
	getKeybindings,
	KeybindingsManager,
	setKeybindings,
	TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, loadConfig, resolveConfig, writeConfigFile } from "../src/config.js";
import {
	SETTING_DESCRIPTIONS,
	SETTING_KEYS,
	IMAGES_USAGE,
	applyMenuChange,
	buildSettingItems,
	collectRuntimeFacts,
	controlCharReason,
	defaultImagesDeps,
	describeRuntime,
	type ImagesCommandDeps,
	nearMiss,
	parseSettingArg,
	resolveRuntimeCaps,
	runImagesCommand as runImagesCommandRaw,
	runtimeStatusSubmenu,
} from "../src/commands/images.js";
import { COLOR_MODES, DITHER_MODES, type ChafaConfig } from "../src/types.js";

/** A synthetic successful probe — the suite must never spawn the real chafa (#019). */
const FAKE_PROBE = {
	binary: "chafa",
	version: { major: 1, minor: 18 },
	loaders: ["PNG", "JPEG", "GIF", "WEBP"],
};

/**
 * Plain row theme for the panel (#051). Production defaults to the host's
 * `getSettingsListTheme()`, which throws until the host has initialised a theme
 * ("Theme not initialized"); this suite must stay hermetic, so every call
 * injects this instead of a theme that needs a running host.
 */
const PLAIN_SETTINGS_THEME = {
	label: (text: string) => text,
	value: (text: string) => text,
	description: (text: string) => text,
	cursor: "→ ",
	hint: (text: string) => text,
};

/**
 * Hermetic `/images` invocation (#019). Production defaults would spawn the real
 * `chafa --version` and read the developer's real `~/.pi/agent/settings.json`,
 * so every call in this file injects fakes instead. The seam is asserted by the
 * "uses the injected deps" test in the `runImagesCommand` suite.
 */
const runImagesCommand = (
	pi: unknown,
	args: string,
	ctx: unknown,
	overrides: Partial<ImagesCommandDeps> = {},
): Promise<void> =>
	runImagesCommandRaw(pi as never, args as never, ctx as never, {
		probeChafa: async () => FAKE_PROBE,
		readHostImageSettings: () => ({
			showImages: true,
			imageWidthCells: 60,
			images: null,
		}),
		capsImages: () => null,
		settingsListTheme: () => PLAIN_SETTINGS_THEME,
		...overrides,
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
			"timeoutMs",
			"binaryPath",
			"runtimeStatus",
		] as const;
		for (const key of expectedKeys) {
			expect(SETTING_DESCRIPTIONS[key]).toBeDefined();
			expect(SETTING_DESCRIPTIONS[key].length).toBeGreaterThan(10);
		}
	});
});

describe("buildSettingItems", () => {
	it("strips control characters from the free-text values it renders (#060)", () => {
		// The funnel refuses NEW ones, but a hand-edited pi-chafa.json can still hold
		// them, and these strings go straight into a row's Text — and into the
		// fallback's option labels, which interpolate the same currentValue.
		const items = buildSettingItems({
			...DEFAULT_CONFIG,
			symbolsSet: "ascii\u001b[31m",
			binaryPath: "/evil\u001b[2Jbin/chafa",
		});
		const symbols = items.find((i) => i.id === "symbolsSet")!;
		const binary = items.find((i) => i.id === "binaryPath")!;
		expect(symbols.currentValue).toBe("ascii");
		expect(binary.currentValue).toBe("/evilbin/chafa");
		// The ladder is offered for cycling, so it cannot carry the raw value either:
		// staging it would be refused by the funnel and the row would look stuck.
		expect(symbols.values?.some((value) => value.includes("\u001b"))).toBe(false);
		expect(binary.values?.some((value) => value.includes("\u001b"))).toBe(false);
	});

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
			"timeoutMs",
			"binaryPath",
			"runtimeStatus",
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
		expect(symbolsItem.values).not.toContain("custom...");

		const cellWidthItem = items.find((i) => i.id === "cellWidth")!;
		expect(cellWidthItem.currentValue).toBe("80");
		expect(cellWidthItem.values).toContain("80");
		expect(cellWidthItem.values).not.toContain("custom...");

		const maxRowsItem = items.find((i) => i.id === "maxRows")!;
		expect(maxRowsItem.currentValue).toBe("75");
		expect(maxRowsItem.values).toContain("75");
		expect(maxRowsItem.values).not.toContain("custom...");

		const timeoutItem = items.find((i) => i.id === "timeoutMs")!;
		expect(timeoutItem.currentValue).toBe("8000");
		expect(timeoutItem.values).toEqual([
			"2000",
			"4000",
			"8000",
			"15000",
			"30000",
			"60000",
		]);
		expect(timeoutItem.description).toBe(SETTING_DESCRIPTIONS.timeoutMs);

		const binaryItem = items.find((i) => i.id === "binaryPath")!;
		expect(binaryItem.currentValue).toBe("/usr/bin/chafa");
		expect(binaryItem.values).toEqual(["(auto on PATH)", "/usr/bin/chafa"]);
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

		const timeout = items.find((i) => i.id === "timeoutMs")!;
		expect(timeout.currentValue).toBe("8000");
		expect(timeout.values?.[0]).toBe("2000");

		const symbols = items.find((i) => i.id === "symbolsSet")!;
		expect(symbols.values?.[0]).toBe("braille+ascii");

		const binary = items.find((i) => i.id === "binaryPath")!;
		expect(binary.currentValue).toBe("(auto on PATH)");
	});

	it("prepends a custom timeoutMs when it is not in the preset ladder", () => {
		const customTimeout: ChafaConfig = { ...DEFAULT_CONFIG, timeoutMs: 12345 };
		const items = buildSettingItems(customTimeout);
		const timeout = items.find((i) => i.id === "timeoutMs")!;
		expect(timeout.currentValue).toBe("12345");
		expect(timeout.values?.[0]).toBe("12345");
		expect(timeout.values?.length).toBe(7);
	});
});

describe("defaultImagesDeps", () => {
	// This must stay FIRST in the describe: initTheme() below sets a process-global
	// theme that never gets unset, and the fallback path is only reachable before it.
	it("degrades to unstyled rows when the host has no theme yet (#051)", () => {
		const plain = defaultImagesDeps().settingsListTheme();
		expect(plain.label("label", true)).toBe("label");
		expect(plain.value("val", true)).toBe("val");
		expect(plain.description("desc")).toBe("desc");
		expect(plain.cursor).toBe("→ ");
		expect(plain.hint("hint")).toBe("hint");
	});

	it("wires the host's getSettingsListTheme for the panel rows (#051)", () => {
		// Hermetic: the system theme is built into the host package (createSystemTheme),
		// so initTheme() reads nothing from the developer's disk or config dir.
		initTheme();
		const theme = defaultImagesDeps().settingsListTheme();
		const host = getSettingsListTheme();
		expect(theme.label("label", true)).toBe(host.label("label", true));
		expect(theme.label("label", false)).toBe(host.label("label", false));
		expect(theme.value("val", false)).toBe(host.value("val", false));
		expect(theme.description("desc")).toBe(host.description("desc"));
		expect(theme.cursor).toBe(host.cursor);
		expect(theme.hint("hint")).toBe(host.hint("hint"));
	});
});

describe("applyMenuChange", () => {
	const base: ChafaConfig = { ...DEFAULT_CONFIG };

	it("parses numeric cellWidth, maxRows, and timeoutMs", () => {
		expect(applyMenuChange(base, "cellWidth", "  84  ")!.cellWidth).toBe(84);
		expect(applyMenuChange(base, "cellWidth", "100")!.cellWidth).toBe(100);
		expect(applyMenuChange(base, "cellWidth", "-5")).toBeNull();
		expect(applyMenuChange(base, "cellWidth", "abc")).toBeNull();

		expect(applyMenuChange(base, "maxRows", "  40  ")!.maxRows).toBe(40);
		expect(applyMenuChange(base, "maxRows", "65")!.maxRows).toBe(65);
		expect(applyMenuChange(base, "maxRows", "0")).toBeNull();

		expect(applyMenuChange(base, "timeoutMs", " 2000 ")!.timeoutMs).toBe(2000);
		expect(applyMenuChange(base, "timeoutMs", "60000")!.timeoutMs).toBe(60000);
		expect(applyMenuChange(base, "timeoutMs", "0")).toBeNull();
		expect(applyMenuChange(base, "timeoutMs", "1.5")).toBeNull();
		expect(applyMenuChange(base, "timeoutMs", "fast")).toBeNull();
	});

	it("validates colors against the enum and rejects bad input", () => {
		expect(applyMenuChange(base, "colors", "16")!.colors).toBe("16");
		expect(applyMenuChange(base, "colors", "full")!.colors).toBe("full");
		expect(applyMenuChange(base, "colors", "neon")).toBeNull();
		expect(applyMenuChange(base, "colors", "")).toBeNull();
	});

	it("validates dither mode against the enum and rejects bad input", () => {
		expect(applyMenuChange(base, "dither", "diffusion")!.dither).toBe("diffusion");
		expect(applyMenuChange(base, "dither", "ordered")!.dither).toBe("ordered");
		expect(applyMenuChange(base, "dither", "invalid")).toBeNull();
	});

	it("validates symbolsSet rejects empty string", () => {
		expect(applyMenuChange(base, "symbolsSet", "ascii")!.symbolsSet).toBe("ascii");
		expect(applyMenuChange(base, "symbolsSet", "braille")!.symbolsSet).toBe("braille");
		expect(applyMenuChange(base, "symbolsSet", "   ")).toBeNull();
	});

	it("toggles preferNative without reading a value, or parses true/false", () => {
		expect(applyMenuChange(base, "preferNative", "")!.preferNative).toBe(false);
		expect(
			applyMenuChange({ ...base, preferNative: false }, "preferNative", "")!
				.preferNative,
		).toBe(true);
		expect(applyMenuChange(base, "preferNative", "true")!.preferNative).toBe(true);
		expect(applyMenuChange(base, "preferNative", "false")!.preferNative).toBe(false);
		expect(applyMenuChange(base, "preferNative", "maybe")).toBeNull();
	});

	it("accepts a binary path or clears it", () => {
		expect(applyMenuChange(base, "binaryPath", "/opt/chafa")!.binaryPath).toBe(
			"/opt/chafa",
		);
		expect(applyMenuChange(base, "binaryPath", "/usr/bin/chafa")!.binaryPath).toBe(
			"/usr/bin/chafa",
		);
		expect(applyMenuChange(base, "binaryPath", "")!.binaryPath).toBeNull();
		expect(applyMenuChange(base, "binaryPath", "(auto on PATH)")!.binaryPath).toBeNull();
		expect(applyMenuChange(base, "binaryPath", "   ")!.binaryPath).toBeNull();
	});

	it("returns null for an unknown menu choice", () => {
		expect(applyMenuChange(base, "Nope", "")).toBeNull();
	});

	it("refuses a value carrying control characters for every key (#060)", () => {
		// A valid value per key, so what refuses it is the control character and
		// nothing else. Without the guard, symbolsSet and binaryPath accept the
		// smuggled byte verbatim (their validators take any non-empty string); the
		// other six are already refused by their own validators, so the guard is
		// what makes the contract uniform across every key.
		const embeddable: Record<string, string> = {
			preferNative: "true",
			colors: "16",
			dither: "ordered",
			symbolsSet: "ascii",
			cellWidth: "84",
			maxRows: "40",
			timeoutMs: "2000",
			binaryPath: "/opt/chafa",
		};
		for (const key of SETTING_KEYS) {
			expect(applyMenuChange(base, key, `${embeddable[key]}\u001b`)).toBeNull();
		}
		// A bare control character, and one trim() would not remove from an end.
		expect(applyMenuChange(base, "symbolsSet", "\u0007")).toBeNull();
		expect(applyMenuChange(base, "binaryPath", "\u001b/opt/chafa")).toBeNull();
		// Raw, not post-trim: the CLI path already checks the value as typed, and
		// one rule for both paths is the point of the guard.
		expect(applyMenuChange(base, "cellWidth", "84\n")).toBeNull();
	});
});

describe("parseSettingArg (#050)", () => {
	it("accepts a valid value for every setting key", () => {
		const cases: Array<[string, string, Partial<ChafaConfig>]> = [
			["preferNative", "true", { preferNative: true }],
			["colors", "8", { colors: "8" }],
			["dither", "ordered", { dither: "ordered" }],
			["symbolsSet", "block", { symbolsSet: "block" }],
			["cellWidth", "72", { cellWidth: 72 }],
			["maxRows", "40", { maxRows: 40 }],
			["timeoutMs", "5000", { timeoutMs: 5000 }],
			["binaryPath", "/opt/chafa", { binaryPath: "/opt/chafa" }],
		];
		// The table is only complete while it covers the whole accepted key set.
		expect(cases.map(([key]) => key)).toEqual([...SETTING_KEYS]);
		for (const [key, value, expected] of cases) {
			const result = parseSettingArg(DEFAULT_CONFIG, key, value);
			expect(result.ok).toBe(true);
			if (result.ok) expect(result.next).toMatchObject(expected);
		}
	});

	it("matches the key case-insensitively", () => {
		const result = parseSettingArg(DEFAULT_CONFIG, "CellWidth", "72");
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.next.cellWidth).toBe(72);
	});

	it("toggles preferNative and clears binaryPath when no value is given", () => {
		const toggled = parseSettingArg(DEFAULT_CONFIG, "preferNative", "");
		expect(toggled.ok).toBe(true);
		if (toggled.ok) {
			expect(toggled.next.preferNative).toBe(!DEFAULT_CONFIG.preferNative);
		}
		const cleared = parseSettingArg(
			{ ...DEFAULT_CONFIG, binaryPath: "/opt/chafa" },
			"binaryPath",
			"",
		);
		expect(cleared.ok).toBe(true);
		if (cleared.ok) expect(cleared.next.binaryPath).toBeNull();
	});

	it("rejects a bad value with the field's own reason", () => {
		const cases: Array<[string, string, string]> = [
			["preferNative", "maybe", "true or false"],
			["colors", "chartreuse", "expected one of"],
			["dither", "bayer", "expected one of"],
			["symbolsSet", "   ", "non-empty"],
			["cellWidth", "0", "positive integer"],
			["cellWidth", "abc", "positive integer"],
			["maxRows", "-3", "positive integer"],
			["timeoutMs", "1.5", "positive integer"],
		];
		for (const [key, value, needle] of cases) {
			const result = parseSettingArg(DEFAULT_CONFIG, key, value);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reason).toContain(key);
				expect(result.reason).toContain(needle);
			}
		}
	});

	it("names the accepted keys for an unknown setting", () => {
		const result = parseSettingArg(DEFAULT_CONFIG, "colours", "8");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toContain("colours");
			for (const key of SETTING_KEYS) expect(result.reason).toContain(key);
		}
	});

	it("refuses a value carrying control characters instead of storing them (invariant 3)", () => {
		const result = parseSettingArg(DEFAULT_CONFIG, "symbolsSet", "\u001b[31mblock");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).not.toContain("\u001b");
	});

	it("never mutates the config it was given", () => {
		const before = structuredClone(DEFAULT_CONFIG);
		parseSettingArg(DEFAULT_CONFIG, "cellWidth", "72");
		parseSettingArg(DEFAULT_CONFIG, "colors", "chartreuse");
		expect(DEFAULT_CONFIG).toEqual(before);
	});
});

describe("resolveRuntimeCaps", () => {
	it("reports the host getCapabilities() value when it is non-null", () => {
		expect(resolveRuntimeCaps("kitty", "iterm2", "iterm2")).toEqual({
			capsImages: "kitty",
			capsSource: "getCapabilities()",
		});
	});
	it("falls back to terminal.images when caps is null (dual-instance hazard)", () => {
		expect(resolveRuntimeCaps(null, "iterm2", undefined)).toEqual({
			capsImages: "iterm2",
			capsSource: "terminal.images",
		});
	});
	it("falls back to PI_IMAGE_PROTOCOL when caps and settings are empty", () => {
		expect(resolveRuntimeCaps(null, null, "kitty")).toEqual({
			capsImages: "kitty",
			capsSource: "PI_IMAGE_PROTOCOL",
		});
	});
	it("reports none when the #026 environment guard denies a declaration", () => {
		expect(
			resolveRuntimeCaps(null, "kitty", "kitty", { TERM_PROGRAM: "alacritty" }, "linux"),
		).toEqual({ capsImages: null, capsSource: "none" });
	});
	it("reports PI_IMAGE_PROTOCOL provenance for the tmux opt-in (#026)", () => {
		expect(
			resolveRuntimeCaps(
				null,
				"kitty",
				"kitty",
				{ TMUX: "/tmp/tmux-1000/default,1,0" },
				"linux",
			),
		).toEqual({ capsImages: "kitty", capsSource: "PI_IMAGE_PROTOCOL" });
	});
	it("reports none when no source yields a protocol", () => {
		expect(resolveRuntimeCaps(null, null, undefined)).toEqual({
			capsImages: null,
			capsSource: "none",
		});
		expect(resolveRuntimeCaps(null, null, "none")).toEqual({
			capsImages: null,
			capsSource: "none",
		});
	});
});

describe("collectRuntimeFacts + describeRuntime", () => {
	it("reports effective protocol, source, showImages, pretty-read, and chafa version", () => {
		const pi = {
			getAllTools: () => [
				{ name: "read", sourceInfo: { source: "pi-pretty" } },
				{ name: "bash", sourceInfo: { source: "builtin" } },
			],
		};
		const facts = collectRuntimeFacts(
			pi as never,
			resolveRuntimeCaps(null, "kitty", undefined),
			true,
			{ present: true, binary: "/usr/bin/chafa", version: "1.18.2" },
		);
		expect(facts.prettyRead).toBe(true);
		expect(describeRuntime(facts)).toEqual([
			"Detected image protocol: kitty (source: terminal.images)",
			"Host showImages: on",
			"pi-pretty-style read override: detected",
			"chafa: 1.18.2 (/usr/bin/chafa)",
		]);
	});
	it("detects builtin read as no pretty override", () => {
		const pi = {
			getAllTools: () => [{ name: "read", sourceInfo: { source: "builtin" } }],
		};
		const facts = collectRuntimeFacts(
			pi as never,
			resolveRuntimeCaps(null, null, undefined),
			false,
			{
				present: false,
				error: "chafa was not found on PATH (looked for chafa).",
			},
		);
		expect(facts.prettyRead).toBe(false);
		expect(describeRuntime(facts)).toEqual([
			"Detected image protocol: none",
			"Host showImages: off",
			"pi-pretty-style read override: not detected",
			"chafa: NOT FOUND — chafa was not found on PATH (looked for chafa).",
		]);
	});
});

describe("nearMiss (#055)", () => {
	it("corrects typos, prefixes and trailing text", () => {
		expect(nearMiss("statu")).toBe("status");
		expect(nearMiss("STATU")).toBe("status");
		expect(nearMiss("statsu")).toBe("status"); // transposition
		expect(nearMiss("statuses")).toBe("status"); // extra text
		expect(nearMiss(" status ")).toBeUndefined(); // trims to the exact token
	});

	it("stays silent rather than inventing a correction", () => {
		expect(nearMiss("bogus")).toBeUndefined();
		expect(nearMiss("st")).toBeUndefined(); // too short to guess from
		expect(nearMiss("status")).toBeUndefined(); // not a miss at all
		expect(nearMiss("")).toBeUndefined();
	});
});

describe("runtimeStatusSubmenu (#049)", () => {
	const LINES = ["Detected image protocol: kitty", "chafa: 1.18 (chafa)"];

	it("renders the fact lines that replace the rows", () => {
		const component = runtimeStatusSubmenu(LINES, getKeybindings(), () => {});
		expect(component.render(80).join("\n")).toContain("Detected image protocol: kitty");
		expect(component.render(80).join("\n")).toContain("chafa: 1.18 (chafa)");
	});

	it("closes itself on cancel, Enter, Space and q", () => {
		// An open submenu receives every key the wrapper does not claim for itself
		// (Ctrl+S and `e`), so a submenu that does not close itself is a dead end. `q`
		// belongs on this list because the wrapper delegates it WHILE a submenu is open
		// (#062) — otherwise the wrapper's own q branch would swallow it and discard the
		// draft, contradicting #048's "q is an exact alias of Esc".
		for (const key of ["\x1b", "\r", " ", "q"]) {
			const close = vi.fn();
			runtimeStatusSubmenu(LINES, getKeybindings(), close).handleInput?.(key);
			expect(close).toHaveBeenCalledTimes(1);
		}
	});

	it("ignores a stray key rather than closing on anything", () => {
		const close = vi.fn();
		runtimeStatusSubmenu(LINES, getKeybindings(), close).handleInput?.("j");
		expect(close).not.toHaveBeenCalled();
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
			mode: "rpc",
			hasUI: true,
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
			componentCreated = cb(tui, theme, getKeybindings(), () => {});
			return { action: "done" };
		});

		const ctx = {
			mode: "tui",
			hasUI: true,
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
		expect(rendered?.join("\n")).not.toContain("⚙"); // ASCII-safe caption (#041)
	});

	it("opens the field picker for 'e' with no highlight involved, under a remap (#052)", async () => {
		const originalKb = getKeybindings();
		const remapped = new KeybindingsManager(TUI_KEYBINDINGS, {
			...originalKb.getResolvedBindings(),
			"tui.select.up": "ctrl+p",
			"tui.select.down": "ctrl+n",
		});
		setKeybindings(remapped);
		const selectMock = vi.fn().mockResolvedValue(undefined); // dismiss the picker
		const inputMock = vi.fn();
		let resolvePanel: (r: unknown) => void = () => {};
		let mounted: { handleInput: (d: string) => void } | undefined;
		try {
			const customMock = vi.fn().mockImplementation(async (cb) => {
				const component = cb(
					{ requestRender: vi.fn() },
					{
						fg: (_c: string, text: string) => text,
						bold: (text: string) => text,
					},
					getKeybindings(),
					(r: unknown) => resolvePanel(r),
				) as { handleInput: (d: string) => void };
				mounted = component;
				if (customMock.mock.calls.length === 1) {
					// Wire the resolver BEFORE pressing 'e': done() fires during the
					// simulation and must land on a live resolver.
					const promise = new Promise((res) => {
						resolvePanel = res;
					});
					// 'e' no longer consults the highlight: no navigation keys pressed.
					component.handleInput("e");
					return promise;
				}
				return { action: "done" };
			});
			const run = runImagesCommand(
				{ getAllTools: () => [] } as never,
				"",
				{
					mode: "tui",
					hasUI: true,
					ui: {
						custom: customMock,
						select: selectMock,
						notify: vi.fn(),
						input: inputMock,
					},
				} as never,
			);
			await vi.waitFor(() => {
				expect(selectMock).toHaveBeenCalledTimes(1);
			});
			expect(mounted).toBeDefined();
			expect(selectMock.mock.calls[0]?.[0]).toBe("Edit which setting?");
			expect(selectMock.mock.calls[0]?.[1]).toEqual([
				"Cell width",
				"Max rows",
				"Timeout (ms)",
				"Symbols set",
				"Binary path",
			]);
			// Dismissing the picker stages nothing and opens no field dialog.
			expect(inputMock).not.toHaveBeenCalled();
			resolvePanel({ action: "done" });
			await run;
		} finally {
			setKeybindings(originalKb);
		}
	});

	it("names the footer keys from the live bindings under a remap (#053)", async () => {
		const originalKb = getKeybindings();
		const remapped = new KeybindingsManager(TUI_KEYBINDINGS, {
			...originalKb.getResolvedBindings(),
			"tui.select.up": "ctrl+p",
			"tui.select.down": "ctrl+n",
			"tui.select.cancel": "ctrl+g",
		});
		setKeybindings(remapped);
		let rendered: string[] = [];
		try {
			const customMock = vi.fn().mockImplementation(async (cb) => {
				const component = cb(
					{ requestRender: vi.fn() },
					{
						fg: (_c: string, text: string) => text,
						bold: (text: string) => text,
					},
					getKeybindings(),
					() => {},
				) as { render: (w: number) => string[] };
				rendered = component.render(80);
				return { action: "cancelled" };
			});
			await runImagesCommand(
				{ getAllTools: () => [] } as never,
				"",
				{
					mode: "tui",
					hasUI: true,
					ui: {
						custom: customMock,
						select: vi.fn(),
						notify: vi.fn(),
						input: vi.fn(),
					},
				} as never,
			);
		} finally {
			setKeybindings(originalKb);
		}
		const footer = rendered.join("\n");
		expect(footer).toContain("ctrl+p/ctrl+n navigate");
		expect(footer).toContain("ctrl+g/q close");
		expect(footer).not.toContain("up/down navigate");
		expect(footer).not.toContain("escape");
	});

	it("opens the runtime facts as an in-panel submenu instead of a dialog (#049)", async () => {
		const selectMock = vi.fn();
		let rendered: string[] = [];
		const customMock = vi.fn().mockImplementation(async (cb) => {
			const component = cb(
				{ requestRender: vi.fn() },
				{
					fg: (_c: string, text: string) => text,
					bold: (text: string) => text,
				},
				getKeybindings(),
				() => {},
			) as { handleInput: (d: string) => void; render: (w: number) => string[] };
			for (let i = 0; i < 8; i++) component.handleInput("\x1b[B"); // → Runtime status
			component.handleInput("\r"); // Enter: the list owns activation now
			rendered = component.render(80);
			return { action: "cancelled" };
		});
		await runImagesCommand(
			{ getAllTools: () => [] } as never,
			"",
			{
				mode: "tui",
				hasUI: true,
				ui: {
					custom: customMock,
					select: selectMock,
					notify: vi.fn(),
					input: vi.fn(),
				},
			} as never,
		);
		// An open submenu renders in place of the rows, so the facts are visible in-panel…
		expect(rendered.join("\n")).toContain("Detected image protocol: ");
		expect(rendered.join("\n")).toContain("Host showImages: ");
		// …and nothing opened a dialog for them any more.
		expect(selectMock).not.toHaveBeenCalled();
	});

	it("forwards mouse press and wheel to the list, so activation follows the pointer (#049)", async () => {
		let panel:
			| {
					handleMouse?: (e: Record<string, unknown>) => unknown;
					handleInput: (d: string) => void;
					render: (w: number) => string[];
			  }
			| undefined;
		let lines: string[] = [];
		const customMock = vi.fn().mockImplementation(async (cb) => {
			const component = cb(
				{ requestRender: vi.fn() },
				{
					fg: (_c: string, text: string) => text,
					bold: (text: string) => text,
				},
				getKeybindings(),
				() => {},
			) as NonNullable<typeof panel>;
			panel = component;
			lines = component.render(80);
			return { action: "cancelled" };
		});
		await runImagesCommand(
			{ getAllTools: () => [] } as never,
			"",
			{
				mode: "tui",
				hasUI: true,
				ui: {
					custom: customMock,
					select: vi.fn(),
					notify: vi.fn(),
					input: vi.fn(),
				},
			} as never,
		);
		// Mouse only reaches the mounted component, so this is what proves the panel is
		// the Container rather than a plain object wrapping one.
		expect(panel?.handleMouse).toBeTypeOf("function");
		const mouse = (type: string, y: number, wheelDelta = 0) => ({
			type,
			button: "left",
			x: 0,
			y,
			screenX: 0,
			screenY: 0,
			width: 80,
			height: lines.length,
			shift: false,
			alt: false,
			ctrl: false,
			wheelDelta,
		});
		const cursorAt = () => lines.findIndex((line) => line.includes("→ "));
		// The chrome above the list (the frame rule, the title, its spacer) is not what
		// this test is about, so anchor on the live cursor line rather than an offset.
		const listTop = cursorAt();
		expect(lines[listTop]).toContain("Prefer native");
		// A press selects the row under the pointer (Dither mode is row 2)…
		const ditherY = listTop + 2;
		panel?.handleMouse?.(mouse("press", ditherY));
		lines = panel?.render(80) ?? [];
		expect(cursorAt()).toBe(ditherY);
		// …and Enter then acts on THAT row instead of a stale keyboard cursor.
		panel?.handleInput("\r");
		lines = panel?.render(80) ?? [];
		expect(lines[ditherY]).toContain("ordered"); // dither: none → ordered
		// Wheel moves the selection by one; the list clamps at the ends.
		panel?.handleMouse?.(mouse("wheel", ditherY, 1));
		lines = panel?.render(80) ?? [];
		expect(cursorAt()).toBe(ditherY + 1);
	});

	it("themes and aligns the title, and puts the key hint under the list (#056)", async () => {
		let rendered: string[] = [];
		const customMock = vi.fn().mockImplementation(async (cb) => {
			const component = cb(
				{ requestRender: vi.fn() },
				{
					fg: (_c: string, text: string) => text,
					bold: (text: string) => `*${text}*`,
				},
				getKeybindings(),
				() => {},
			) as { render: (w: number) => string[] };
			rendered = component.render(80);
			return { action: "cancelled" };
		});
		await runImagesCommand(
			{ getAllTools: () => [] } as never,
			"",
			{
				mode: "tui",
				hasUI: true,
				ui: {
					custom: customMock,
					select: vi.fn(),
					notify: vi.fn(),
					input: vi.fn(),
				},
			} as never,
		);
		// Themed bold, in the same two-column gutter the list's rows use.
		const titleLine = rendered.find((line) => line.includes("pi-chafa Settings"));
		expect(titleLine).toContain("*pi-chafa Settings*");
		expect(titleLine?.startsWith("  *")).toBe(true);
		// The panel's key hint sits below the rows (and below the host's own line).
		const rowIndex = rendered.findIndex((line) => line.includes("Prefer native"));
		const hintIndex = rendered.findIndex((line) => line.includes("navigate"));
		expect(rowIndex).toBeGreaterThan(-1);
		expect(hintIndex).toBeGreaterThan(rowIndex);
	});

	it("frames the panel with the host's full-width rule top and bottom (#057)", async () => {
		let rendered: string[] = [];
		const customMock = vi.fn().mockImplementation(async (cb) => {
			const component = cb(
				{ requestRender: vi.fn() },
				{
					fg: (_c: string, text: string) => text,
					bold: (text: string) => `*${text}*`,
				},
				getKeybindings(),
				() => {},
			) as { render: (w: number) => string[] };
			rendered = component.render(80);
			return { action: "cancelled" };
		});
		await runImagesCommand(
			{ getAllTools: () => [] } as never,
			"",
			{
				mode: "tui",
				hasUI: true,
				ui: {
					custom: customMock,
					select: vi.fn(),
					notify: vi.fn(),
					input: vi.fn(),
				},
			} as never,
		);
		// The host's DynamicBorder renders one full-width rule: the panel opens and
		// closes with it, exactly as pi's own /settings panel does (settings-selector).
		expect(rendered[0]).toBe("─".repeat(80));
		expect(rendered[rendered.length - 1]).toBe("─".repeat(80));
		// The title sits inside the frame, not above it.
		expect(rendered[1]).toContain("*pi-chafa Settings*");
	});

	it("prints runtime status for an explicit 'status' argument without opening the panel (#016)", async () => {
		const pi = { getAllTools: () => [] };
		const notifyMock = vi.fn();
		const customMock = vi.fn();
		const selectMock = vi.fn();
		const ctx = {
			mode: "tui",
			hasUI: true,
			ui: { custom: customMock, select: selectMock, notify: notifyMock, input: vi.fn() },
		};

		await runImagesCommand(pi as never, "status", ctx as never);

		expect(customMock).not.toHaveBeenCalled();
		expect(selectMock).not.toHaveBeenCalled();
		expect(notifyMock).toHaveBeenCalledTimes(1);
		const [message, level] = notifyMock.mock.calls[0] as [string, string];
		expect(level).toBe("info");
		expect(message).toContain("Detected image protocol:");
		expect(message).toContain("Host showImages:");
		expect(message).toContain("pi-pretty-style read override:");
		expect(message).toContain("chafa:");
		expect(message.split("\n")).toHaveLength(4);
	});

	it("accepts the status argument case-insensitively and trimmed (#016)", async () => {
		const pi = { getAllTools: () => [] };
		for (const arg of ["STATUS", "  Status  ", "status"]) {
			const notifyMock = vi.fn();
			const customMock = vi.fn();
			await runImagesCommand(pi as never, arg, {
				mode: "tui",
				hasUI: true,
				ui: { custom: customMock, select: vi.fn(), notify: notifyMock, input: vi.fn() },
			} as never);
			expect(customMock).not.toHaveBeenCalled();
			expect(notifyMock).toHaveBeenCalledTimes(1);
		}
	});

	it("sets any of the eight settings from one command-line argument (#050)", async () => {
		const writer = vi.fn(writeConfigFile);
		const notifyMock = vi.fn();
		const customMock = vi.fn();
		const ctx = {
			mode: "tui",
			hasUI: true,
			ui: {
				custom: customMock,
				select: vi.fn(),
				notify: notifyMock,
				input: vi.fn(),
			},
		};
		const cases: Array<[string, keyof ChafaConfig, unknown]> = [
			["preferNative true", "preferNative", true],
			["colors 8", "colors", "8"],
			["dither ordered", "dither", "ordered"],
			["symbolsSet block", "symbolsSet", "block"],
			["cellWidth 72", "cellWidth", 72],
			["maxRows 40", "maxRows", 40],
			["timeoutMs 5000", "timeoutMs", 5000],
			["binaryPath /opt/chafa", "binaryPath", "/opt/chafa"],
		];

		for (const [args, key, expected] of cases) {
			writer.mockClear();
			notifyMock.mockClear();
			await runImagesCommand({ getAllTools: () => [] } as never, args, ctx as never, {
				writeConfigFile: writer,
			});
			// Exactly one write, and a report naming the key, the new value and the file.
			expect(writer).toHaveBeenCalledTimes(1);
			expect(loadConfig(testDir)[key]).toEqual(expected);
			expect(notifyMock).toHaveBeenCalledTimes(1);
			expect(notifyMock).toHaveBeenCalledWith(
				`pi-chafa: ${key} is now ${expected} — saved to ${testDir}/pi-chafa.json`,
				"info",
			);
		}
		// A complete key/value argument is a finished command — it never mounts the panel.
		expect(customMock).not.toHaveBeenCalled();
	});

	it("writes only the key it changed, so pi's cellWidth still supplies the default (#058)", async () => {
		// The defect: a save serialized the fully materialized config, which made every
		// key explicitly present. resolveConfig reads loadFileConfig().keys to decide
		// whether pi's own terminal.imageWidthCells may still supply cellWidth (#010),
		// so one unrelated save silently overrode the host setting.
		const writer = vi.fn(writeConfigFile);
		const ctx = {
			mode: "tui",
			hasUI: true,
			ui: {
				custom: vi.fn(),
				select: vi.fn(),
				notify: vi.fn(),
				input: vi.fn(),
			},
		};

		await runImagesCommand(
			{ getAllTools: () => [] } as never,
			"colors 8",
			ctx as never,
			{ writeConfigFile: writer },
		);

		expect(
			JSON.parse(readFileSync(join(testDir, "pi-chafa.json"), "utf8")),
		).toStrictEqual({ version: DEFAULT_CONFIG.version, colors: "8" });
		// The ladder still reaches the host value for the key nobody set.
		expect(
			resolveConfig({}, testDir, {
				showImages: true,
				imageWidthCells: 80,
				images: null,
			}).symbols.cellWidth,
		).toBe(80);
	});

	it("keeps the file's own values when writing a different key (#058)", async () => {
		writeFileSync(join(testDir, "pi-chafa.json"), JSON.stringify({ colors: "16" }));
		const writer = vi.fn(writeConfigFile);
		const ctx = {
			mode: "tui",
			hasUI: true,
			ui: {
				custom: vi.fn(),
				select: vi.fn(),
				notify: vi.fn(),
				input: vi.fn(),
			},
		};

		await runImagesCommand(
			{ getAllTools: () => [] } as never,
			"cellWidth 72",
			ctx as never,
			{ writeConfigFile: writer },
		);

		expect(
			JSON.parse(readFileSync(join(testDir, "pi-chafa.json"), "utf8")),
		).toStrictEqual({
			version: DEFAULT_CONFIG.version,
			colors: "16",
			cellWidth: 72,
		});
	});

	it("accumulates only what was set across successive saves (#058)", async () => {
		// The whole point of D25 in one sequence: each save layers onto what the file
		// already holds, so the file is a record of the user's choices rather than a
		// snapshot of whatever the defaults happened to be at save time.
		const writer = vi.fn(writeConfigFile);
		const ctx = {
			mode: "tui",
			hasUI: true,
			ui: {
				custom: vi.fn(),
				select: vi.fn(),
				notify: vi.fn(),
				input: vi.fn(),
			},
		};
		const run = (args: string): Promise<void> =>
			runImagesCommand({ getAllTools: () => [] } as never, args, ctx as never, {
				writeConfigFile: writer,
			});
		const fileJson = (): unknown =>
			JSON.parse(readFileSync(join(testDir, "pi-chafa.json"), "utf8"));
		const version = DEFAULT_CONFIG.version;

		await run("colors 8");
		expect(fileJson()).toStrictEqual({ version, colors: "8" });

		await run("cellWidth 70");
		expect(fileJson()).toStrictEqual({ version, colors: "8", cellWidth: 70 });

		await run("binaryPath /opt/chafa");
		expect(fileJson()).toStrictEqual({
			version,
			colors: "8",
			cellWidth: 70,
			binaryPath: "/opt/chafa",
		});

		// Clearing is a choice, not the removal of a key: null means "auto on PATH".
		await run("binaryPath");
		expect(fileJson()).toStrictEqual({
			version,
			colors: "8",
			cellWidth: 70,
			binaryPath: null,
		});
		expect(loadConfig(testDir).binaryPath).toBeNull();

		// The other side of the ladder: cellWidth is explicit now, so the host's own
		// value no longer supplies it (#010).
		expect(
			resolveConfig({}, testDir, {
				showImages: true,
				imageWidthCells: 80,
				images: null,
			}).symbols.cellWidth,
		).toBe(70);
	});

	it("attributes a failed command-line write instead of throwing (#061)", async () => {
		// The panel's save path catches the identical call; the CLI's did not, so an
		// fs failure escaped as a raw error with no pi-chafa attribution and no
		// indication of which setting failed.
		const writer = vi.fn(() => {
			throw new Error("EACCES: permission denied");
		});
		const notifyMock = vi.fn();
		const ctx = {
			mode: "tui",
			hasUI: true,
			ui: {
				custom: vi.fn(),
				select: vi.fn(),
				notify: notifyMock,
				input: vi.fn(),
			},
		};

		await expect(
			runImagesCommand({ getAllTools: () => [] } as never, "colors 8", ctx as never, {
				writeConfigFile: writer,
			}),
		).resolves.toBeUndefined();

		expect(notifyMock).toHaveBeenCalledTimes(1);
		expect(notifyMock).toHaveBeenCalledWith(
			expect.stringContaining("pi-chafa: could not save colors"),
			"warning",
		);
		// The cause is named, and no success report follows a failed write.
		expect(notifyMock).toHaveBeenCalledWith(
			expect.stringContaining("EACCES"),
			"warning",
		);
		expect(notifyMock).not.toHaveBeenCalledWith(
			expect.stringContaining("is now"),
			"info",
		);
	});

	it("refuses a bad value without writing and without opening the panel (#050)", async () => {
		const writer = vi.fn(writeConfigFile);
		const notifyMock = vi.fn();
		const customMock = vi.fn();

		await runImagesCommand(
			{ getAllTools: () => [] } as never,
			"colors chartreuse",
			{
				mode: "tui",
				hasUI: true,
				ui: {
					custom: customMock,
					select: vi.fn(),
					notify: notifyMock,
					input: vi.fn(),
				},
			} as never,
			{ writeConfigFile: writer },
		);

		expect(notifyMock).toHaveBeenCalledTimes(1);
		const [message, level] = notifyMock.mock.calls[0] as [string, string];
		expect(level).toBe("warning");
		expect(message).toContain("invalid colors = 'chartreuse'");
		expect(message).toContain("expected one of");
		expect(writer).not.toHaveBeenCalled();
		expect(customMock).not.toHaveBeenCalled();
		expect(loadConfig(testDir).colors).toBe(DEFAULT_CONFIG.colors);
	});

	it("keeps the unknown-argument fallback: warn with the keys, no write, open the panel (#050)", async () => {
		const writer = vi.fn(writeConfigFile);
		const notifyMock = vi.fn();
		const customMock = vi.fn().mockImplementation(async (cb) => {
			cb(
				{ requestRender: vi.fn() },
				{
					fg: (_c: string, text: string) => text,
					bold: (text: string) => text,
				},
				getKeybindings(),
				() => {},
			);
			return { action: "done" };
		});

		await runImagesCommand(
			{ getAllTools: () => [] } as never,
			"colours 8",
			{
				mode: "tui",
				hasUI: true,
				ui: {
					custom: customMock,
					select: vi.fn(),
					notify: notifyMock,
					input: vi.fn(),
				},
			} as never,
			{ writeConfigFile: writer },
		);

		const [message, level] = notifyMock.mock.calls[0] as [string, string];
		expect(level).toBe("warning");
		expect(message).toContain("unknown /images argument 'colours 8'");
		for (const key of SETTING_KEYS) expect(message).toContain(key);
		expect(writer).not.toHaveBeenCalled();
		expect(customMock).toHaveBeenCalledTimes(1);
	});

	it("reports a command-line write to stdout in print and to stderr in json (#050)", async () => {
		const writer = vi.fn(writeConfigFile);
		const stdoutSpy = vi
			.spyOn(process.stdout, "write")
			.mockImplementation(() => true);
		const stderrSpy = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		const ctx = (mode: string) => ({
			mode,
			hasUI: false,
			ui: { custom: vi.fn(), select: vi.fn(), notify: vi.fn(), input: vi.fn() },
		});
		try {
			await runImagesCommand(
				{ getAllTools: () => [] } as never,
				"cellWidth 71",
				ctx("print") as never,
				{ writeConfigFile: writer },
			);
			expect(stdoutSpy).toHaveBeenCalledWith(
				`pi-chafa: cellWidth is now 71 — saved to ${testDir}/pi-chafa.json\n`,
			);
			stdoutSpy.mockClear();

			await runImagesCommand(
				{ getAllTools: () => [] } as never,
				"maxRows 40",
				ctx("json") as never,
				{ writeConfigFile: writer },
			);
			// stdout is a JSONL stream in json mode — the report goes to stderr.
			expect(stdoutSpy).not.toHaveBeenCalled();
			expect(stderrSpy).toHaveBeenCalledWith(
				`pi-chafa: maxRows is now 40 — saved to ${testDir}/pi-chafa.json\n`,
			);
		} finally {
			stdoutSpy.mockRestore();
			stderrSpy.mockRestore();
		}
		expect(loadConfig(testDir).cellWidth).toBe(71);
		expect(loadConfig(testDir).maxRows).toBe(40);
	});

	it("refuses a control-character value and never echoes it raw (#050)", async () => {
		const writer = vi.fn(writeConfigFile);
		const notifyMock = vi.fn();

		await runImagesCommand(
			{ getAllTools: () => [] } as never,
			"symbolsSet \u001b[31mblock",
			{
				mode: "tui",
				hasUI: true,
				ui: {
					custom: vi.fn(),
					select: vi.fn(),
					notify: notifyMock,
					input: vi.fn(),
				},
			} as never,
			{ writeConfigFile: writer },
		);

		const [message] = notifyMock.mock.calls[0] as [string, string];
		expect(message).not.toContain("\u001b");
		expect(writer).not.toHaveBeenCalled();
	});

	it("uses the injected deps instead of spawning chafa or reading real settings (#019)", async () => {
		const pi = { getAllTools: () => [] };
		const probe = vi.fn(async () => FAKE_PROBE);
		const readHost = vi.fn(() => ({
			showImages: true,
			imageWidthCells: 60,
			images: null,
		}));
		const notifyMock = vi.fn();

		await runImagesCommand(
			pi,
			"status",
			{
				mode: "tui",
				hasUI: true,
				ui: {
					custom: vi.fn(),
					select: vi.fn(),
					notify: notifyMock,
					input: vi.fn(),
				},
			},
			{ probeChafa: probe, readHostImageSettings: readHost },
		);

		expect(probe).toHaveBeenCalledWith(null);
		expect(readHost).toHaveBeenCalledTimes(1);
		const [message] = notifyMock.mock.calls[0] as [string];
		expect(message).toContain("chafa: 1.18 (chafa)");
	});

	it("warns and still opens the settings panel for an unknown argument (#016)", async () => {
		const pi = { getAllTools: () => [] };
		const notifyMock = vi.fn();
		const customMock = vi.fn().mockImplementation(async (cb) => {
			const tui = { requestRender: vi.fn() };
			const theme = {
				fg: (_c: string, text: string) => text,
				bold: (text: string) => text,
			};
			cb(tui, theme, getKeybindings(), () => {});
			return { action: "done" };
		});
		const ctx = {
			mode: "tui",
			hasUI: true,
			ui: { custom: customMock, select: vi.fn(), notify: notifyMock, input: vi.fn() },
		};

		await runImagesCommand(pi as never, "bogus", ctx as never);

		expect(notifyMock).toHaveBeenCalledWith(
			expect.stringContaining("unknown /images argument 'bogus'"),
			"warning",
		);
		expect(customMock).toHaveBeenCalledTimes(1);
	});

	it("names the usage and a near miss in the unknown-argument warning (#055)", async () => {
		for (const [arg, corrected] of [
			["statu", true],
			["bogus", false],
		] as const) {
			const notifyMock = vi.fn();
			const customMock = vi.fn().mockImplementation(async (cb) => {
				cb(
					{ requestRender: vi.fn() },
					{
						fg: (_c: string, text: string) => text,
						bold: (text: string) => text,
					},
					getKeybindings(),
					() => {},
				);
				return { action: "cancelled" };
			});

			await runImagesCommand({ getAllTools: () => [] } as never, arg, {
				mode: "tui",
				hasUI: true,
				ui: {
					custom: customMock,
					select: vi.fn(),
					notify: notifyMock,
					input: vi.fn(),
				},
			} as never);

			const [message, level] = notifyMock.mock.calls[0] as [string, string];
			expect(level).toBe("warning");
			expect(message).toContain("unknown /images argument");
			expect(message).toContain(IMAGES_USAGE);
			if (corrected) {
				expect(message).toContain("did you mean '/images status'?");
			} else {
				expect(message).not.toContain("did you mean");
			}
		}
	});

	it("sanitizes control characters in an unknown argument before notifying (#016)", async () => {
		const pi = { getAllTools: () => [] };
		const notifyMock = vi.fn();
		const customMock = vi.fn().mockImplementation(async (cb) => {
			const tui = { requestRender: vi.fn() };
			const theme = {
				fg: (_c: string, text: string) => text,
				bold: (text: string) => text,
			};
			cb(tui, theme, getKeybindings(), () => {});
			return { action: "done" };
		});
		const ctx = {
			mode: "tui",
			hasUI: true,
			ui: { custom: customMock, select: vi.fn(), notify: notifyMock, input: vi.fn() },
		};

		await runImagesCommand(pi as never, "bo\u001b[31mgus", ctx as never);

		const [message] = notifyMock.mock.calls[0] as [string, string];
		expect(message).not.toContain("\u001b");
		expect(message).toContain("bogus");
	});

	it("refuses a control-character binaryPath in the fallback instead of saving it (#060)", async () => {
		// #038 pinned the fallback ACCEPTING a control-char path and sanitizing only
		// its notification. That left the raw bytes in pi-chafa.json, and the panel
		// renders binaryPath's currentValue un-stripped (`buildSettingItems`), so
		// they came back raw on the next open — the invariant-3 hazard #060 fixes.
		// The value is now refused on every path; #038's guarantee that no
		// notification carries a raw escape still holds, below.
		const pi = { getAllTools: () => [] };
		const notifyMock = vi.fn();
		const writer = vi.fn();
		const selectMock = vi
			.fn()
			.mockResolvedValueOnce(
				`Binary path: (auto on PATH) — ${SETTING_DESCRIPTIONS.binaryPath}`,
			)
			.mockResolvedValueOnce("Type custom path...")
			.mockResolvedValueOnce(`Done — ${SETTING_DESCRIPTIONS.done}`);
		const inputMock = vi.fn().mockResolvedValueOnce("/evil\x1b[2Jbin/chafa");
		const ctx = {
			mode: "rpc",
			hasUI: true,
			ui: {
				select: selectMock,
				notify: notifyMock,
				input: inputMock,
			},
		};

		await runImagesCommand(pi as never, "", ctx as never, {
			writeConfigFile: writer,
		});

		const messages = notifyMock.mock.calls.map((call) => call[0] as string);
		expect(messages.some((m) => m.includes("saved binaryPath"))).toBe(false);
		expect(writer).not.toHaveBeenCalled();
		expect(notifyMock).toHaveBeenCalledWith(
			`pi-chafa: ${controlCharReason("binaryPath")}`,
			"warning",
		);
		for (const message of messages) expect(message).not.toContain("\x1b");
	});

	it("saves a clean binaryPath in the fallback and reports it (#038)", async () => {
		const pi = { getAllTools: () => [] };
		const notifyMock = vi.fn();
		const realWrite = writeConfigFile;
		const writer = vi.fn((dir: string, cfg: unknown) =>
			realWrite(dir, cfg as ChafaConfig),
		);
		const selectMock = vi
			.fn()
			.mockResolvedValueOnce(
				`Binary path: (auto on PATH) — ${SETTING_DESCRIPTIONS.binaryPath}`,
			)
			.mockResolvedValueOnce("Type custom path...")
			.mockResolvedValueOnce(`Done — ${SETTING_DESCRIPTIONS.done}`);
		const inputMock = vi.fn().mockResolvedValueOnce("/opt/chafa");
		const ctx = {
			mode: "rpc",
			hasUI: true,
			ui: { select: selectMock, notify: notifyMock, input: inputMock },
		};

		await runImagesCommand(pi as never, "", ctx as never, {
			writeConfigFile: writer,
		});

		const messages = notifyMock.mock.calls.map((call) => call[0] as string);
		expect(messages.some((m) => m.includes("saved binaryPath"))).toBe(true);
		expect(loadConfig(testDir).binaryPath).toBe("/opt/chafa");
		expect(notifyMock).not.toHaveBeenCalledWith(
			expect.stringContaining("control characters"),
			"warning",
		);
	});

	it("cancels the panel on lowercase q and documents it in the hint (#003, #048)", async () => {
		const pi = { getAllTools: () => [] };
		const doneMock = vi.fn();
		let handleInput: ((data: string) => void) | undefined;
		let rendered: string[] = [];

		const customMock = vi.fn().mockImplementation(async (cb) => {
			const tui = { requestRender: vi.fn() };
			const theme = {
				fg: (_c: string, text: string) => text,
				bold: (text: string) => text,
			};
			const component = cb(tui, theme, getKeybindings(), doneMock) as {
				render: (w: number) => string[];
				handleInput: (data: string) => void;
			};
			handleInput = component.handleInput;
			rendered = component.render(80);
			return { action: "done" };
		});

		const ctx = {
			mode: "tui",
			hasUI: true,
			ui: {
				custom: customMock,
				select: vi.fn(),
				notify: vi.fn(),
				input: vi.fn(),
			},
		};

		await runImagesCommand(pi as never, "", ctx as never);

		expect(handleInput).toBeDefined();
		expect(rendered.join("\n")).toContain(`${keyText("tui.select.cancel")}/q close`);
		handleInput?.("q");
		expect(doneMock).toHaveBeenCalledWith({ action: "cancelled" });
	});

	it("cancels the panel on uppercase Q (#003, #048)", async () => {
		const pi = { getAllTools: () => [] };
		const doneMock = vi.fn();
		let handleInput: ((data: string) => void) | undefined;

		const customMock = vi.fn().mockImplementation(async (cb) => {
			const tui = { requestRender: vi.fn() };
			const theme = {
				fg: (_c: string, text: string) => text,
				bold: (text: string) => text,
			};
			const component = cb(tui, theme, getKeybindings(), doneMock) as {
				handleInput: (data: string) => void;
			};
			handleInput = component.handleInput;
			return { action: "done" };
		});

		const ctx = {
			mode: "tui",
			hasUI: true,
			ui: {
				custom: customMock,
				select: vi.fn(),
				notify: vi.fn(),
				input: vi.fn(),
			},
		};

		await runImagesCommand(pi as never, "", ctx as never);

		handleInput?.("Q");
		expect(doneMock).toHaveBeenCalledWith({ action: "cancelled" });
	});

	it("keeps the panel open for a non-exit key and still closes on q (#003)", async () => {
		const pi = { getAllTools: () => [] };
		const doneMock = vi.fn();
		let handleInput: ((data: string) => void) | undefined;

		const customMock = vi.fn().mockImplementation(async (cb) => {
			const tui = { requestRender: vi.fn() };
			const theme = {
				fg: (_c: string, text: string) => text,
				bold: (text: string) => text,
			};
			const component = cb(tui, theme, getKeybindings(), doneMock) as {
				handleInput: (data: string) => void;
			};
			handleInput = component.handleInput;
			return { action: "done" };
		});

		const ctx = {
			mode: "tui",
			hasUI: true,
			ui: {
				custom: customMock,
				select: vi.fn(),
				notify: vi.fn(),
				input: vi.fn(),
			},
		};

		await runImagesCommand(pi as never, "", ctx as never);

		handleInput?.("j");
		expect(doneMock).not.toHaveBeenCalled();
		handleInput?.("q");
		expect(doneMock).toHaveBeenCalledTimes(1);
	});

	it("supports custom typing modal when action input is triggered in TUI mode", async () => {
		const pi = { getAllTools: () => [] };
		const notifyMock = vi.fn();
		const inputMock = vi.fn().mockResolvedValue("/custom/chafa");

		let invocation = 0;
		const customMock = vi.fn().mockImplementation(async (cb) => {
			invocation++;
			const tui = { requestRender: vi.fn() };
			const theme = {
				fg: (_c: string, text: string) => text,
				bold: (text: string) => text,
			};
			cb(tui, theme, getKeybindings(), () => {});
			if (invocation === 1) {
				return { action: "edit" };
			}
			// Staged (#046): the dialog value lands in the draft; Ctrl+S writes it.
			return { action: "done", report: undefined };
		});

		const ctx = {
			mode: "tui",
			hasUI: true,
			ui: {
				custom: customMock,
				select: vi.fn().mockResolvedValue("Binary path"),
				notify: notifyMock,
				input: inputMock,
			},
		};

		await runImagesCommand(pi as never, "", ctx as never);

		expect(inputMock).toHaveBeenCalledWith(
			"Chafa binary path",
			expect.any(String),
		);
		// No write happened (staged; the mock never confirmed).
		expect(loadConfig(testDir).binaryPath).toBeNull();
	});

	it("handles structured binary path choices in fallback mode", async () => {
		const pi = { getAllTools: () => [] };
		const notifyMock = vi.fn();
		const selectMock = vi
			.fn()
			.mockResolvedValueOnce(
				`Binary path: [(auto on PATH)] — ${SETTING_DESCRIPTIONS.binaryPath}`,
			)
			.mockResolvedValueOnce("Auto (system PATH)")
			.mockResolvedValueOnce(`Done — ${SETTING_DESCRIPTIONS.done}`);

		const ctx = {
			mode: "rpc",
			hasUI: true,
			ui: {
				select: selectMock,
				notify: notifyMock,
				input: vi.fn(),
			},
		};

		await runImagesCommand(pi as never, "", ctx as never);

		expect(notifyMock).toHaveBeenCalledWith(
			expect.stringContaining("cleared binaryPath"),
			"info",
		);
	});

	it("sets timeoutMs from a preset in fallback mode", async () => {
		const pi = { getAllTools: () => [] };
		const notifyMock = vi.fn();
		const selectMock = vi
			.fn()
			.mockResolvedValueOnce(
				`Timeout (ms): [8000] — ${SETTING_DESCRIPTIONS.timeoutMs}`,
			)
			.mockResolvedValueOnce("15000")
			.mockResolvedValueOnce(`Done — ${SETTING_DESCRIPTIONS.done}`);

		const ctx = {
			mode: "rpc",
			hasUI: true,
			ui: { select: selectMock, notify: notifyMock, input: vi.fn() },
		};

		await runImagesCommand(pi as never, "", ctx as never);

		expect(loadConfig(testDir).timeoutMs).toBe(15000);
		expect(notifyMock).toHaveBeenCalledWith(
			"pi-chafa: timeoutMs is now 15000",
			"info",
		);
	});

	it("sets a custom timeoutMs via the fallback Custom... free-text path", async () => {
		const pi = { getAllTools: () => [] };
		const notifyMock = vi.fn();
		const inputMock = vi.fn().mockResolvedValue("2500");
		const selectMock = vi
			.fn()
			.mockResolvedValueOnce(
				`Timeout (ms): [8000] — ${SETTING_DESCRIPTIONS.timeoutMs}`,
			)
			.mockResolvedValueOnce("Custom...")
			.mockResolvedValueOnce(`Done — ${SETTING_DESCRIPTIONS.done}`);

		const ctx = {
			mode: "rpc",
			hasUI: true,
			ui: { select: selectMock, notify: notifyMock, input: inputMock },
		};

		await runImagesCommand(pi as never, "", ctx as never);

		expect(inputMock).toHaveBeenCalledWith(
			"Enter custom timeoutMs (milliseconds)",
			"positive integer ms",
		);
		expect(loadConfig(testDir).timeoutMs).toBe(2500);
		expect(notifyMock).toHaveBeenCalledWith(
			"pi-chafa: timeoutMs is now 2500",
			"info",
		);
	});

	it("stages timeoutMs through the TUI custom-input path and writes on Ctrl+S (#046)", async () => {
		const pi = { getAllTools: () => [] };
		const notifyMock = vi.fn();
		const inputMock = vi.fn().mockResolvedValue("30000");

		let invocation = 0;
		let panel: { handleInput: (d: string) => void } | undefined;
		const customMock = vi.fn().mockImplementation(async (cb) => {
			invocation++;
			const tui = { requestRender: vi.fn() };
			const theme = {
				fg: (_c: string, text: string) => text,
				bold: (text: string) => text,
			};
			const component = cb(tui, theme, getKeybindings(), () => {}) as {
				handleInput: (d: string) => void;
			};
			if (invocation === 1) {
				return { action: "edit" };
			}
			panel = component;
			return { action: "done" };
		});

		const ctx = {
			mode: "tui",
			hasUI: true,
			ui: {
				custom: customMock,
				select: vi.fn().mockResolvedValue("Timeout (ms)"),
				notify: notifyMock,
				input: inputMock,
			},
		};

		await runImagesCommand(pi as never, "", ctx as never);

		expect(inputMock).toHaveBeenCalledWith(
			"New timeoutMs (milliseconds)",
			expect.any(String),
		);
		// Staged: the dialog value landed in the draft; confirming with Ctrl+S
		// writes it (the save report itself is covered by the #045/#046 suites).
		panel?.handleInput("\x13");
		expect(loadConfig(testDir).timeoutMs).toBe(30000);
	});

	it("warns and keeps the previous timeoutMs when TUI input is invalid", async () => {
		const pi = { getAllTools: () => [] };
		const notifyMock = vi.fn();
		const inputMock = vi.fn().mockResolvedValue("-4");

		let invocation = 0;
		const customMock = vi.fn().mockImplementation(async (cb) => {
			invocation++;
			const tui = { requestRender: vi.fn() };
			const theme = {
				fg: (_c: string, text: string) => text,
				bold: (text: string) => text,
			};
			cb(tui, theme, getKeybindings(), () => {});
			if (invocation === 1) return { action: "edit" };
			return { action: "done" };
		});

		const ctx = {
			mode: "tui",
			hasUI: true,
			ui: {
				custom: customMock,
				select: vi.fn().mockResolvedValue("Timeout (ms)"),
				notify: notifyMock,
				input: inputMock,
			},
		};

		await runImagesCommand(pi as never, "", ctx as never);

		expect(notifyMock).toHaveBeenCalledWith(
			"pi-chafa: invalid timeoutMs (must be positive integer)",
			"warning",
		);
		expect(loadConfig(testDir).timeoutMs).toBe(8000);
	});

	it("shows the effective capability and source in the runtime status panel", async () => {
		const pi = { getAllTools: () => [] };
		const notifyMock = vi.fn();
		const selectMock = vi
			.fn()
			.mockResolvedValueOnce(
				`Runtime status — ${SETTING_DESCRIPTIONS.runtimeStatus}`,
			)
			.mockResolvedValueOnce("Close")
			.mockResolvedValueOnce(`Done — ${SETTING_DESCRIPTIONS.done}`);

		const ctx = {
			mode: "rpc",
			hasUI: true,
			ui: { select: selectMock, notify: notifyMock, input: vi.fn() },
		};

		await runImagesCommand(pi as never, "", ctx as never);

		const statusOptions = selectMock.mock.calls[1]?.[1] as string[];
		expect(statusOptions.join("\n")).toContain("Detected image protocol: ");
		expect(statusOptions.join("\n")).toContain("Host showImages: ");
		expect(statusOptions.join("\n")).toContain("pi-pretty-style read override: ");
		expect(statusOptions.join("\n")).toContain("chafa: ");
	});

	describe("staged persistence (#045)", () => {
	const mountPanel = async (opts: {
		simulate?: (
			component: {
				handleInput: (d: string) => void;
				render: (w: number) => string[];
			},
			mountIndex: number,
		) => void;
		deps?: Parameters<typeof runImagesCommandRaw>[3];
		input?: (prompt: string) => string | undefined;
		select?: (prompt: string) => string | undefined;
	}) => {
		const userInput = opts.input ?? (() => undefined);
		const userSelect = vi.fn(async (prompt: string) => opts.select?.(prompt));
		const notifyMock = vi.fn();
		let resolvePanel: (r: unknown) => void = () => {};
		let lastAction: unknown = { action: "done" };
		let mounted: { handleInput: (d: string) => void; render: (w: number) => string[] } | undefined;
		const customMock = vi.fn().mockImplementation(async (cb) => {
			const component = cb(
				{ requestRender: vi.fn() },
				{
					fg: (_c: string, text: string) => text,
					bold: (text: string) => text,
				},
				getKeybindings(),
				(r: unknown) => {
					lastAction = r;
					resolvePanel(r);
				},
			) as { handleInput: (d: string) => void; render: (w: number) => string[] };
			if (customMock.mock.calls.length === 1) {
				mounted = component;
				// Wire the resolver BEFORE simulating keys: done() can fire during
				// the simulation (Esc, Ctrl+S) and must land on a live resolver.
				const promise = new Promise((res) => {
					resolvePanel = res;
				});
				opts.simulate?.(component, 1);
				return promise;
			}
			opts.simulate?.(component, customMock.mock.calls.length);
			return lastAction; // the action the simulated keys produced
		});
		const run = runImagesCommand(
			{ getAllTools: () => [] } as never,
			"",
			{
				mode: "tui",
				hasUI: true,
				ui: {
					custom: customMock,
					select: userSelect,
					notify: notifyMock,
					input: userInput,
				},
			} as never,
			opts.deps,
		);
		return { run, notifyMock, mounted: () => mounted };
	};

	it("styles the panel rows with the injected host theme (#051)", async () => {
		const marker = {
			label: (text: string, selected: boolean) =>
				selected ? `SEL<${text}>` : text,
			value: (text: string) => text,
			description: (text: string) => text,
			cursor: "→ ",
			hint: (text: string) => text,
		};
		let panel: { render: (w: number) => string[] } | undefined;
		const { run } = await mountPanel({
			deps: { settingsListTheme: () => marker },
			simulate: (c) => {
				panel = c;
				c.handleInput("\x1b"); // Esc: close so the command completes
			},
		});
		await run;
		// The marker proves the injected theme reaches SettingsList's rows.
		expect(panel?.render(80).join("\n")).toContain("SEL<");
	});

	it("stages edits: Esc discards and the file stays byte-identical (#045)", async () => {
		writeFileSync(join(testDir, "pi-chafa.json"), JSON.stringify({ cellWidth: 71 }));
		const before = readFileSync(join(testDir, "pi-chafa.json"), "utf8");
		const { run, notifyMock } = await mountPanel({
			simulate: (c) => {
				c.handleInput("\r"); // cycle Prefer native → false
				c.handleInput("\x1b"); // Esc: cancel
			},
		});
		await run;
		expect(readFileSync(join(testDir, "pi-chafa.json"), "utf8")).toBe(before);
		expect(notifyMock).toHaveBeenCalledWith(
			"pi-chafa: settings unchanged (cancelled)",
			"info",
		);
	});

	it("treats q as a reported cancel and leaves the file byte-identical (#048)", async () => {
		writeFileSync(join(testDir, "pi-chafa.json"), JSON.stringify({ cellWidth: 71 }));
		const before = readFileSync(join(testDir, "pi-chafa.json"), "utf8");
		const { run, notifyMock } = await mountPanel({
			simulate: (c) => {
				c.handleInput("\r"); // cycle Prefer native → false: the draft is dirty
				c.handleInput("q"); // must cancel AND report, never discard silently
			},
		});
		await run;
		expect(readFileSync(join(testDir, "pi-chafa.json"), "utf8")).toBe(before);
		expect(notifyMock).toHaveBeenCalledWith(
			"pi-chafa: settings unchanged (cancelled)",
			"info",
		);
	});

		it("makes q an exact Esc alias while the facts submenu is open (#062)", async () => {
		// The wrapper intercepts q before the list sees it, so with a submenu open q
		// discarded the whole draft while Esc closed only the submenu — contradicting
		// #048's "q is an exact alias of Esc". The host exposes no accessor for an open
		// submenu (`SettingsList.submenuComponent` is private), but the wrapper supplies
		// the submenu's factory AND its close callback, so it can track that state.
		let submenuRender: string[] = [];
		let afterQ: string[] = [];
		const { run, notifyMock } = await mountPanel({
			simulate: (c, mount) => {
				if (mount !== 1) return;
				for (let i = 0; i < 8; i++) c.handleInput("\x1b[B"); // → Runtime status
				c.handleInput("\r"); // open the facts submenu
				submenuRender = c.render(80);
				c.handleInput("q"); // q: the submenu's own branch closes it
				afterQ = c.render(80);
				c.handleInput("q"); // q again, no submenu: the panel cancels
			},
		});
		await run;

		// The submenu really was open: its lines replace the rows.
		expect(submenuRender.join("\n")).toContain("Detected image protocol: ");
		expect(submenuRender.join("\n")).not.toContain("Prefer native");
		// q closed only the submenu — the panel is still there with its rows.
		expect(afterQ.join("\n")).toContain("Prefer native");
		// And the second q is the reported cancel (#048), never a silent discard.
		expect(notifyMock).toHaveBeenCalledWith(
			"pi-chafa: settings unchanged (cancelled)",
			"info",
		);
	});

it("Ctrl+S writes the draft exactly once and reports the count and file (#045)", async () => {
		const realWrite = writeConfigFile;
		const writeSpy = vi.fn((dir: string, cfg: unknown) => realWrite(dir, cfg as ChafaConfig));
		const { run, notifyMock } = await mountPanel({
			deps: { writeConfigFile: writeSpy },
			simulate: (c) => {
				c.handleInput("\r"); // Prefer native → false
				c.handleInput("\x1b[B"); // down to Color mode
				c.handleInput("\r"); // cycle colors
				c.handleInput("\x13"); // Ctrl+S
			},
		});
		await run;
		expect(writeSpy).toHaveBeenCalledTimes(1);
		const saved = loadConfig(testDir);
		expect(saved.preferNative).toBe(false);
		expect(saved.colors).not.toBe("240");
		expect(notifyMock).toHaveBeenCalledWith(
			`pi-chafa: 2 settings saved to ${testDir}/pi-chafa.json`,
			"info",
		);
	});

	it("writes the file's own keys plus the changed one on Ctrl+S, not the resolved config (#058)", async () => {
		writeFileSync(join(testDir, "pi-chafa.json"), JSON.stringify({ dither: "ordered" }));
		const realWrite = writeConfigFile;
		const writeSpy = vi.fn((dir: string, cfg: unknown) =>
			realWrite(dir, cfg as ChafaConfig),
		);
		const { run } = await mountPanel({
			deps: { writeConfigFile: writeSpy },
			simulate: (c) => {
				c.handleInput("\r"); // cycle Prefer native → false: the one changed key
				c.handleInput("\x13"); // Ctrl+S
			},
		});
		await run;

		expect(
			JSON.parse(readFileSync(join(testDir, "pi-chafa.json"), "utf8")),
		).toStrictEqual({
			version: DEFAULT_CONFIG.version,
			dither: "ordered", // the file's own key, kept
			preferNative: false, // the key this save changed
		});
	});

	it("a clean Ctrl+S closes without writing (#045)", async () => {
		const realWrite = writeConfigFile;
		const writeSpy = vi.fn((dir: string, cfg: unknown) => realWrite(dir, cfg as ChafaConfig));
		const { run, notifyMock } = await mountPanel({
			deps: { writeConfigFile: writeSpy },
			simulate: (c) => {
				c.handleInput("\x13");
			},
		});
		await run;
		expect(writeSpy).not.toHaveBeenCalled();
		expect(notifyMock).toHaveBeenCalledWith("pi-chafa: settings unchanged", "info");
	});

	it("advertises the save chord only while the draft differs (#045)", async () => {
		let panel: { handleInput: (d: string) => void; render: (w: number) => string[] } | undefined;
		const { run } = await mountPanel({
			simulate: (c) => {
				panel = c;
			},
		});
		await vi.waitFor(() => {
			expect(panel).toBeDefined();
		});
		const clean = panel?.render(80).join("\n") ?? "";
		expect(clean).toContain(`${keyText("tui.select.cancel")}/q close`);
		expect(clean).not.toContain("Ctrl+S");
		panel?.handleInput("\r"); // dirty it
		const dirty = panel?.render(80).join("\n") ?? "";
		expect(dirty).toContain(
			`unsaved changes — Ctrl+S saves and closes · ${keyText("tui.select.cancel")}/q discards`,
		);
		expect(dirty).not.toContain("/q close");
		panel?.handleInput("\x1b"); // close so the command ends
		await run;
	});

	it("saves only through Ctrl+S — Enter on a value row never writes (#054)", async () => {
		const realWrite = writeConfigFile;
		const writeSpy = vi.fn((dir: string, cfg: unknown) => realWrite(dir, cfg as ChafaConfig));
		const { run, notifyMock } = await mountPanel({
			deps: { writeConfigFile: writeSpy },
			simulate: (c) => {
				c.handleInput("\x1b[B"); // down to Color mode
				c.handleInput("\r"); // cycle: the draft is dirty
				c.handleInput("\r"); // Enter must keep cycling, never save
				c.handleInput("\r");
				expect(writeSpy).not.toHaveBeenCalled();
				c.handleInput("\x13"); // Ctrl+S is the only confirm
			},
		});
		await run;
		expect(writeSpy).toHaveBeenCalledTimes(1);
		expect(loadConfig(testDir).colors).not.toBe("240");
		expect(notifyMock).toHaveBeenCalledWith(
			`pi-chafa: 1 setting saved to ${testDir}/pi-chafa.json`,
			"info",
		);
	});

	it("a failed write warns, keeps the draft, and leaves the panel open (#045)", async () => {
		chmodSync(testDir, 0o555);
		const { run, notifyMock, mounted } = await mountPanel({
			simulate: (c) => {
				c.handleInput("\r"); // dirty
				c.handleInput("\x13"); // Ctrl+S → write fails
			},
			});
			await vi.waitFor(() => {
				expect(notifyMock).toHaveBeenCalledWith(
					expect.stringContaining("could not save settings"),
					"warning",
				);
			});
			// Panel still open: no done fired (resolve it manually to end the test).
			await vi.waitFor(() => {
				expect(mounted()).toBeDefined();
			});
		chmodSync(testDir, 0o755);
		mounted()?.handleInput("\x13"); // retry succeeds
		await run;
		expect(loadConfig(testDir).preferNative).toBe(false);
	});

	it("stages 'e' custom-edit values: Esc after an 'e'-edit leaves the file byte-identical (#046)", async () => {
		writeFileSync(join(testDir, "pi-chafa.json"), JSON.stringify({ cellWidth: 71 }));
		const before = readFileSync(join(testDir, "pi-chafa.json"), "utf8");
		const realWrite = writeConfigFile;
		const writeSpy = vi.fn((dir: string, cfg: unknown) => realWrite(dir, cfg as ChafaConfig));
		const { run, notifyMock } = await mountPanel({
			deps: { writeConfigFile: writeSpy },
			input: () => "moon+triangle",
			select: () => "Symbols set",
			simulate: (c, mount) => {
				if (mount === 1) {
					c.handleInput("e"); // picker → Symbols set → type the value
				} else {
					c.handleInput("\x1b"); // Esc discards
				}
			},
		});
		await run;
		expect(readFileSync(join(testDir, "pi-chafa.json"), "utf8")).toBe(before);
		expect(writeSpy).not.toHaveBeenCalled();
		expect(notifyMock).toHaveBeenCalledWith(
			"pi-chafa: settings unchanged (cancelled)",
			"info",
		);
	});

	it("includes 'e' custom edits in the single Ctrl+S write and report (#046)", async () => {
		const realWrite = writeConfigFile;
		const writeSpy = vi.fn((dir: string, cfg: unknown) => realWrite(dir, cfg as ChafaConfig));
		const { run, notifyMock } = await mountPanel({
			deps: { writeConfigFile: writeSpy },
			input: () => "moon+triangle",
			select: () => "Symbols set",
			simulate: (c, mount) => {
				if (mount === 1) {
					c.handleInput("e");
				} else {
					c.handleInput("\x13"); // Ctrl+S
				}
			},
		});
		await run;
		expect(writeSpy).toHaveBeenCalledTimes(1);
		expect(loadConfig(testDir).symbolsSet).toBe("moon+triangle");
		expect(notifyMock).toHaveBeenCalledWith(
			`pi-chafa: 1 setting saved to ${testDir}/pi-chafa.json`,
			"info",
		);
	});

	it("an invalid 'e' value warns, re-prompts, and never writes (#046)", async () => {
		const realWrite = writeConfigFile;
		const writeSpy = vi.fn((dir: string, cfg: unknown) => realWrite(dir, cfg as ChafaConfig));
		const { run, notifyMock } = await mountPanel({
			deps: { writeConfigFile: writeSpy },
			input: () => "   ",
			select: () => "Symbols set",
			simulate: (c, mount) => {
				if (mount === 1) {
					c.handleInput("e");
				} else {
					c.handleInput("\x1b");
				}
			},
		});
		await run;
		expect(writeSpy).not.toHaveBeenCalled();
		expect(notifyMock).toHaveBeenCalledWith(
			"pi-chafa: invalid symbolsSet (cannot be empty)",
			"warning",
		);
	});

	it("refuses a control-character 'e' value with the refusal copy and stages nothing (#060)", async () => {
		// binaryPath used to be the silently-accepted case: its field has no
		// validator copy at all, so the panel's `else if (field.invalid !== null)`
		// stayed quiet and the escape bytes reached the file, which the next panel
		// open renders back into the row's currentValue (invariant 3).
		const realWrite = writeConfigFile;
		const writeSpy = vi.fn((dir: string, cfg: unknown) =>
			realWrite(dir, cfg as ChafaConfig),
		);
		const { run, notifyMock } = await mountPanel({
			deps: { writeConfigFile: writeSpy },
			input: () => "ascii\x1b[31m",
			select: () => "Symbols set",
			simulate: (c, mount) => {
				if (mount === 1) {
					c.handleInput("e"); // picker → Symbols set → the refused value
				} else {
					c.handleInput("\x13"); // Ctrl+S: would persist it if it had staged
				}
			},
		});
		await run;
		expect(writeSpy).not.toHaveBeenCalled();
		expect(notifyMock).toHaveBeenCalledWith(
			`pi-chafa: ${controlCharReason("symbolsSet")}`,
			"warning",
		);
	});

});

	it("offers an explicit close entry as the fallback's last option (#059)", async () => {
		// #054 removed the synthetic Done row because the TUI panel has Ctrl+S; the
		// fallback builds its options from the same items, so it silently lost its
		// only visible exit along with it. It cannot have Ctrl+S — no component is
		// mounted to intercept a key — so the exit is an entry, in the position the
		// removed row held.
		const pi = { getAllTools: () => [] };
		const notifyMock = vi.fn();
		const writer = vi.fn();
		const closeEntry = `Close — ${SETTING_DESCRIPTIONS.done}`;
		const selectMock = vi.fn().mockResolvedValueOnce(closeEntry).mockResolvedValue(undefined);
		const ctx = {
			mode: "rpc",
			hasUI: true,
			ui: { select: selectMock, notify: notifyMock, input: vi.fn() },
		};

		await runImagesCommand(pi as never, "", ctx as never, {
			writeConfigFile: writer,
		});

		expect((selectMock.mock.calls[0]?.[1] as string[]).at(-1)).toBe(closeEntry);
		// One call: the entry itself exited the loop, rather than falling through to
		// the next prompt (which would make it a row that does nothing).
		expect(selectMock).toHaveBeenCalledTimes(1);
		expect(writer).not.toHaveBeenCalled();
	});

	it("does not mistake a Co…-prefixed setting row for the close entry (#059)", async () => {
		const pi = { getAllTools: () => [] };
		const notifyMock = vi.fn();
		const realWrite = writeConfigFile;
		const writer = vi.fn((dir: string, cfg: unknown) =>
			realWrite(dir, cfg as ChafaConfig),
		);
		const selectMock = vi
			.fn()
			.mockResolvedValueOnce(`Color mode: [240] — ${SETTING_DESCRIPTIONS.colors}`)
			.mockResolvedValueOnce("8")
			.mockResolvedValue(undefined);
		const ctx = {
			mode: "rpc",
			hasUI: true,
			ui: { select: selectMock, notify: notifyMock, input: vi.fn() },
		};

		await runImagesCommand(pi as never, "", ctx as never, {
			writeConfigFile: writer,
		});

		expect(loadConfig(testDir).colors).toBe("8");
	});

	it("reaches the select flow in RPC mode instead of silently returning (#039)", async () => {
		const pi = { getAllTools: () => [] };
		// The entry that exits the flow is the close one (#059); #039's point is that
		// the flow is reached at all, rather than the command returning silently.
		const selectMock = vi.fn().mockResolvedValueOnce(
			`Close — ${SETTING_DESCRIPTIONS.done}`,
		);
		const customMock = vi.fn();
		const notifyMock = vi.fn();
		await runImagesCommand(pi as never, "", {
			mode: "rpc",
			hasUI: true,
			ui: {
				custom: customMock,
				select: selectMock,
				notify: notifyMock,
				input: vi.fn(),
			},
		} as never);
		expect(customMock).not.toHaveBeenCalled();
		expect(selectMock).toHaveBeenCalledTimes(1);
	});

	it("prints status to stdout in print mode (#039)", async () => {
		const pi = { getAllTools: () => [] };
		const writeSpy = vi
			.spyOn(process.stdout, "write")
			.mockImplementation(() => true);
		try {
			await runImagesCommand(
				pi as never,
				"status",
				{
					mode: "print",
					hasUI: false,
					ui: {
						custom: vi.fn(),
						select: vi.fn(),
						notify: vi.fn(),
						input: vi.fn(),
					},
				} as never,
				{
					probeChafa: async () => FAKE_PROBE,
					readHostImageSettings: () => ({
						showImages: true,
						imageWidthCells: 60,
						images: null,
					}),
				},
			);
			const [text] = writeSpy.mock.calls[0] as [string];
			expect(text).toContain("Detected image protocol:");
			expect(text.split("\n")).toHaveLength(5); // 4 facts + trailing newline
		} finally {
			writeSpy.mockRestore();
		}
	});

	it("writes status to stderr in json mode, keeping stdout clean (#039)", async () => {
		const pi = { getAllTools: () => [] };
		const stdoutSpy = vi
			.spyOn(process.stdout, "write")
			.mockImplementation(() => true);
		const stderrSpy = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		try {
			await runImagesCommand(
				pi as never,
				"status",
				{
					mode: "json",
					hasUI: false,
					ui: {
						custom: vi.fn(),
						select: vi.fn(),
						notify: vi.fn(),
						input: vi.fn(),
					},
				} as never,
				{
					probeChafa: async () => FAKE_PROBE,
					readHostImageSettings: () => ({
						showImages: true,
						imageWidthCells: 60,
						images: null,
					}),
				},
			);
			expect(stdoutSpy).not.toHaveBeenCalled();
			expect(stderrSpy).toHaveBeenCalledWith(
				expect.stringContaining("Detected image protocol:"),
			);
		} finally {
			stdoutSpy.mockRestore();
			stderrSpy.mockRestore();
		}
	});

	it("tells print users what still works and spawns no probe (#039, #050)", async () => {
		const pi = { getAllTools: () => [] };
		const probe = vi.fn(async () => FAKE_PROBE);
		const writeSpy = vi
			.spyOn(process.stdout, "write")
			.mockImplementation(() => true);
		try {
			await runImagesCommand(
				pi as never,
				"",
				{
					mode: "print",
					hasUI: false,
					ui: {
						custom: vi.fn(),
						select: vi.fn(),
						notify: vi.fn(),
						input: vi.fn(),
					},
				} as never,
				{ probeChafa: probe },
			);
			const [text] = writeSpy.mock.calls[0] as [string];
			// After #050 the message advertises the form that *does* work headless.
			expect(text).toContain("/images <key> <value>");
			expect(text).toContain("/images status");
			expect(probe).not.toHaveBeenCalled();
		} finally {
			writeSpy.mockRestore();
		}
	});
});


