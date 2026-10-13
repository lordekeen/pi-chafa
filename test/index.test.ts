import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { SETTING_KEYS } from "../src/commands/images.js";
import piChafaExtension from "../src/index.js";
import { COLOR_MODES } from "../src/types.js";

describe("piChafaExtension registration", () => {
	it("registers the show_image tool and the images command", () => {
		const registered = new Map<string, unknown>();
		const pi = {
			registerTool: (tool: unknown) => {
				registered.set("show_image", tool);
			},
			registerCommand: (name: string, options: unknown) => {
				registered.set(name, options);
			},
		} as unknown as ExtensionAPI;

		piChafaExtension(pi);

		expect(registered.has("show_image")).toBe(true);
		expect(registered.has("images")).toBe(true);
	});

	it("completes the argument grammar the command accepts (#041, #050)", async () => {
		const commands = new Map<
			string,
			{ getArgumentCompletions?: (p: string) => unknown }
		>();
		const pi = {
			registerTool: vi.fn(),
			registerCommand: (
				name: string,
				options: { getArgumentCompletions?: (p: string) => unknown },
			) => {
				commands.set(name, options);
			},
		} as unknown as ExtensionAPI;

		piChafaExtension(pi);

		const completions = (prefix: string) => {
			const images = commands.get("images");
			expect(images?.getArgumentCompletions).toBeTypeOf("function");
			return (images?.getArgumentCompletions?.(prefix) ?? []) as Array<{
				value: string;
				label: string;
				description?: string;
			}>;
		};

		// First token: the diagnostic plus every setting key, each explained — the
		// descriptions are what tell the user what each key does (#055); their exact
		// wording is not pinned here so copy edits stay cheap.
		const first = completions("");
		expect(first.map((c) => c.value)).toEqual(["status", ...SETTING_KEYS]);
		expect(first.every((c) => (c.description ?? "").length > 0)).toBe(true);
		// Descriptions are the command-line copy, not the panel's: they must not tell a
		// command-line user to press Enter/Space or 'e'.
		expect(completions("cellWidth")[0]?.description).toBe(
			"Width in terminal columns",
		);
		expect(
			first.every((c) => !/Enter\/Space|Press 'e'/.test(c.description ?? "")),
		).toBe(true);

		// A partial first token narrows to what it could be.
		expect(completions("col").map((c) => c.value)).toEqual(["colors"]);
		expect(completions("st").map((c) => c.value)).toEqual(["status"]);
		expect(completions("zzz")).toEqual([]);

		// After a key, enumeration keys offer their own values. Items carry the whole
		// argument text, because the host replaces the entire argument prefix with the
		// accepted item's `value` (pi-tui autocomplete.js applyCompletion).
		expect(completions("colors ").map((c) => c.value)).toEqual(
			COLOR_MODES.map((value) => `colors ${value}`),
		);
		expect(completions("dither or").map((c) => c.value)).toEqual([
			"dither ordered",
		]);
		expect(completions("symbolsSet br").map((c) => c.value)).toEqual([
			"symbolsSet braille",
		]);
		// Extra whitespace between key and value: the handler splits on the first
		// whitespace run and trims it, so completion must not fall silent on input the
		// command itself accepts (#063).
		expect(completions("colors  8").map((c) => c.value)).toEqual(["colors 8"]);
		expect(completions("colors \t").map((c) => c.value)).toEqual(
			COLOR_MODES.map((value) => `colors ${value}`),
		);
		// Free-form and unknown keys offer nothing rather than a wrong guess.
		expect(completions("binaryPath ")).toEqual([]);
		expect(completions("bogus ")).toEqual([]);
	});
});
