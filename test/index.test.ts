import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piChafaExtension from "../src/index.js";

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

	it("completes the status argument for an empty prefix only (#041)", async () => {
		const commands = new Map<string, { getArgumentCompletions?: (p: string) => unknown }>();
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

		const images = commands.get("images");
		expect(images?.getArgumentCompletions).toBeTypeOf("function");
		const completions = images?.getArgumentCompletions?.("") as
			| Array<{ value: string; label: string; description?: string }>
			| undefined;
		// The description is what tells the user what the argument does (#055); its
		// exact wording is not pinned here so copy edits stay cheap.
		expect(completions?.map((c) => [c.value, c.label])).toEqual([
			["status", "status"],
		]);
		expect(completions?.[0]?.description).toBeTruthy();
		const partial = images?.getArgumentCompletions?.("st") as unknown[];
		expect(partial).toEqual([]);
	});
});