import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getKeybindings,
	KeybindingsManager,
	setKeybindings,
	TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, loadConfig } from "../src/config.js";
import {
	SETTING_DESCRIPTIONS,
	applyMenuChange,
	buildSettingItems,
	collectRuntimeFacts,
	createSettingsTheme,
	describeRuntime,
	type ImagesCommandDeps,
	resolveRuntimeCaps,
	runImagesCommand as runImagesCommandRaw,
} from "../src/commands/images.js";
import { COLOR_MODES, DITHER_MODES, type ChafaConfig } from "../src/types.js";

/** A synthetic successful probe — the suite must never spawn the real chafa (#019). */
const FAKE_PROBE = {
	binary: "chafa",
	version: { major: 1, minor: 18 },
	loaders: ["PNG", "JPEG", "GIF", "WEBP"],
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
			"timeoutMs",
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

	it("keeps 'e' aligned with the highlight under remapped keys (#041)", async () => {
		const originalKb = getKeybindings();
		const remapped = new KeybindingsManager(TUI_KEYBINDINGS, {
			...originalKb.getResolvedBindings(),
			"tui.select.up": "ctrl+p",
			"tui.select.down": "ctrl+n",
		});
		setKeybindings(remapped);
		let resolvePanel: (r: { action: string; id?: string }) => void = () => {};
		const inputMock = vi.fn();
		let mounted: { handleInput: (data: string) => void } | undefined;
		try {
			const customMock = vi.fn().mockImplementation(async (cb) => {
				const component = cb(
					{ requestRender: vi.fn() },
					{
						fg: (_c: string, text: string) => text,
						bold: (text: string) => text,
					},
					getKeybindings(),
					(r: { action: string; id?: string }) => resolvePanel(r),
				) as { handleInput: (data: string) => void };
				mounted = component;
				if (customMock.mock.calls.length === 1) {
					// Legacy arrows are dead under the remap: the highlight stays on
					// the first row, so 'e' must NOT open an edit dialog.
					for (let i = 0; i < 5; i++) component.handleInput("\x1b[B");
					component.handleInput("e");
					return new Promise((res) => {
						resolvePanel = res;
					});
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
						select: vi.fn(),
						notify: vi.fn(),
						input: inputMock,
					},
				} as never,
			);
			await vi.waitFor(() => {
				expect(customMock).toHaveBeenCalledTimes(1);
			});
			expect(inputMock).not.toHaveBeenCalled();
			// Now navigate with the remapped key and 'e' must hit Max rows (row 5).
			for (let i = 0; i < 5; i++) mounted?.handleInput("\x0e"); // ctrl+n
			mounted?.handleInput("e");
			await vi.waitFor(() => {
				expect(inputMock).toHaveBeenCalledTimes(1);
			});
			expect(inputMock.mock.calls[0]?.[0]).toContain("maxRows");
			resolvePanel({ action: "done" });
			await run;
		} finally {
			setKeybindings(originalKb);
		}
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

	it("sanitizes the saved symbolsSet notification from the 'e' edit path (#038)", async () => {
		const pi = { getAllTools: () => [] };
		const notifyMock = vi.fn();
		const inputMock = vi.fn().mockResolvedValueOnce("evil\x1b[2Jset");
		let handleInput: ((data: string) => void) | undefined;

		const customMock = vi.fn().mockImplementation(async (cb) => {
			const tui = { requestRender: vi.fn() };
			const theme = {
				fg: (_c: string, text: string) => text,
				bold: (text: string) => text,
			};
			if (customMock.mock.calls.length === 1) {
				// First mount: wire done() to resolve the ui.custom promise, move the
				// cursor to the Symbols set row (index 3) and press 'e'.
				let resolveDone: (r: { action: string; id?: string }) => void =
					() => {};
				const promise = new Promise<{ action: string; id?: string }>(
					(resolve) => {
						resolveDone = resolve;
					},
				);
				const component = cb(
					tui,
					theme,
					getKeybindings(),
					(r: { action: string; id?: string }) => resolveDone(r),
				) as {
					handleInput: (data: string) => void;
				};
				handleInput = component.handleInput;
				// Symbols set is row 3 (preferNative, colors, dither, symbolsSet).
				// Arrow keys arrive as legacy escape sequences, not bare names.
				handleInput("\x1b[B");
				handleInput("\x1b[B");
				handleInput("\x1b[B");
				handleInput("e");
				return promise;
			}
			return { action: "done" };
		});

		const ctx = {
			mode: "tui",
			hasUI: true,
			ui: {
				custom: customMock,
				select: vi.fn(),
				notify: notifyMock,
				input: inputMock,
			},
		};

		await runImagesCommand(pi as never, "", ctx as never);

		const messages = notifyMock.mock.calls.map((call) => call[0] as string);
		const saved = messages.find((m) => m.includes("symbolsSet"));
		expect(saved).toBeDefined();
		expect(saved).toContain("evilset");
		expect(saved).not.toContain("\x1b");
	});

	it("closes the panel on lowercase q and documents it in the hint (#003)", async () => {
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
		expect(rendered.join("\n")).toContain("Esc/q close");
		handleInput?.("q");
		expect(doneMock).toHaveBeenCalledWith({ action: "done" });
	});

	it("closes the panel on uppercase Q (#003)", async () => {
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
		expect(doneMock).toHaveBeenCalledWith({ action: "done" });
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
				return { action: "input", id: "binaryPath" };
			}
			return { action: "done" };
		});

		const ctx = {
			mode: "tui",
			hasUI: true,
			ui: {
				custom: customMock,
				select: vi.fn(),
				notify: notifyMock,
				input: inputMock,
			},
		};

		await runImagesCommand(pi as never, "", ctx as never);

		expect(inputMock).toHaveBeenCalledWith(
			"Chafa binary path",
			expect.any(String),
		);
		const cfg = loadConfig(testDir);
		expect(cfg.binaryPath).toBe("/custom/chafa");
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

	it("persists timeoutMs through the TUI custom-input path", async () => {
		const pi = { getAllTools: () => [] };
		const notifyMock = vi.fn();
		const inputMock = vi.fn().mockResolvedValue("30000");

		let invocation = 0;
		const customMock = vi.fn().mockImplementation(async (cb) => {
			invocation++;
			const tui = { requestRender: vi.fn() };
			const theme = {
				fg: (_c: string, text: string) => text,
				bold: (text: string) => text,
			};
			cb(tui, theme, getKeybindings(), () => {});
			if (invocation === 1) return { action: "input", id: "timeoutMs" };
			return { action: "done" };
		});

		const ctx = {
			mode: "tui",
			hasUI: true,
			ui: {
				custom: customMock,
				select: vi.fn(),
				notify: notifyMock,
				input: inputMock,
			},
		};

		await runImagesCommand(pi as never, "", ctx as never);

		expect(inputMock).toHaveBeenCalledWith(
			"New timeoutMs (milliseconds)",
			expect.any(String),
		);
		expect(loadConfig(testDir).timeoutMs).toBe(30000);
		expect(notifyMock).toHaveBeenCalledWith(
			"pi-chafa: saved timeoutMs = 30000",
			"info",
		);
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
			if (invocation === 1) return { action: "input", id: "timeoutMs" };
			return { action: "done" };
		});

		const ctx = {
			mode: "tui",
			hasUI: true,
			ui: {
				custom: customMock,
				select: vi.fn(),
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

	it("reaches the select flow in RPC mode instead of silently returning (#039)", async () => {
		const pi = { getAllTools: () => [] };
		const selectMock = vi.fn().mockResolvedValueOnce(
			`Done — ${SETTING_DESCRIPTIONS.done}`,
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

	it("tells print users the panel is interactive-only and spawns no probe (#039)", async () => {
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
			expect(text).toContain("interactive-only");
			expect(text).toContain("/images status");
			expect(probe).not.toHaveBeenCalled();
		} finally {
			writeSpy.mockRestore();
		}
	});
});


