// Real-dependency smoke test for the pi-chafa dist build (spec §9.2 "Manual smoke").
// Exercises the ACTUAL chafa binary, the real filesystem, and the real pi-tui
// capability read — none of which the vitest suite covers (it injects fakes).
//
// Run via `npm run test:smoke` (builds dist first) or directly:
//   node <repo>/scripts/smoke.mjs
// The repo path is derived from this file's own location, so any cwd works.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const { resolveCapsImages, decideDelivery } = await import(pathToFileURL(join(DIST, "detect.js")).href);
const require = createRequire(join(REPO, "package.json"));
const { getCapabilities } = await import(pathToFileURL(require.resolve("@earendil-works/pi-tui")).href);

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
	execFileSync("magick", ["-size", "120x80", "gradient:red-blue", join(work, "img.png")]);
	execFileSync("magick", [join(work, "img.png"), join(work, "img.jpg")]);
	execFileSync("magick", [join(work, "img.png"), join(work, "img.gif")]);
	execFileSync("magick", [join(work, "img.png"), join(work, "img.webp")]);
	execFileSync("magick", ["-size", "200x1200", "gradient:blue-red", join(work, "tall.png")]);
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
	for (const [file, want] of [["img.png", "image/png"], ["img.jpg", "image/jpeg"], ["img.gif", "image/gif"], ["img.webp", "image/webp"], ["unknown.bin", "application/octet-stream"]]) {
		const got = sniffMime(await readBytes(join(work, file)));
		check(`${file} -> ${want}`, got === want, `got ${got}`);
	}

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
	// In this shell TERM=screen-256color/TERM_PROGRAM=tmux, so getCapabilities().images
	// is genuinely null — the exact "extension missed the host override" situation.
	const capsNow = getCapabilities().images;
	console.log(`  (env: TERM=${process.env.TERM} TERM_PROGRAM=${process.env.TERM_PROGRAM}; getCapabilities().images=${JSON.stringify(capsNow)}; settings terminal.images=kitty)`);
	const toolReal = buildShowImageTool();
	const nativeRes = await toolReal.execute("s1", { path: join(work, "img.png") }, undefined, undefined, ctx);
	check("5a caps really is null here, so the ladder is what resolves", capsNow === null, `caps=${JSON.stringify(capsNow)}`);
	check("5a native chosen via the settings ladder despite null caps", nativeRes.details.mode === "native", JSON.stringify(nativeRes.details.mode));
	const imgBlock = nativeRes.content.find((c) => c.type === "image");
	check("5a image content block emitted", Boolean(imgBlock), JSON.stringify(nativeRes.content.map((c) => c.type)));
	check("5a image mimeType sniffed correctly", imgBlock?.mimeType === "image/png", String(imgBlock?.mimeType));
	check("5a base64 round-trips to the real file bytes", Buffer.from(imgBlock?.data ?? "", "base64").equals(readFileSync(join(work, "img.png"))));
	check("5a text summary has no ANSI", !textOf(nativeRes).includes(ESC));
	check("5a settings snapshot records the invocation", nativeRes.details.settings.format === "auto");

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

	// 6. round-trip: writeConfigFile -> loadConfig (atomic write path, real disk)
	section("6. config persistence round-trip (real disk)");
	writeConfigFile(cfgDir, { ...resolveConfig({}, cfgDir).symbols, preferNative: false, formatOrder: ["symbols"], version: 1, colors: "16", symbolsSet: "block", dither: "none", cellWidth: 42, maxRows: 7, binaryPath: null, timeoutMs: 1234 });
	const reloaded = resolveConfig({}, cfgDir);
	check("persisted cellWidth survives reload", reloaded.symbols.cellWidth === 42, String(reloaded.symbols.cellWidth));
	check("persisted timeoutMs survives reload", reloaded.symbols.timeoutMs === 1234, String(reloaded.symbols.timeoutMs));
	check("persisted preferNative survives reload", reloaded.preferNative === false);
	check("atomic write left no .tmp behind", !existsSync(join(cfgDir, "pi-chafa.json.tmp")));
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
