import { describe, expect, it } from "vitest";
import { decideDelivery, type DeliveryInput } from "../src/detect.js";

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
	it("format=native forced when showImages=false -> informative error", () => {
		expect(() => decideDelivery(input({ capsImages: "kitty", showImages: false, format: "native" }))).toThrow(
			/format=native/,
		);
	});
	it("format=auto on native-capable preferNative=true -> native", () => {
		expect(decideDelivery(input({ capsImages: "iterm2", format: "auto" }))).toBe("native");
	});
});
