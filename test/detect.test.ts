import { describe, expect, it } from "vitest";
import {
	decideDelivery,
	decideFileDelivery,
	type DeliveryInput,
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

describe("decideDelivery — spec §7.2 decision table", () => {
	it("kitty + showImages + preferNative default -> native", () => {
		expect(decideDelivery(input({ capsImages: "kitty" }))).toBe("native");
	});
	it("iterm2 + showImages -> native", () => {
		expect(decideDelivery(input({ capsImages: "iterm2" }))).toBe("native");
	});
	it("native-capable + preferNative=false -> symbols", () => {
		expect(decideDelivery(input({ capsImages: "kitty", preferNative: false }))).toBe("symbols");
	});
	it("native-capable + format=symbols -> symbols", () => {
		expect(decideDelivery(input({ capsImages: "kitty", format: "symbols" }))).toBe("symbols");
	});
	it("native-capable + showImages=false -> symbols (host would suppress blocks)", () => {
		expect(decideDelivery(input({ capsImages: "kitty", showImages: false }))).toBe("symbols");
	});
	it("null caps -> symbols regardless of preferNative", () => {
		expect(decideDelivery(input({ capsImages: null }))).toBe("symbols");
		expect(decideDelivery(input({ capsImages: null, format: "symbols" }))).toBe("symbols");
	});
	it("format=native forced on null caps -> informative error, not silent degrade", () => {
		expect(() => decideDelivery(input({ capsImages: null, format: "native" }))).toThrow(/format=native/);
		expect(() => decideDelivery(input({ capsImages: null, format: "native" }))).toThrow(/PI_IMAGE_PROTOCOL/);
	});
	it("format=native forced on native-capable with showImages=false -> symbols, not an error (spec §7.2 row 3)", () => {
		expect(
			decideDelivery(
				input({ capsImages: "kitty", showImages: false, format: "native" }),
			),
		).toBe("symbols");
	});
	it("format=auto on native-capable preferNative=true -> native", () => {
		expect(decideDelivery(input({ capsImages: "iterm2", format: "auto" }))).toBe("native");
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
});

describe("decideFileDelivery — native-safe mime rule (#014/#015)", () => {
	const UNSAFE_KNOWN = [
		{ mime: "image/svg+xml", loader: "SVG", label: "SVG" },
		{ mime: "image/avif", loader: "AVIF", label: "AVIF" },
		{ mime: "image/bmp", loader: "BMP", label: "BMP" },
		{ mime: "image/x-icon", loader: "ICO", label: "ICO" },
	] as const;
	const ALL_LOADERS = ["AVIF", "BMP", "GIF", "ICO", "JPEG", "PNG", "SVG", "WEBP"];

	it("returns native for every native-safe mime in a native session", () => {
		for (const mime of NATIVE_SAFE_MIMES) {
			expect(
				decideFileDelivery({ mime, mode: "native", format: "auto", chafaLoaders: null })
					.delivery,
			).toBe("native");
			expect(
				decideFileDelivery({ mime, mode: "native", format: "native", chafaLoaders: [] })
					.delivery,
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
				decideFileDelivery({ mime, mode: "symbols", format: "auto", chafaLoaders: null })
					.delivery,
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
		expect(plan.error).toBe(unrecognizedMimeMessage("application/octet-stream"));
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
						const plan = decideFileDelivery({ mime, mode, format, chafaLoaders });
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
