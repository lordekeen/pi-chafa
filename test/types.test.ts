import { describe, expect, it } from "vitest";
import {
	type ChafaConfig,
	COLOR_MODES,
	type ColorsMode,
	DELIVERY_FORMATS,
	type DeliveryFormat,
	DITHER_MODES,
	type DitherMode,
} from "../src/types.js";

describe("mode constants match the spec §6.1 / §4.1.1 enums", () => {
	it("colors enum matches the documented chafa colors modes", () => {
		expect(COLOR_MODES).toEqual(["none", "2", "8", "16", "240", "256", "full"]);
	});
	it("dither enum matches the documented chafa dither modes", () => {
		expect(DITHER_MODES).toEqual(["none", "ordered", "diffusion", "noise"]);
	});
	it("delivery formats enum matches the spec tool param", () => {
		expect(DELIVERY_FORMATS).toEqual(["auto", "native", "symbols"]);
	});
	it("unions are derived from the constant arrays", () => {
		const color: ColorsMode = COLOR_MODES[0];
		const dither: DitherMode = DITHER_MODES[0];
		const format: DeliveryFormat = DELIVERY_FORMATS[0];
		expect([color, dither, format].length).toBe(3);
	});
	it("ChafaConfig carries the documented default-shape fields", () => {
		const cfg: ChafaConfig = {
			version: 1,
			preferNative: true,
			cellWidth: 60,
			maxRows: 50,
			colors: "240",
			symbolsSet: "block+border",
			dither: "none",
			formatOrder: ["symbols"],
			binaryPath: null,
			timeoutMs: 8000,
		};
		expect(cfg.cellWidth).toBe(60);
		expect(cfg.formatOrder).toEqual(["symbols"]);
	});
});
