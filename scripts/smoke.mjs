// Real-dependency smoke test for the pi-chafa dist build (spec §9.2 "Manual smoke").
// Exercises the ACTUAL chafa binary, the real filesystem, and the real pi-tui
// capability read — none of which the vitest suite covers (it injects fakes).
//
// Run via `npm run test:smoke` (builds dist first) or directly:
//   node <repo>/scripts/smoke.mjs
// The repo path is derived from this file's own location, so any cwd works.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = join(REPO, "dist");

// ------------------------------------------------------------------ tool guard
const onPath = (bin) => {
	const dirs = (process.env.PATH ?? "").split(platform() === "win32" ? ";" : ":");
	const exts = platform() === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];
	for (const dir of dirs) {
		if (!dir) continue;
		for (const ext of exts) {
			if (existsSync(join(dir, bin + ext))) return true;
		}
	}
	return false;
};

const missingTools = ["chafa", "magick"].filter((bin) => !onPath(bin));
if (missingTools.length > 0) {
	console.log("SKIPPED: requires chafa and ImageMagick");
	console.log(`  missing from PATH: ${missingTools.join(", ")}`);
	process.exit(0);
}

const { buildShowImageTool } = await import(pathToFileURL(join(DIST, "show-image.js")).href);
const { probeChafa, buildSymbolsArgs, cleanSymbolsPayload, runChafa } = await import(pathToFileURL(join(DIST, "chafa.js")).href);
const { expandTargets, sniffMime, readBytes } = await import(pathToFileURL(join(DIST, "images.js")).href);
const { readHostImageSettings, resolveConfig, writeConfigFile } = await import(pathToFileURL(join(DIST, "config.js")).href);
const { resolveCapsImages, decideDelivery, isTmux, knownNoImageSupport } = await import(pathToFileURL(join(DIST, "detect.js")).href);
const require = createRequire(join(REPO, "package.json"));
const { getCapabilities, setCapabilities } = await import(pathToFileURL(require.resolve("@earendil-works/pi-tui")).href);

const ESC = "\x1b";
let pass = 0;
const failures = [];
const check = (name, cond, detail = "") => {
	if (cond) {
		pass++;
		console.log(`  PASS  ${name}`);
	} else {
		failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
		console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
};
const section = (t) => console.log(`\n=== ${t} ===`);

// ------------------------------------------------------------- env restoration
const ENV_KEYS = ["HOME", "CHAFA_CONFIG_DIR", "CHAFA_CELL_WIDTH", "CHAFA_TIMEOUT_MS", "PI_IMAGE_PROTOCOL", "PATH"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const restoreEnv = () => {
	for (const [k, v] of Object.entries(savedEnv)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
};

async function main(work) {
	const cfgDir = join(work, "cfg");
	mkdirSync(cfgDir, { recursive: true });

	// ------------------------------------------------------------------ fixtures
	// Optional fixtures are best-effort: a magick build without an AVIF/ICO
	// delegate must skip those checks, not fail the whole run.
	const fixtures = { png: true, jpg: true, gif: true, webp: true, svg: true, bmp: true, ico: true, avif: true };
	const magickFixture = (label, args) => {
		try {
			execFileSync("magick", args);
		} catch {
			fixtures[label] = false;
			console.log(`  (fixture skipped: magick could not write ${label})`);
		}
	};
	execFileSync("magick", ["-size", "120x80", "gradient:red-blue", join(work, "img.png")]);
	execFileSync("magick", [join(work, "img.png"), join(work, "img.jpg")]);
	execFileSync("magick", [join(work, "img.png"), join(work, "img.gif")]);
	execFileSync("magick", [join(work, "img.png"), join(work, "img.webp")]);
	execFileSync("magick", ["-size", "200x1200", "gradient:blue-red", join(work, "tall.png")]);
	// The prolog + generator-comment prefix is deliberate: it is the shape that
	// shipped broken in 0.2.0 (#023) and the one real exporters emit.
	writeFileSync(
		join(work, "img.svg"),
		'<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n<!-- Generator: pi-chafa smoke -->\n<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="#3366cc"/><circle cx="60" cy="40" r="24" fill="#ffcc00"/></svg>',
	);
	magickFixture("bmp", [join(work, "img.png"), join(work, "img.bmp")]);
	magickFixture("ico", [join(work, "img.png"), "-resize", "32x32", join(work, "img.ico")]);
	magickFixture("avif", [join(work, "img.png"), join(work, "img.avif")]);
	writeFileSync(join(work, "unknown.bin"), Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]));
	console.log(`fixtures in ${work}`);

	// --------------------------------------------------------------- 1. chafa
	section("1. real chafa binary");
	const probe = await probeChafa(null);
	check("probeChafa resolves the real binary", probe.binary === "chafa", JSON.stringify(probe));
	check("version parsed and >= minimum", probe.version.major >= 1 && probe.version.minor >= 10, JSON.stringify(probe.version));

	const resolved = resolveConfig({}, cfgDir);
	const args = buildSymbolsArgs(join(work, "img.png"), resolved.symbols);
	check("arg vector has --relative off", args.includes("--relative") && args[args.indexOf("--relative") + 1] === "off");
	check("arg vector has --animate off", args.includes("--animate") && args[args.indexOf("--animate") + 1] === "off");
	check("arg vector has --size cellWidthxmaxRows", args[args.indexOf("--size") + 1] === `${resolved.symbols.cellWidth}x${resolved.symbols.maxRows}`);
	check("INVARIANT: no --clear anywhere in args", !args.some((a) => a.includes("--clear")));
	check("no shell metacharacters / no shell (execFile)", args.every((a) => typeof a === "string"));

	const raw = await runChafa(probe.binary, args, { timeoutMs: 20000 });
	const payload = cleanSymbolsPayload(raw);
	check("real chafa produced output", payload.length > 0, `len=${payload.length}`);
	check("payload carries ANSI colour", payload.includes(ESC), "no ESC found");
	check("payload ends with ANSI reset", payload.endsWith(`${ESC}[0m`));
	check("no CR left in payload", !payload.includes("\r"));
	check("no cursor hide/show escapes", !payload.includes(`${ESC}[?25l`) && !payload.includes(`${ESC}[?25h`));
	check("payload rows <= maxRows", payload.split("\n").length <= resolved.symbols.maxRows, `rows=${payload.split("\n").length}`);

	// ----------------------------------------------------------- 2. mime sniff
	section("2. real files: mime sniffing");
	const mimeCases = [
		["png", "img.png", "image/png"],
		["jpg", "img.jpg", "image/jpeg"],
		["gif", "img.gif", "image/gif"],
		["webp", "img.webp", "image/webp"],
		["svg", "img.svg", "image/svg+xml"],
		["bmp", "img.bmp", "image/bmp"],
		["ico", "img.ico", "image/x-icon"],
		["avif", "img.avif", "image/avif"],
	];
	for (const [label, file, want] of mimeCases) {
		if (!fixtures[label]) continue;
		const got = sniffMime(await readBytes(join(work, file)));
		check(`${file} -> ${want}`, got === want, `got ${got}`);
	}
	check("unknown.bin -> application/octet-stream", sniffMime(await readBytes(join(work, "unknown.bin"))) === "application/octet-stream");
	check(
		"#023: prolog + comment prefix still sniffs as svg",
		sniffMime(await readBytes(join(work, "img.svg"))) === "image/svg+xml",
	);

	// --------------------------------------------------------- 3. path/glob fs
	section("3. real filesystem: expansion");
	const pngs = expandTargets(join(work, "*.png"), work);
	check("glob '*.png' matched both pngs", pngs.length === 2, `got ${pngs.length}`);
	check("glob results are sorted (code-unit)", JSON.stringify(pngs) === JSON.stringify([...pngs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))));
	mkdirSync(join(work, "sub", "node_modules"), { recursive: true });
	mkdirSync(join(work, "sub", ".git"), { recursive: true });
	writeFileSync(join(work, "sub", "node_modules", "nested.png"), readFileSync(join(work, "img.png")));
	writeFileSync(join(work, "sub", ".git", "nested.png"), readFileSync(join(work, "img.png")));
	writeFileSync(join(work, "sub", "deep.png"), readFileSync(join(work, "img.png")));
	const deep = expandTargets(join(work, "**", "*.png"), work);
	check("** finds nested file", deep.some((p) => p.endsWith("sub/deep.png")), JSON.stringify(deep.map((p) => p.replace(work, ""))));
	check("** prunes node_modules", !deep.some((p) => p.includes("node_modules")));
	check("** prunes .git", !deep.some((p) => p.includes("/.git/")));
	const noMatch = (() => { try { expandTargets(join(work, "*.nope"), work); return null; } catch (e) { return e.message; } })();
	check("zero-match glob throws actionable error", noMatch !== null && /no files matched/.test(noMatch), String(noMatch));
	const dirTarget = (() => { try { expandTargets(join(work, "sub"), work); return null; } catch (e) { return e.message; } })();
	check("directory target throws", dirTarget !== null && /is a directory/.test(dirTarget), String(dirTarget));

	// ---------------------------------------------------- 4. capability ladder
	section("4. capability ladder (the Konsole regression)");
	check("caps wins when non-null", resolveCapsImages("kitty", "iterm2", "iterm2") === "kitty");
	check("caps null -> terminal.images", resolveCapsImages(null, "iterm2", undefined) === "iterm2");
	check("terminal.images false -> no override", resolveCapsImages(null, false, undefined) === null);
	check("terminal.images 'auto' -> no override", resolveCapsImages(null, "auto", undefined) === null);
	check("caps+settings null -> PI_IMAGE_PROTOCOL", resolveCapsImages(null, null, "kitty") === "kitty");
	check("all empty -> null", resolveCapsImages(null, null, undefined) === null);
	check("garbage env -> null", resolveCapsImages(null, null, "nonsense") === null);

	// #026: the environment guard precedes every declaration.
	check("#026 alacritty denies a declaration", resolveCapsImages(null, "kitty", undefined, { TERM_PROGRAM: "alacritty" }, "linux") === null);
	check("#026 ALACRITTY_* marker denies a declaration", resolveCapsImages(null, "kitty", undefined, { ALACRITTY_WINDOW_ID: "1" }, "linux") === null);
	check("#026 VS Code denies PI_IMAGE_PROTOCOL too", resolveCapsImages(null, "kitty", "kitty", { TERM_PROGRAM: "vscode" }, "linux") === null);
	check("#026 screen denies a declaration", resolveCapsImages(null, "kitty", "kitty", { TERM: "screen-256color" }, "linux") === null);
	check("#026 win32 denies a declaration", resolveCapsImages(null, "kitty", "kitty", {}, "win32") === null);
	check("#026 tmux denies ambient declarations", resolveCapsImages("kitty", "kitty", undefined, { TMUX: "/tmp/tmux-1000/default,1,0" }, "linux") === null);
	check("#026 tmux honors the PI_IMAGE_PROTOCOL opt-in", resolveCapsImages(null, "kitty", "kitty", { TMUX: "/tmp/tmux-1000/default,1,0" }, "linux") === "kitty");
	check("#026 unknown terminal keeps the declaration", resolveCapsImages(null, "kitty", undefined, { TERM: "xterm-konsole" }, "linux") === "kitty");
	check("#026 wezterm on win32 is not denied", resolveCapsImages(null, "kitty", undefined, { TERM_PROGRAM: "wezterm" }, "win32") === "kitty");
	check("#026 isTmux classifies TMUX and TERM=tmux", isTmux({ TMUX: "1" }) && isTmux({ TERM: "tmux-256color" }) && !isTmux({ TERM: "xterm-256color" }));
	check("#026 knownNoImageSupport leaves unknown terminals alone", !knownNoImageSupport({ TERM: "xterm-256color" }, "linux"));

	// The actual bug: extension misses the host override (caps null), but pi's own
	// settings say kitty. Must resolve to kitty, not null.
	const homeDir = join(work, "home");
	mkdirSync(join(homeDir, ".pi", "agent"), { recursive: true });
	writeFileSync(join(homeDir, ".pi", "agent", "settings.json"), JSON.stringify({ terminal: { showImages: true, imageWidthCells: 60, images: "kitty" } }));
	process.env.HOME = homeDir;
	process.env.CHAFA_CONFIG_DIR = cfgDir;
	delete process.env.PI_IMAGE_PROTOCOL;
	check("readHostImageSettings reads terminal.images", readHostImageSettings().images === "kitty");
	check("REGRESSION: caps null + terminal.images=kitty -> kitty", resolveCapsImages(null, readHostImageSettings().images, process.env.PI_IMAGE_PROTOCOL) === "kitty");
	check("decideDelivery now returns native for that case", decideDelivery({ capsImages: "kitty", showImages: true, preferNative: true, format: "auto" }) === "native");

	// --------------------------------------------------------- 5. execute() e2e
	section("5. execute() end-to-end with REAL deps");
	const ctx = { cwd: work, hasUI: true };
	const textOf = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");

	// 5a. The headline regression, using NO injected deps: the real defaultDeps ladder.
	// The ladder's settings rung (null host caps + pi's terminal.images declaration)
	// only applies where pi's own detection finds no protocol: on an image-capable
	// terminal getCapabilities().images is already "kitty"/"iterm2", so asserting
	// caps === null failed the whole run there — and skipped the rung it names.
	// Force that rung through pi-tui's own test seam and restore the real caps after,
	// so the check holds on every terminal.
	// Inside a guard-denied environment (#026) the same declaration must instead
	// resolve symbols and emit no image block — the guard, not the declaration, wins.
	const capsNow = getCapabilities().images;
	const guardDenies = isTmux(process.env) || knownNoImageSupport(process.env, process.platform);
	console.log(`  (env: TERM=${process.env.TERM} TERM_PROGRAM=${process.env.TERM_PROGRAM} TMUX=${process.env.TMUX ?? ""}; guard=${guardDenies ? "denies" : "allows"}; getCapabilities().images=${JSON.stringify(capsNow)}; settings terminal.images=kitty)`);
	const toolReal = buildShowImageTool();
	let nativeRes;
	if (guardDenies) {
		nativeRes = await toolReal.execute("s1", { path: join(work, "img.png") }, undefined, undefined, ctx);
		check("5a #026 guard wins over the settings declaration -> symbols", nativeRes.details.mode === "symbols", JSON.stringify(nativeRes.details.mode));
		check("5a #026 guard emits no image block", !nativeRes.content.some((c) => c.type === "image"), JSON.stringify(nativeRes.content.map((c) => c.type)));
		check("5a #026 guard still delivers real chafa art", (nativeRes.details.payload ?? "").includes(ESC), `len=${(nativeRes.details.payload ?? "").length}`);
	} else {
		// The #026 regression shape: a host that cannot detect a protocol, with the
		// settings declaration left as the only native source.
		const realCaps = getCapabilities();
		setCapabilities({ ...realCaps, images: null });
		try {
			nativeRes = await toolReal.execute("s1", { path: join(work, "img.png") }, undefined, undefined, ctx);
		} finally {
			setCapabilities(realCaps);
		}
		check("5a native chosen via the settings ladder despite null caps", nativeRes.details.mode === "native", JSON.stringify(nativeRes.details.mode));
		const imgBlock = nativeRes.content.find((c) => c.type === "image");
		check("5a image content block emitted", Boolean(imgBlock), JSON.stringify(nativeRes.content.map((c) => c.type)));
		check("5a image mimeType sniffed correctly", imgBlock?.mimeType === "image/png", String(imgBlock?.mimeType));
		check("5a base64 round-trips to the real file bytes", Buffer.from(imgBlock?.data ?? "", "base64").equals(readFileSync(join(work, "img.png"))));
		check("5a text summary has no ANSI", !textOf(nativeRes).includes(ESC));
		check("5a settings snapshot records the invocation", nativeRes.details.settings.format === "auto");
	}

	// Seam observation (documented, not a defect): an injected capsImages replaces the
	// ladder wholesale, so unit tests that inject it cannot exercise the ladder via
	// execute() — only directly via resolveCapsImages().
	const seamRes = await buildShowImageTool({ capsImages: () => null }).execute("s1b", { path: join(work, "img.png") }, undefined, undefined, ctx);
	check("5a (seam) injected capsImages bypasses the ladder — expected seam contract", seamRes.details.mode === "symbols", JSON.stringify(seamRes.details.mode));

	// 5b. Real chafa through execute (auto, no native caps), real payload cleaning.
	const toolSymbols = buildShowImageTool({ capsImages: () => null });
	const symRes = await toolSymbols.execute("s2", { path: join(work, "img.png") }, undefined, undefined, ctx);
	check("5b symbols mode", symRes.details.mode === "symbols");
	check("5b real payload stashed in details", (symRes.details.payload ?? "").includes(ESC), `len=${(symRes.details.payload ?? "").length}`);
	check("5b INVARIANT: ANSI never in model-visible text", !textOf(symRes).includes(ESC));
	check("5b payload ends with reset", (symRes.details.payload ?? "").endsWith(`${ESC}[0m`));
	check("5b summary is the plain caption", /^Showed image img\.png to the user as ANSI art\./.test(textOf(symRes)), textOf(symRes));

	// 5c. Forced native on a capable host with images off -> degrade + note.
	const toolOff = buildShowImageTool({ capsImages: () => "kitty", readHostImages: () => ({ showImages: false, imageWidthCells: 60, images: "kitty" }) });
	const degRes = await toolOff.execute("s3", { path: join(work, "img.png"), format: "native" }, undefined, undefined, ctx);
	check("5c degraded to symbols, no throw", degRes.details.mode === "symbols", JSON.stringify(degRes.details.mode));
	check("5c degradation note present in model-visible text", /format=native was requested but the host has images off/.test(textOf(degRes)), textOf(degRes));
	check("5c no image block emitted", !degRes.content.some((c) => c.type === "image"));

	// 5d. Forced native where the terminal is genuinely not capable -> still errors.
	let threw = null;
	try { await toolSymbols.execute("s4", { path: join(work, "img.png"), format: "native" }, undefined, undefined, ctx); } catch (e) { threw = e.message; }
	check("5d forced native on non-capable terminal throws", threw !== null && /cannot render native images/.test(threw), String(threw));

	// 5e. maxRows cap note against real chafa output.
	const tallRes = await toolSymbols.execute("s5", { path: join(work, "tall.png"), cellWidth: 40 }, undefined, undefined, ctx);
	const tallNote = tallRes.details.files[0]?.note ?? "";
	check("5e tall real image: cap note recorded", /output capped at maxRows=\d+ rows/.test(tallNote), `note=${JSON.stringify(tallNote)}`);
	check("5e note surfaced in summary text", /Note:/.test(textOf(tallRes)), textOf(tallRes));

	// 5f. Real timeout drill.
	process.env.CHAFA_TIMEOUT_MS = "1";
	let timeoutMsg = null;
	try { await buildShowImageTool({ capsImages: () => null }).execute("s6", { path: join(work, "tall.png") }, undefined, undefined, ctx); } catch (e) { timeoutMsg = e.message; }
	const timeoutAll = timeoutMsg ?? "";
	check("5f real chafa timeout reported as a timeout", /timed out after 1ms/.test(timeoutAll), timeoutAll.slice(0, 200));
	check("5f timeout not misreported as an abort", !/abort/i.test(timeoutAll), timeoutAll.slice(0, 120));
	delete process.env.CHAFA_TIMEOUT_MS;

	// 5g. chafa missing from PATH -> actionable install hint.
	process.env.PATH = "";
	let missingMsg = null;
	try { await buildShowImageTool({ capsImages: () => null }).execute("s7", { path: join(work, "img.png") }, undefined, undefined, ctx); } catch (e) { missingMsg = e.message; }
	process.env.PATH = savedEnv.PATH;
	check("5g missing chafa gives an install hint", /chafa was not found on PATH/.test(missingMsg ?? "") && /install chafa/.test(missingMsg ?? ""), String(missingMsg).slice(0, 160));

	// 5h. No-UI degrade: text only.
	const headless = await buildShowImageTool({ capsImages: () => "kitty" }).execute("s8", { path: join(work, "img.png") }, undefined, undefined, { cwd: work, hasUI: false });
	check("5h no-UI returns text only", headless.content.length === 1 && headless.content[0].type === "text");
	check("5h no-UI text has no ANSI", !textOf(headless).includes(ESC));
	check("5h no-UI has no payload in details", headless.details.payload === undefined);
	check("5h no-UI summary names the unavailability", /image display unavailable in this session/.test(textOf(headless)), textOf(headless));

	// 5i. Unrenderable file on the native path -> per-file failure, never an image
	// block (spec §7.4, §8). pi persists an image block in session history, so a
	// host-unrenderable one would be rejected by providers on every later turn.
	let unknownMsg = null;
	try { await buildShowImageTool({ capsImages: () => "kitty" }).execute("s9", { path: join(work, "unknown.bin") }, undefined, undefined, ctx); } catch (e) { unknownMsg = e.message; }
	check("5i unknown bytes on native path throw", /not a recognized image format/.test(unknownMsg ?? ""), String(unknownMsg).slice(0, 200));
	check("5i error names the sniffed mime", /application\/octet-stream/.test(unknownMsg ?? ""), String(unknownMsg).slice(0, 200));
	check("5i error suggests format=symbols", /format="symbols"/.test(unknownMsg ?? ""), String(unknownMsg).slice(0, 200));

	// 5j. Mime-aware delivery (#014/#015): the native-safe mime rule. Only
	// png/jpeg/gif/webp may travel as image blocks; everything else degrades to
	// Chafa symbols (auto) or is refused per-file (forced native, missing loader).
	section("5j. mime-aware delivery (#014/#015)");
	const SAFE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
	const nativeTool = buildShowImageTool({ capsImages: () => "kitty" });
	check("5j real loaders parsed", probe.loaders === null || Array.isArray(probe.loaders), JSON.stringify(probe.loaders));
	check("5j loaders normalized upper-case", probe.loaders === null || probe.loaders.every((l) => l === l.toUpperCase()), JSON.stringify(probe.loaders));
	for (const [label, file] of [["png", "img.png"], ["jpg", "img.jpg"], ["gif", "img.gif"], ["webp", "img.webp"]]) {
		if (!fixtures[label]) continue;
		const r = await nativeTool.execute(`j-${label}`, { path: join(work, file) }, undefined, undefined, ctx);
		const block = r.content.find((c) => c.type === "image");
		check(`5j native block for ${file}`, Boolean(block) && SAFE_MIMES.has(block.mimeType), `mime=${block?.mimeType}`);
	}
	for (const [label, file, loader] of [["svg", "img.svg", "SVG"], ["bmp", "img.bmp", "BMP"], ["ico", "img.ico", "ICO"], ["avif", "img.avif", "AVIF"]]) {
		if (!fixtures[label]) continue;
		const loaderMissing = probe.loaders !== null && !probe.loaders.includes(loader);
		let autoRes = null;
		let autoErr = null;
		try {
			autoRes = await nativeTool.execute(`j-${label}-auto`, { path: join(work, file) }, undefined, undefined, ctx);
		} catch (e) {
			autoErr = e.message;
		}
		const nonSafeBlock = autoRes?.content.find((c) => c.type === "image" && !SAFE_MIMES.has(c.mimeType));
		check(`5j INVARIANT: no non-safe native block for ${file}`, !nonSafeBlock, JSON.stringify(nonSafeBlock?.mimeType));
		if (loaderMissing) {
			check(
				`5j ${file} auto: per-file error naming the missing ${loader} loader`,
				new RegExp(loader).test(autoErr ?? "") && /loader/.test(autoErr ?? ""),
				String(autoErr).slice(0, 200),
			);
		} else {
			const shown = autoRes?.details.files?.[0];
			check(
				`5j ${file} auto: symbols art with a degrade note`,
				shown?.ok === true &&
					shown.mode === "symbols" &&
					/shows?ing .* as ANSI art/.test(shown.note ?? "") &&
					(autoRes?.details.payload ?? "").includes(ESC),
				`${JSON.stringify(shown ?? autoErr)}`,
			);
		}
		let refuseMsg = null;
		try {
			await nativeTool.execute(`j-${label}-forced`, { path: join(work, file), format: "native" }, undefined, undefined, ctx);
		} catch (e) {
			refuseMsg = e.message;
		}
		check(`5j ${file} format=native refuses rather than degrades`, /cannot be delivered as a native image block/.test(refuseMsg ?? ""), String(refuseMsg).slice(0, 200));
	}

	// 6. round-trip: writeConfigFile -> loadConfig (atomic write path, real disk)
	section("6. config persistence round-trip (real disk)");
	writeConfigFile(cfgDir, { ...resolveConfig({}, cfgDir).symbols, preferNative: false, formatOrder: ["symbols"], version: 1, colors: "16", symbolsSet: "block", dither: "none", cellWidth: 42, maxRows: 7, binaryPath: null, timeoutMs: 1234 });
	const reloaded = resolveConfig({}, cfgDir);
	check("persisted cellWidth survives reload", reloaded.symbols.cellWidth === 42, String(reloaded.symbols.cellWidth));
	check("persisted timeoutMs survives reload", reloaded.symbols.timeoutMs === 1234, String(reloaded.symbols.timeoutMs));
	check("persisted preferNative survives reload", reloaded.preferNative === false);
	check("atomic write left no .tmp behind", !readdirSync(cfgDir).some((name) => name.endsWith(".tmp")));
	check("per-call override beats config", resolveConfig({ cellWidth: 7 }, cfgDir).symbols.cellWidth === 7);
	check("blank symbolsSet falls back to config", resolveConfig({ symbolsSet: "  " }, cfgDir).symbols.symbolsSet === "block");

	// env beats config
	process.env.CHAFA_CELL_WIDTH = "13";
	check("env beats config file", resolveConfig({}, cfgDir).symbols.cellWidth === 13);
	delete process.env.CHAFA_CELL_WIDTH;
}

// ------------------------------------------------------------------- teardown
let work = null;
try {
	work = mkdtempSync(join(tmpdir(), "pichafa-smoke-"));
	await main(work);
} finally {
	restoreEnv();
	if (work) rmSync(work, { recursive: true, force: true });
}

console.log(`\n${"=".repeat(56)}\nSMOKE RESULT: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
	console.log("\nFAILURES:");
	for (const f of failures) console.log(`  - ${f}`);
	process.exit(1);
}
console.log("all real-dependency smoke checks passed");
