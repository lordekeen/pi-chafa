/**
 * Abort-shaped error helper (AGENTS.md invariant 4; DESIGN.md §4 chose
 * AbortError propagation). Lives in its own module because `src/images.ts`
 * may not import from `src/show-image.ts` (dependency cycle), and the glob
 * walk must throw abort errors of the same shape the tool classifies.
 */
export function abortError(signal: AbortSignal | undefined): Error {
	const reason = signal?.reason;
	if (reason instanceof Error) return reason;
	const err = new Error("show_image was aborted") as Error & { code?: string };
	err.name = "AbortError";
	err.code = "ABORT_ERR";
	return err;
}
