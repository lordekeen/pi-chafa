import { describe, expect, it } from "vitest";
import {
	type DeliveryInput,
	decideDelivery,
	decideFileDelivery,
	isTmux,
	knownNoImageSupport,
	missingLoaderMessage,
	NATIVE_SAFE_MIMES,
	nativeRefusalMessage,
	resolveCapsImages,
	symbolsDegradeNote,
	unrecognizedMimeMessage,
} from "../src/detect.js";

function input(partial: Partial<DeliveryInput>): DeliveryInput {
	return {
		capsImages: null,
		showImages: true,
		preferNative: true,
		format: "auto",
		...partial,
	};
}

/** The thrown message of a forced decision, or "" when it did not throw. */
function messageOf(partial: Partial<DeliveryInput>): string {
	try {
		decideDelivery(input(partial));
		return "";
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

describe("decideDelivery — spec §7.2 decision table", () => {
	it("kitty + showImages + preferNative default -> native", () => {
		expect(decideDelivery(input({ capsImages: "kitty" }))).toBe("native");
	});
	it("iterm2 + showImages -> native", () => {
		expect(decideDelivery(input({ capsImages: "iterm2" }))).toBe("native");
	});
	it("native-capable + preferNative=false -> symbols", () => {
		expect(
			decideDelivery(input({ capsImages: "kitty", preferNative: false })),
		).toBe("symbols");
	});
	it("native-capable + format=symbols -> symbols", () => {
		expect(
			decideDelivery(input({ capsImages: "kitty", format: "symbols" })),
		).toBe("symbols");
	});
	it("native-capable + showImages=false -> symbols (host would suppress blocks)", () => {
		expect(
			decideDelivery(input({ capsImages: "kitty", showImages: false })),
		).toBe("symbols");
	});
	it("null caps -> symbols regardless of preferNative", () => {
		expect(decideDelivery(input({ capsImages: null }))).toBe("symbols");
		expect(decideDelivery(input({ capsImages: null, format: "symbols" }))).toBe(
			"symbols",
		);
	});
	it("format=native forced on null caps -> informative error, not silent degrade", () => {
		expect(() =>
			decideDelivery(input({ capsImages: null, format: "native" })),
		).toThrow(/format=native/);
		expect(() =>
			decideDelivery(input({ capsImages: null, format: "native" })),
		).toThrow(/PI_IMAGE_PROTOCOL/);
	});
	it("forced-native error is worded for tmux: PI_IMAGE_PROTOCOL opt-in, not the ignored setting (#030)", () => {
		const message = messageOf({
			capsImages: null,
			format: "native",
			env: { TMUX: "/tmp/tmux-1000/default,12936,0", TERM: "tmux-256color" },
			platform: "linux",
		});
		expect(message).toMatch(/cannot render native images/);
		expect(message).toMatch(/Under tmux/);
		expect(message).toMatch(/export PI_IMAGE_PROTOCOL=kitty/);
		expect(message).not.toMatch(/terminal\.images/);
	});
	it("forced-native error names an incapable terminal instead of suggesting a setting (#030)", () => {
		const message = messageOf({
			capsImages: null,
			format: "native",
			env: { TERM_PROGRAM: "vscode" },
			platform: "linux",
		});
		expect(message).toMatch(/known not to support image protocols/);
		expect(message).not.toMatch(/terminal\.images/);
	});
	it("forced-native error keeps the tmux opt-in hint on a default tmux pane (TERM=screen*, #031)", () => {
		const message = messageOf({
			capsImages: null,
			format: "native",
			env: { TMUX: "/tmp/tmux-1000/default,1,0", TERM: "screen-256color" },
			platform: "linux",
		});
		expect(message).toMatch(/export PI_IMAGE_PROTOCOL=kitty/);
		expect(message).not.toMatch(/known not to support/);
	});
	it("forced-native error stays honest when tmux sits on a denied outer terminal (#031)", () => {
		const message = messageOf({
			capsImages: null,
			format: "native",
			env: {
				TMUX: "/tmp/tmux-1000/default,1,0",
				TERM: "screen-256color",
				ALACRITTY_WINDOW_ID: "1",
			},
			platform: "linux",
		});
		expect(message).toMatch(/known not to support image protocols/);
		expect(message).not.toMatch(/export PI_IMAGE_PROTOCOL=kitty/);
	});
	it("format=native forced on native-capable with showImages=false -> symbols, not an error (spec §7.2 row 3)", () => {
		expect(
			decideDelivery(
				input({ capsImages: "kitty", showImages: false, format: "native" }),
			),
		).toBe("symbols");
	});
	it("format=auto on native-capable preferNative=true -> native", () => {
		expect(
			decideDelivery(input({ capsImages: "iterm2", format: "auto" })),
		).toBe("native");
	});
});

describe("resolveCapsImages — capability fallback ladder", () => {
	it("step 1: a non-null caps value wins over host settings and env", () => {
		expect(resolveCapsImages("kitty", "iterm2", "iterm2")).toBe("kitty");
		expect(resolveCapsImages("iterm2", null, "kitty")).toBe("iterm2");
	});
	it("step 2: caps null + terminal.images kitty -> kitty", () => {
		expect(resolveCapsImages(null, "kitty", undefined)).toBe("kitty");
	});
	it("step 2: caps null + terminal.images iterm2 -> iterm2", () => {
		expect(resolveCapsImages(null, "iterm2", undefined)).toBe("iterm2");
	});
	it("step 2: caps null + terminal.images false -> null (user disabled images)", () => {
		expect(resolveCapsImages(null, false, undefined)).toBe(null);
	});
	it("step 2: caps null + terminal.images 'auto' -> null", () => {
		expect(resolveCapsImages(null, "auto", undefined)).toBe(null);
	});
	it("step 2: caps null + unrecognised terminal.images -> null", () => {
		expect(resolveCapsImages(null, "wezterm", undefined)).toBe(null);
		expect(resolveCapsImages(null, true, undefined)).toBe(null);
	});
	it("step 3: caps null + no host override + PI_IMAGE_PROTOCOL=iterm2 -> iterm2", () => {
		expect(resolveCapsImages(null, null, "iterm2")).toBe("iterm2");
	});
	it("step 3: caps null + no host override + PI_IMAGE_PROTOCOL=kitty -> kitty", () => {
		expect(resolveCapsImages(null, null, "kitty")).toBe("kitty");
	});
	it("step 3: PI_IMAGE_PROTOCOL none/auto/unknown -> null", () => {
		expect(resolveCapsImages(null, null, "none")).toBe(null);
		expect(resolveCapsImages(null, null, "auto")).toBe(null);
		expect(resolveCapsImages(null, null, "wezterm")).toBe(null);
	});
	it("step 2 outranks step 3 (host setting beats env)", () => {
		expect(resolveCapsImages(null, "kitty", "iterm2")).toBe("kitty");
	});
	it("step 4: all sources empty -> null", () => {
		expect(resolveCapsImages(null, null, undefined)).toBe(null);
	});
	it("#031: a marker-denied outer terminal outvotes the tmux opt-in", () => {
		expect(
			resolveCapsImages(
				null,
				true,
				"kitty",
				{
					TMUX: "/tmp/tmux-1000/default,1,0",
					TERM: "screen-256color",
					ALACRITTY_WINDOW_ID: "1",
				},
				"linux",
			),
		).toBe(null);
	});
	it("#031: plain tmux (upstream TERM=screen*) keeps the PI_IMAGE_PROTOCOL opt-in", () => {
		expect(
			resolveCapsImages(
				null,
				true,
				"kitty",
				{ TMUX: "/tmp/tmux-1000/default,1,0", TERM: "screen-256color" },
				"linux",
			),
		).toBe("kitty");
	});
});

describe("knownNoImageSupport / isTmux — #026 environment guard", () => {
	it("denies the terminals pi-tui knows cannot render image protocols", () => {
		const cases: Array<{
			label: string;
			env: Record<string, string>;
			platform: string;
		}> = [
			{
				label: "TERM_PROGRAM=alacritty",
				env: { TERM_PROGRAM: "alacritty" },
				platform: "linux",
			},
			{
				label: "ALACRITTY_LOG",
				env: { ALACRITTY_LOG: "/tmp/alacritty.log" },
				platform: "linux",
			},
			{
				label: "ALACRITTY_WINDOW_ID",
				env: { ALACRITTY_WINDOW_ID: "1" },
				platform: "linux",
			},
			{
				label: "ALACRITTY_SOCKET",
				env: { ALACRITTY_SOCKET: "/run/alacritty" },
				platform: "linux",
			},
			{
				label: "TERM_PROGRAM=vscode",
				env: { TERM_PROGRAM: "vscode" },
				platform: "linux",
			},
			{
				label: "TERM_PROGRAM=zed",
				env: { TERM_PROGRAM: "zed" },
				platform: "linux",
			},
			{
				label: "jetbrains-jediterm",
				env: { TERMINAL_EMULATOR: "jetbrains-jediterm" },
				platform: "linux",
			},
			{ label: "WT_SESSION", env: { WT_SESSION: "abc" }, platform: "linux" },
			{
				label: "TERM=screen",
				env: { TERM: "screen-256color" },
				platform: "linux",
			},
			{ label: "win32 platform", env: {}, platform: "win32" },
		];
		for (const { label, env, platform } of cases) {
			expect(knownNoImageSupport(env, platform), label).toBe(true);
		}
	});
	it("does not deny genuine protocol markers (pi-tui checks positives first)", () => {
		expect(
			knownNoImageSupport(
				{ TERM_PROGRAM: "wezterm", WT_SESSION: "x" },
				"win32",
			),
		).toBe(false);
		expect(
			knownNoImageSupport(
				{ KITTY_WINDOW_ID: "1", ALACRITTY_LOG: "/tmp/a" },
				"linux",
			),
		).toBe(false);
		expect(
			knownNoImageSupport(
				{ GHOSTTY_RESOURCES_DIR: "/x", TERM_PROGRAM: "vscode" },
				"linux",
			),
		).toBe(false);
		expect(knownNoImageSupport({ ITERM_SESSION_ID: "w0t0p0" }, "linux")).toBe(
			false,
		);
	});
	it("denies screen before the positive markers, matching pi-tui's order", () => {
		expect(
			knownNoImageSupport(
				{ TERM: "screen-256color", TERM_PROGRAM: "kitty" },
				"linux",
			),
		).toBe(true);
	});
	it("leaves unknown terminals alone so declarations stay the escape hatch", () => {
		expect(
			knownNoImageSupport(
				{ TERM: "xterm-konsole", TERM_PROGRAM: "konsole" },
				"linux",
			),
		).toBe(false);
		expect(knownNoImageSupport({ TERM: "xterm-256color" }, "linux")).toBe(
			false,
		);
	});
	it("classifies tmux", () => {
		expect(isTmux({ TMUX: "/tmp/tmux-1000/default,1,0" })).toBe(true);
		expect(isTmux({ TERM: "tmux-256color" })).toBe(true);
		expect(isTmux({ TERM: "screen-256color" })).toBe(false);
		expect(isTmux({})).toBe(false);
	});
});

describe("resolveCapsImages — #026 guard integration", () => {
	const TMUX = { TMUX: "/tmp/tmux-1000/default,1,0" };
	it("hard-denied terminals cannot be declared native by any source", () => {
		const env = { TERM_PROGRAM: "alacritty" };
		expect(resolveCapsImages("kitty", "kitty", "kitty", env, "linux")).toBe(
			null,
		);
		expect(resolveCapsImages(null, "kitty", "kitty", env, "linux")).toBe(null);
		expect(resolveCapsImages(null, null, "kitty", env, "linux")).toBe(null);
	});
	it("tmux ignores ambient declarations but honors PI_IMAGE_PROTOCOL", () => {
		expect(resolveCapsImages("kitty", "kitty", undefined, TMUX, "linux")).toBe(
			null,
		);
		expect(resolveCapsImages(null, "kitty", undefined, TMUX, "linux")).toBe(
			null,
		);
		expect(resolveCapsImages(null, "kitty", "kitty", TMUX, "linux")).toBe(
			"kitty",
		);
		expect(resolveCapsImages("iterm2", "kitty", "iterm2", TMUX, "linux")).toBe(
			"iterm2",
		);
	});
	it("keeps the declaration on unknown terminals (e.g. Konsole)", () => {
		expect(
			resolveCapsImages(
				null,
				"kitty",
				undefined,
				{ TERM: "xterm-konsole" },
				"linux",
			),
		).toBe("kitty");
	});
	it("win32 denies declarations but genuine protocol markers still win", () => {
		expect(resolveCapsImages(null, "kitty", "kitty", {}, "win32")).toBe(null);
		expect(
			resolveCapsImages(
				null,
				"kitty",
				undefined,
				{ TERM_PROGRAM: "wezterm" },
				"win32",
			),
		).toBe("kitty");
	});
	it("empty env/platform keeps the pre-#026 ladder exactly", () => {
		expect(resolveCapsImages("kitty", "iterm2", "iterm2", {}, "")).toBe(
			"kitty",
		);
		expect(resolveCapsImages(null, "kitty", undefined, {}, "")).toBe("kitty");
	});
});

describe("decideFileDelivery — native-safe mime rule (#014/#015)", () => {
	const UNSAFE_KNOWN = [
		{ mime: "image/svg+xml", loader: "SVG", label: "SVG" },
		{ mime: "image/avif", loader: "AVIF", label: "AVIF" },
		{ mime: "image/bmp", loader: "BMP", label: "BMP" },
		{ mime: "image/x-icon", loader: "ICO", label: "ICO" },
	] as const;
	const ALL_LOADERS = [
		"AVIF",
		"BMP",
		"GIF",
		"ICO",
		"JPEG",
		"PNG",
		"SVG",
		"WEBP",
	];

	it("returns native for every native-safe mime in a native session", () => {
		for (const mime of NATIVE_SAFE_MIMES) {
			expect(
				decideFileDelivery({
					mime,
					mode: "native",
					format: "auto",
					chafaLoaders: null,
				}).delivery,
			).toBe("native");
			expect(
				decideFileDelivery({
					mime,
					mode: "native",
					format: "native",
					chafaLoaders: [],
				}).delivery,
			).toBe("native");
		}
	});
	it("degrades a native session to symbols for a recognized-but-unsafe mime", () => {
		for (const { mime, label } of UNSAFE_KNOWN) {
			const plan = decideFileDelivery({
				mime,
				mode: "native",
				format: "auto",
				chafaLoaders: ALL_LOADERS,
			});
			expect(plan.delivery).toBe("symbols");
			expect(plan.degraded).toBe(true);
			expect(plan.note).toContain(label);
			expect(plan.note).toMatch(/rasterizer/);
			expect(plan.note).toBe(symbolsDegradeNote(mime));
		}
	});
	it("keeps safe mimes on symbols without marking them degraded", () => {
		for (const mime of NATIVE_SAFE_MIMES) {
			const plan = decideFileDelivery({
				mime,
				mode: "symbols",
				format: "auto",
				chafaLoaders: null,
			});
			expect(plan.delivery).toBe("symbols");
			expect(plan.degraded).toBeUndefined();
			expect(plan.note).toBeUndefined();
		}
	});
	it("errors rather than degrades when format=native is forced on an unsafe mime", () => {
		for (const { mime } of UNSAFE_KNOWN) {
			const plan = decideFileDelivery({
				mime,
				mode: "native",
				format: "native",
				chafaLoaders: ALL_LOADERS,
			});
			expect(plan.delivery).toBe("error");
			expect(plan.error).toMatch(/cannot be delivered as a native image block/);
			expect(plan.error).toMatch(/format="symbols"/);
			expect(plan.error).toBe(nativeRefusalMessage(mime));
		}
	});
	it("errors when the chafa build lacks the loader for a recognized format", () => {
		const plan = decideFileDelivery({
			mime: "image/bmp",
			mode: "symbols",
			format: "auto",
			chafaLoaders: ["PNG", "SVG"],
		});
		expect(plan.delivery).toBe("error");
		expect(plan.error).toMatch(/BMP/);
		expect(plan.error).toMatch(/loader/);
		expect(plan.error).toBe(missingLoaderMessage("image/bmp", "BMP"));
	});
	it("errors on a missing loader in a native session too (no path can render it)", () => {
		const plan = decideFileDelivery({
			mime: "image/x-icon",
			mode: "native",
			format: "auto",
			chafaLoaders: ["PNG"],
		});
		expect(plan.delivery).toBe("error");
		expect(plan.error).toMatch(/ICO/);
	});
	it("attempts when the loader list is unknown (null), never guessing they are missing", () => {
		for (const { mime } of UNSAFE_KNOWN) {
			expect(
				decideFileDelivery({
					mime,
					mode: "symbols",
					format: "auto",
					chafaLoaders: null,
				}).delivery,
			).toBe("symbols");
		}
	});
	it("errors for an unrecognized mime in a native session, keeping the actionable wording", () => {
		const plan = decideFileDelivery({
			mime: "application/octet-stream",
			mode: "native",
			format: "auto",
			chafaLoaders: null,
		});
		expect(plan.delivery).toBe("error");
		expect(plan.error).toMatch(/not a recognized image format/);
		expect(plan.error).toBe(
			unrecognizedMimeMessage("application/octet-stream"),
		);
	});
	it("still attempts an unrecognized mime on the symbols path (chafa is format-flexible)", () => {
		expect(
			decideFileDelivery({
				mime: "application/octet-stream",
				mode: "symbols",
				format: "auto",
				chafaLoaders: null,
			}).delivery,
		).toBe("symbols");
	});
	it("EXHAUSTIVE: native is only ever chosen for a native-safe mime", () => {
		const mimes = [
			...NATIVE_SAFE_MIMES,
			...UNSAFE_KNOWN.map((entry) => entry.mime),
			"application/octet-stream",
			"image/tiff",
		];
		for (const mime of mimes) {
			for (const mode of ["native", "symbols"] as const) {
				for (const format of ["auto", "native", "symbols"] as const) {
					for (const chafaLoaders of [null, ALL_LOADERS, ["PNG"]]) {
						const plan = decideFileDelivery({
							mime,
							mode,
							format,
							chafaLoaders,
						});
						if (plan.delivery === "native") {
							expect(NATIVE_SAFE_MIMES).toContain(mime);
						}
						if (plan.delivery === "error") {
							expect(plan.error).toBeTruthy();
							expect(plan.degraded).toBeUndefined();
						}
						if (plan.delivery === "symbols" && plan.degraded) {
							expect(NATIVE_SAFE_MIMES).not.toContain(mime);
						}
					}
				}
			}
		}
	});
});
