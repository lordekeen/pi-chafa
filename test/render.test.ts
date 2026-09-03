import { describe, expect, it } from "vitest";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { renderShowCall, renderShowResult } from "../src/show-image.js";
import type { ShowImageDetails } from "../src/types.js";

const PAYLOAD = "  \x1b[38;5;1m█\x1b[0m\n \x1b[38;5;2m█\x1b[0m";

/**
 * Text.render(width) pads every line to `width` columns with trailing spaces
 * (pi-tui text.js). Assertions target the component's content, so trim the
 * trailing padding per line before joining.
 */
function rendered(component: Text): string {
	return component.render(120).map((line) => line.trimEnd()).join("\n");
}

function details(partial: Partial<ShowImageDetails>): ShowImageDetails {
	return {
		mode: "symbols",
		files: [],
		settings: {
			format: "auto",
			cellWidth: 60,
			maxRows: 50,
			colors: "240",
			symbolsSet: "block+border",
			dither: "none",
			preferNative: true,
		},
		...partial,
	};
}

function resultWith(partial: { text?: string; details?: ShowImageDetails }): AgentToolResult<ShowImageDetails> {
	return {
		content: [{ type: "text", text: partial.text ?? "Showed image pic.png to the user as ANSI art." }],
		details: partial.details ?? details({}),
	};
}

describe("renderResult — Text assembly (spec §4.1.3)", () => {
	it("symbols mode returns a Text carrying the summary caption above the ANSI payload", () => {
		const component = renderShowResult(resultWith({ details: details({ payload: PAYLOAD }) }), false);
		expect(component).toBeInstanceOf(Text);
		const joined = rendered(component);
		expect(joined).toContain("Showed image pic.png to the user as ANSI art.");
		expect(joined).toContain(PAYLOAD);
	});
	it("preserves ANSI escape sequences verbatim (never stripped)", () => {
		const component = renderShowResult(resultWith({ details: details({ payload: PAYLOAD }) }), false);
		expect(rendered(component)).toContain("\x1b[38;5;1m");
	});
	it("no payload (native caption or partial) renders just the summary text", () => {
		const native = resultWith({
			text: "Showed image pic.png to the user via terminal-native rendering.",
			details: details({ mode: "native", payload: undefined }),
		});
		const component = renderShowResult(native, false);
		expect(rendered(component)).toBe(
			"Showed image pic.png to the user via terminal-native rendering.",
		);
	});
	it("error results (details wiped by the host to {}) render the error text through the error path", () => {
		const errorResult = { content: [{ type: "text", text: "no files matched **/*.svg" }], details: {} };
		const component = renderShowResult(errorResult as AgentToolResult<ShowImageDetails>, true);
		expect(rendered(component)).toBe("no files matched **/*.svg");
	});
});

describe("renderCall (spec §4.1 registration table: compact 'Show Image <target>')", () => {
	it("shows the path target", () => {
		const component = renderShowCall({ path: "/abs/pic.png" });
		expect(rendered(component)).toBe("Show Image /abs/pic.png");
	});
	it("shows the glob target", () => {
		const component = renderShowCall({ glob: "screenshots/*.png" });
		expect(rendered(component)).toBe("Show Image screenshots/*.png");
	});
});
