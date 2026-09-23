import { describe, expect, it } from "vitest";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
	buildShowImageTool,
	renderShowCall,
	renderShowResult,
	type RenderStateLike,
	type RenderThemeLike,
} from "../src/show-image.js";
import type { ShowImageDetails } from "../src/types.js";

const PAYLOAD = "  \x1b[38;5;1m█\x1b[0m\n \x1b[38;5;2m█\x1b[0m";

/** Identity theme: keeps content assertions readable. */
const PLAIN_THEME: RenderThemeLike = { bg: (_color, text) => text };

/** Recording theme: tags every themed run with the color name it received. */
const TAGGING_THEME: RenderThemeLike = {
	bg: (color, text) => `<${color}>${text}</${color}>`,
};

const SETTLED: RenderStateLike = { isPartial: false, isError: false };
const PENDING: RenderStateLike = { isPartial: true, isError: false };
const ERROR: RenderStateLike = { isPartial: false, isError: true };

/**
 * Component.render(width) pads every line to `width` columns with trailing
 * spaces (pi-tui text.js). Assertions target the content, so trim the padding
 * and drop the plain blank padding rows before joining. A themed blank row is
 * not plain whitespace, so it survives under a tagging theme — assertions there
 * use `toContain` rather than exact equality.
 */
function rendered(component: Component, width = 120): string {
	const lines = component.render(width).map((line) => line.trimEnd());
	while (lines.length > 0 && lines[0] === "") lines.shift();
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines.join("\n");
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

function resultWith(partial: {
	text?: string;
	details?: ShowImageDetails;
}): AgentToolResult<ShowImageDetails> {
	return {
		content: [
			{
				type: "text",
				text: partial.text ?? "Showed image pic.png to the user as ANSI art.",
			},
		],
		details: partial.details ?? details({}),
	};
}

describe("renderResult — themed strip + art on the terminal background (spec §4.1.3)", () => {
	it("symbols mode returns the summary caption above the verbatim ANSI payload", () => {
		const component = renderShowResult(
			resultWith({ details: details({ payload: PAYLOAD }) }),
			PLAIN_THEME,
			SETTLED,
		);
		const joined = rendered(component);
		expect(joined).toContain("Showed image pic.png to the user as ANSI art.");
		// The art lines carry the row's 1-cell indent (Text paddingX=1) on top of
		// chafa's own leading margins, so assert the fragments, not the raw payload.
		expect(joined).toContain("\x1b[38;5;1m█\x1b[0m");
		expect(joined).toContain("\x1b[38;5;2m█\x1b[0m");
	});

	it("preserves ANSI escape sequences verbatim (never stripped)", () => {
		const component = renderShowResult(
			resultWith({ details: details({ payload: PAYLOAD }) }),
			PLAIN_THEME,
			SETTLED,
		);
		expect(rendered(component)).toContain("\x1b[38;5;1m");
	});

	it("#027: the art carries no row background, so transparent pixels stay on the terminal background", () => {
		const joined = rendered(
			renderShowResult(
				resultWith({ details: details({ payload: PAYLOAD }) }),
				TAGGING_THEME,
				SETTLED,
			),
		);
		// The caption strip is themed…
		expect(joined).toContain(
			"<toolSuccessBg> Showed image pic.png to the user as ANSI art.",
		);
		// …but every art line is free of the row background.
		const artLines = joined
			.split("\n")
			.filter((line) => line.includes("\x1b[38;5;"));
		expect(artLines.length).toBe(2);
		for (const line of artLines) {
			expect(line).not.toContain("<toolSuccessBg>");
		}
	});

	it("follows the row state: pending uses toolPendingBg", () => {
		const joined = rendered(
			renderShowResult(
				resultWith({ details: details({ payload: PAYLOAD }) }),
				TAGGING_THEME,
				PENDING,
			),
		);
		expect(joined).toContain("<toolPendingBg>");
		expect(joined).not.toContain("<toolSuccessBg>");
	});

	it("error results render the error text through the error background", () => {
		const errorResult = {
			content: [{ type: "text", text: "no files matched **/*.svg" }],
			details: {},
		};
		const joined = rendered(
			renderShowResult(
				errorResult as AgentToolResult<ShowImageDetails>,
				TAGGING_THEME,
				ERROR,
			),
		);
		expect(joined).toContain("<toolErrorBg> no files matched **/*.svg");
		expect(joined).not.toContain("<toolSuccessBg>");
	});

	it("no payload (native caption or partial) renders just the summary text", () => {
		const native = resultWith({
			text: "Showed image pic.png to the user via terminal-native rendering.",
			details: details({ mode: "native", payload: undefined }),
		});
		expect(rendered(renderShowResult(native, PLAIN_THEME, SETTLED))).toBe(
			" Showed image pic.png to the user via terminal-native rendering.",
		);
	});
});

describe("renderCall (spec §4.1 registration table: compact 'Show Image <target>')", () => {
	it("shows the path target", () => {
		const component = renderShowCall({ path: "/abs/pic.png" }, PLAIN_THEME, SETTLED);
		expect(rendered(component)).toBe(" Show Image /abs/pic.png");
	});
	it("shows the glob target", () => {
		const component = renderShowCall(
			{ glob: "screenshots/*.png" },
			PLAIN_THEME,
			SETTLED,
		);
		expect(rendered(component)).toBe(" Show Image screenshots/*.png");
	});
	it("strips control characters from a path target", () => {
		const component = renderShowCall(
			{ path: "/tmp/pic\u001b[31m.png" },
			PLAIN_THEME,
			SETTLED,
		);
		expect(rendered(component)).toBe(" Show Image /tmp/pic.png");
	});
	it("paints the themed header strip", () => {
		const component = renderShowCall(
			{ path: "/abs/pic.png" },
			TAGGING_THEME,
			SETTLED,
		);
		expect(rendered(component)).toContain(
			"<toolSuccessBg> Show Image /abs/pic.png",
		);
	});
});

describe("tool registration (spec §4.1)", () => {
	it('uses renderShell "self" so symbols art renders outside the themed row box (#027)', () => {
		expect(buildShowImageTool().renderShell).toBe("self");
	});
});
