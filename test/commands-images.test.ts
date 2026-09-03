import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import {
	MENU,
	applyMenuChange,
	collectRuntimeFacts,
	describeRuntime,
} from "../src/commands/images.js";
import type { ChafaConfig } from "../src/types.js";

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

describe("applyMenuChange", () => {
	const base: ChafaConfig = { ...DEFAULT_CONFIG };
	it("parses a numeric width", () => {
		expect(applyMenuChange(base, "Change cellWidth", "  84  ")!.cellWidth).toBe(84);
	});
	it("validates colors against the enum and rejects bad input", () => {
		expect(applyMenuChange(base, "Change colors", "16")!.colors).toBe("16");
		expect(applyMenuChange(base, "Change colors", "neon")).toBeNull();
	});
	it("toggles preferNative without reading a value", () => {
		expect(applyMenuChange(base, "Toggle preferNative", "")!.preferNative).toBe(false);
		expect(applyMenuChange({ ...base, preferNative: false }, "Toggle preferNative", "")!.preferNative).toBe(true);
	});
	it("accepts a binary path or clears it", () => {
		expect(applyMenuChange(base, "Set chafa binary path", "/opt/chafa")!.binaryPath).toBe("/opt/chafa");
		expect(applyMenuChange(base, "Set chafa binary path", "")!.binaryPath).toBeNull();
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
