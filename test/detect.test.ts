import { describe, expect, it } from "vitest";
import {
	decideDelivery,
	type DeliveryInput,
	resolveCapsImages,
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
