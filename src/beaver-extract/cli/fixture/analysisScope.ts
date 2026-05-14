/**
 * `AnalysisScope` <-> internal `analysisWindow` translation.
 *
 * `Number.POSITIVE_INFINITY` is not safe to round-trip through JSON
 * (`JSON.stringify(Infinity) === "null"`), so the fixture file stores the
 * scope as a tagged value:
 *
 *   - `"document"`        — analyze the whole document. Translates to
 *                            `analysisWindow: Infinity` for `extractPdf`.
 *   - `{ window: <int> }` — finite window, must be a non-negative integer.
 *
 * The CLI accepts the same two flag forms (`--analysis-scope document` or
 * `--analysis-window <n>`); both are normalized through this module.
 */

export type AnalysisScope = "document" | { window: number };

/** Default scope when the user provides neither flag. */
export const DEFAULT_ANALYSIS_SCOPE: AnalysisScope = "document";

/**
 * Convert a stored `AnalysisScope` to the value `extractPdf({ analysisWindow })`
 * expects. `"document"` becomes `Number.POSITIVE_INFINITY`; finite windows
 * pass through unchanged.
 */
export function resolveAnalysisWindow(scope: AnalysisScope): number {
    if (scope === "document") return Number.POSITIVE_INFINITY;
    if (typeof scope === "object" && scope && typeof scope.window === "number") {
        if (!Number.isInteger(scope.window) || scope.window < 0) {
            throw new Error(
                `analysisScope.window must be a non-negative integer, got ${scope.window}`,
            );
        }
        return scope.window;
    }
    throw new Error(
        `analysisScope is invalid: expected "document" or { window: number }, got ${JSON.stringify(scope)}`,
    );
}

/**
 * Validate an unknown value as `AnalysisScope`. Throws with a targeted
 * message identifying the offending shape so fixture-loader errors can
 * point a user at the field name.
 */
export function parseAnalysisScope(value: unknown): AnalysisScope {
    if (value === "document") return "document";
    if (
        value &&
        typeof value === "object" &&
        Object.keys(value).length === 1 &&
        Object.prototype.hasOwnProperty.call(value, "window")
    ) {
        const w = (value as { window: unknown }).window;
        if (!Number.isInteger(w) || (w as number) < 0) {
            throw new Error(
                `analysisScope.window must be a non-negative integer (got ${JSON.stringify(w)})`,
            );
        }
        return { window: w as number };
    }
    throw new Error(
        `analysisScope must be "document" or { window: <int> } (got ${JSON.stringify(value)})`,
    );
}

/**
 * Build an `AnalysisScope` from CLI flags. Caller is responsible for the
 * conflict check (both flags supplied).
 */
export function scopeFromCliFlags(args: {
    analysisScopeFlag?: string;
    analysisWindowFlag?: number;
}): AnalysisScope {
    if (args.analysisScopeFlag != null && args.analysisWindowFlag != null) {
        throw new Error(
            "--analysis-scope and --analysis-window are mutually exclusive",
        );
    }
    if (args.analysisScopeFlag != null) {
        if (args.analysisScopeFlag !== "document") {
            throw new Error(
                `--analysis-scope: only "document" is supported (got "${args.analysisScopeFlag}")`,
            );
        }
        return "document";
    }
    if (args.analysisWindowFlag != null) {
        return { window: args.analysisWindowFlag };
    }
    return DEFAULT_ANALYSIS_SCOPE;
}
