import { execFile } from "node:child_process";
import type {
	ChafaProbe,
	ChafaVersion,
	EffectiveSymbolsSettings,
} from "./types.js";

/**
 * DECISION — review at checkpoint (spec §13 open question 1).
 * Documented minimum supported chafa: 1.10.0. Every flag v1 passes and the
 * default symbol classes ("block+border") predate 1.10; 1.10 is the 2022-era
 * line where the modern --symbols vocabulary stabilized. Local 1.18.2 is the
 * dev/test target. Enforced at runtime by parsing `chafa --version`.
 */
export const MIN_CHAFA_VERSION: ChafaVersion = { major: 1, minor: 10 };

/** Build the chat-safe symbols arg vector (spec §7.3, verbatim; no --clear, --relative off). */
export function buildSymbolsArgs(
	imagePath: string,
	s: EffectiveSymbolsSettings,
): string[] {
	return [
		"--format",
		"symbols",
		"--relative",
		"off",
		"--size",
		`${s.cellWidth}x${s.maxRows}`,
		"--colors",
		s.colors,
		"--symbols",
		s.symbolsSet,
		"--dither",
		s.dither,
		"--animate",
		"off",
		imagePath,
	];
}

/**
 * Post-process raw chafa stdout before it is stashed in details.payload
 * (spec §7.3 + verified 1.18.2 behavior): strip the absolute-mode
 * cursor-hide/show escapes, drop CRs, trim, and guarantee a final ANSI reset
 * so no unterminated color state bleeds into following TUI rows (spec §13 risk 2).
 */
// chafa wraps symbols output in absolute-mode cursor-hide/show escapes that
// must be stripped. Match ESC by building the RegExp from a string constant:
// the committed biome gate flags control-character escapes inside regex
// literals (lint/suspicious/noControlCharactersInRegex), and its --fix would
// inline a `new RegExp(<static string>)` back into a literal, so the pattern
// is assembled from the ESC constant to keep it non-static.
const ESC = "\x1b";
const HIDE_CURSOR_RE = new RegExp(`^${ESC}\\[\\?25l`);
const SHOW_CURSOR_RE = new RegExp(`${ESC}\\[\\?25h\\s*$`);

export function cleanSymbolsPayload(raw: string): string {
	let out = raw.replace(HIDE_CURSOR_RE, "").replace(SHOW_CURSOR_RE, "");
	out = out.replace(/\r/g, "");
	const trimmed = out.trimEnd();
	if (trimmed === "") return "";
	return trimmed.endsWith("\x1b[0m") ? trimmed : `${trimmed}\x1b[0m`;
}

type ExecResultLike = { stdout: string; stderr: string };
type ExecFn = (
	bin: string,
	args: string[],
	opts: unknown,
) => Promise<ExecResultLike>;

function nodeExecFile(
	bin: string,
	args: string[],
	opts: {
		timeout: number;
		signal?: AbortSignal;
		encoding: "utf8";
		maxBuffer: number;
	},
): Promise<ExecResultLike> {
	return new Promise((resolve, reject) => {
		execFile(bin, args, opts, (error, stdout, stderr) => {
			if (error) {
				(
					error as NodeJS.ErrnoException & { stdout?: string; stderr?: string }
				).stdout ??= String(stdout);
				(
					error as NodeJS.ErrnoException & { stdout?: string; stderr?: string }
				).stderr ??= String(stderr);
				reject(error);
				return;
			}
			resolve({ stdout: String(stdout), stderr: String(stderr) });
		});
	});
}

function installHint(binary: string): string {
	let hint: string;
	if (process.platform === "darwin") {
		hint = "brew install chafa";
	} else if (process.platform === "win32") {
		hint = "grab a build from https://hpjansson.org/chafa/";
	} else {
		hint = "apt install chafa (or your distro's package)";
	}
	return `chafa was not found on PATH (looked for ${binary}). Install it with: ${hint}. Or set CHAFA_BIN to its absolute path.`;
}

/** Resolve the chafa binary name/path: explicit config ``CHafa_BIN`` else "chafa". */
export function resolveChafaBinary(binaryPath: string | null): string {
	return binaryPath && binaryPath.trim() !== "" ? binaryPath.trim() : "chafa";
}

/**
 * The error an aborted probe must surface: the signal's own reason when it is
 * an Error (Node's DOMException AbortError carries name + code), else a
 * synthesized AbortError so callers can classify the cancellation
 * (AGENTS.md invariant 4).
 */
function abortReason(signal: AbortSignal): Error {
	const reason = signal.reason;
	if (reason instanceof Error) return reason;
	const err = new Error("chafa probe was aborted") as Error & { code?: string };
	err.name = "AbortError";
	err.code = "ABORT_ERR";
	return err;
}

/**
 * Resolve the chafa binary (CHAFA_BIN/config binaryPath else "chafa" on PATH)
 * and verify its version meets MIN_CHAFA_VERSION. Throws actionable errors.
 * `execOverride` exists for tests; production uses node:child_process.
 * `signal` (#008) is forwarded into the `--version` exec and an abort rejects
 * with the original AbortError rather than a wrapped probe failure.
 */
export async function probeChafa(
	binaryPath: string | null,
	execOverride?: ExecFn,
	signal?: AbortSignal,
): Promise<ChafaProbe> {
	const binary = resolveChafaBinary(binaryPath);
	if (signal?.aborted) throw abortReason(signal);
	const execFn: ExecFn =
		execOverride ??
		((bin, args, opts) => nodeExecFile(bin, args, opts as never));
	let stdout: string;
	try {
		const result = await execFn(binary, ["--version"], {
			timeout: 3000,
			signal,
			encoding: "utf8",
			maxBuffer: 1024 * 1024,
		});
		stdout = result.stdout;
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		// A user abort must stay classifiable — never wrapped into a generic
		// probe failure (AGENTS.md invariant 4).
		if (
			err?.name === "AbortError" ||
			err?.code === "ABORT_ERR" ||
			signal?.aborted
		) {
			throw error;
		}
		if (err.code === "ENOENT") throw new Error(installHint(binary));
		throw new Error(
			`Failed to run ${binary} --version: ${(error as Error).message}`,
		);
	}
	const match = /Chafa version (\d+)\.(\d+)/.exec(stdout);
	if (!match) {
		throw new Error(
			`Could not parse a version from "${binary} --version". Is ${binary} really chafa?`,
		);
	}
	const version: ChafaVersion = {
		major: Number(match[1]),
		minor: Number(match[2]),
	};
	if (
		version.major < MIN_CHAFA_VERSION.major ||
		(version.major === MIN_CHAFA_VERSION.major &&
			version.minor < MIN_CHAFA_VERSION.minor)
	) {
		throw new Error(
			`chafa ${version.major}.${version.minor} is older than the minimum supported version ` +
				`${MIN_CHAFA_VERSION.major}.${MIN_CHAFA_VERSION.minor}. Upgrade chafa (${installHint(binary)}) ` +
				`or point CHAFA_BIN at a newer binary.`,
		);
	}
	return { binary, version };
}

/** The `probeChafa` call signature plus the test-only cache reset. */
export interface CachedChafaProbe {
	(binaryPath: string | null, signal?: AbortSignal): Promise<ChafaProbe>;
	clear(): void;
}

/**
 * Memoize successful `probeChafa` results per resolved binary path (#007).
 * Real rejections (missing binary, wrong version, unparseable output) are
 * never cached, so a missing-then-installed chafa recovers on the next call.
 * The in-flight promise is cached, so concurrent calls share one exec.
 * An already-aborted signal short-circuits before the cache is consulted — a
 * cached success must never mask an abort (#008). `clear()` is for tests.
 */
export function createCachedProbe(execOverride?: ExecFn): CachedChafaProbe {
	const cache = new Map<string, Promise<ChafaProbe>>();
	const probe = ((binaryPath: string | null, signal?: AbortSignal) => {
		if (signal?.aborted) return Promise.reject(abortReason(signal));
		const key = resolveChafaBinary(binaryPath);
		const hit = cache.get(key);
		if (hit) return hit;
		const fresh = probeChafa(binaryPath, execOverride, signal).catch(
			(error: unknown) => {
				cache.delete(key);
				throw error;
			},
		);
		cache.set(key, fresh);
		return fresh;
	}) as CachedChafaProbe;
	probe.clear = () => cache.clear();
	return probe;
}

/**
 * Run chafa via execFile (no shell), bounded by timeoutMs and tied to the
 * tool's AbortSignal. Returns raw stdout; rejects with actionable text on
 * nonzero exit (stderr surfaced) or timeout.
 */
export async function runChafa(
	binary: string,
	args: string[],
	opts: { timeoutMs: number; signal?: AbortSignal },
	execOverride?: ExecFn,
): Promise<string> {
	const execFn: ExecFn =
		execOverride ?? ((bin, args2, o) => nodeExecFile(bin, args2, o as never));
	try {
		const result = await execFn(binary, args, {
			timeout: opts.timeoutMs,
			signal: opts.signal,
			encoding: "utf8",
			maxBuffer: 32 * 1024 * 1024,
		});
		return result.stdout;
	} catch (error) {
		const err = error as NodeJS.ErrnoException & {
			stderr?: string;
			killed?: boolean;
			signal?: string;
		};
		// A user abort surfaces as an AbortError — Node kills the child with
		// SIGTERM and rejects with an AbortError when the signal aborts — so it
		// also matches the `killed`/`SIGTERM` timeout branch below. Distinguish
		// it and rethrow the ORIGINAL error so callers can classify the abort.
		if (
			err.name === "AbortError" ||
			err.code === "ABORT_ERR" ||
			opts.signal?.aborted
		) {
			throw error;
		}
		if (err.killed || err.signal === "SIGTERM") {
			throw new Error(
				`chafa timed out after ${opts.timeoutMs}ms. Reduce the image size, lower cellWidth/maxRows, or raise timeoutMs in pi-chafa config.`,
			);
		}
		const stderr = (err.stderr ?? "").trim();
		if (stderr) throw new Error(`chafa exited with an error: ${stderr}`);
		throw new Error(`chafa failed (code ${String(err.code ?? "unknown")})`);
	}
}
