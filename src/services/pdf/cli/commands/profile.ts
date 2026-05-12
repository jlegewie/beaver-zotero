/**
 * `beaver-extract profile <pdf>` — run structured extraction and emit
 * a per-phase timing breakdown.
 *
 * Built on top of `extractPdf` with `mode: "structured"`. Measures the
 * outer `extractPdf` call at the CLI boundary and reads
 * `result.metadata.timings` (the worker-side `ExtractionTimings`) to
 * print:
 *   - top-level cold-start/runtime costs (`totalMs`) plus worker costs
 *     (`workerTotalMs`, `docOpenMs`, `walkMs`, `analysisMs`).
 *   - per-target-page phase ms (when populated, i.e. only structured mode).
 *   - aggregated totals: sum + share + ms-per-1k-chars per phase.
 *
 * `--repeat N` re-runs the same extract N times. The first run pays
 * the cold-start costs (WASM init, doc-cache miss); subsequent runs
 * benefit from the warm doc-cache and a fully-prewarmed splitter. The
 * profile reports BOTH cold and warm averages so the user can tell
 * whether a regression lives in the steady-state hot path or in
 * one-time setup.
 *
 * `--json` emits a machine-readable envelope identical to `extract`'s
 * but with `result` set to the aggregated profile (raw timings included
 * under `result.runs[i].timings`).
 */
import { Command } from "commander";

import type { CliDeps } from "../runCliTypes";
import type { ExtractInput } from "../../node/api";
import type {
    ExtractionResult,
    ExtractionTimings,
    StructuredPagePhaseTimings,
} from "../../types";
import {
    buildErrorEnvelope,
    buildSuccessEnvelope,
    stringifyEnvelope,
} from "../envelope";
import {
    loadJsonFile,
    parseAnalysisWindow,
    parsePageRange,
    parsePagesList,
} from "../options";

interface ProfileRun {
    runIndex: number;
    cold: boolean;
    /** Wall time for the full CLI-side extractPdf call, including runtime init. */
    cliWallMs: number;
    timings: ExtractionTimings | undefined;
    pageCount: number;
}

interface AggregatedPhase {
    name: string;
    totalMs: number;
    perPageMs: number;
    sharePct: number;
    msPer1kChars: number;
}

interface ProfileEnvelopeResult {
    runs: ProfileRun[];
    aggregated: {
        scope: "cold" | "warm-avg" | "all-avg";
        runsInScope: number;
        totalCharCount: number;
        totalPages: number;
        phases: AggregatedPhase[];
        topLevel: {
            docOpenMs: number;
            walkMs: number;
            analysisMs: number;
            totalMs: number;
            workerTotalMs: number;
            runtimeOverheadMs: number;
        };
    };
}

/**
 * Numeric fields on `StructuredPagePhaseTimings` that we want to
 * aggregate. Kept as a tuple of `[label, key]` so the printed phase
 * order matches the pipeline order: detailed walk → font bridge →
 * filter sub-phases → sentence map. Order matters — the printed
 * table is read top-to-bottom by the perf-tracker.
 */
const PHASE_KEYS: ReadonlyArray<[string, keyof StructuredPagePhaseTimings]> = [
    ["detailedWalk", "detailedWalkMs"],
    ["fontBridge", "fontBridgeMs"],
    ["filteredParagraphs", "filteredParagraphsMs"],
    ["  marginFilter", "marginFilterMs"],
    ["  columnDetect", "columnDetectMs"],
    ["  lineDetect", "lineDetectMs"],
    ["  paragraphDetect", "paragraphDetectMs"],
    ["sentenceMap", "sentenceMapMs"],
];

function aggregate(
    runs: ProfileRun[],
    scope: "cold" | "warm-avg" | "all-avg",
): ProfileEnvelopeResult["aggregated"] {
    const inScope = runs.filter((r) =>
        scope === "cold" ? r.cold : scope === "warm-avg" ? !r.cold : true,
    );
    if (inScope.length === 0) {
        return {
            scope,
            runsInScope: 0,
            totalCharCount: 0,
            totalPages: 0,
            phases: PHASE_KEYS.map(([name]) => ({
                name,
                totalMs: 0,
                perPageMs: 0,
                sharePct: 0,
                msPer1kChars: 0,
            })),
            topLevel: {
                docOpenMs: 0,
                walkMs: 0,
                analysisMs: 0,
                totalMs: 0,
                workerTotalMs: 0,
                runtimeOverheadMs: 0,
            },
        };
    }

    let docOpenMs = 0;
    let walkMs = 0;
    let analysisMs = 0;
    let cliWallMs = 0;
    let workerTotalMs = 0;
    let totalPages = 0;
    let totalChars = 0;

    const phaseSums = new Map<keyof StructuredPagePhaseTimings, number>();
    for (const [, key] of PHASE_KEYS) phaseSums.set(key, 0);

    for (const r of inScope) {
        cliWallMs += r.cliWallMs;
        if (!r.timings) continue;
        docOpenMs += r.timings.docOpenMs;
        walkMs += r.timings.walkMs;
        analysisMs += r.timings.analysisMs;
        workerTotalMs += r.timings.totalMs;
        const phases = r.timings.perPagePhases ?? [];
        totalPages += phases.length;
        for (const p of phases) {
            totalChars += p.charCount;
            for (const [, key] of PHASE_KEYS) {
                const v = p[key];
                if (typeof v === "number") {
                    phaseSums.set(key, (phaseSums.get(key) ?? 0) + v);
                }
            }
        }
    }

    const n = inScope.length;
    const avgPages = totalPages / n;
    // Denominator for `share %`. We exclude the nested sub-phases
    // (`marginFilter`/`columnDetect`/`lineDetect`/`paragraphDetect`)
    // since their parent `filteredParagraphs` already accounts for
    // their time — adding them would double-count and push the
    // share total above 100%.
    const topLevelPhases: ReadonlyArray<keyof StructuredPagePhaseTimings> = [
        "detailedWalkMs",
        "fontBridgeMs",
        "filteredParagraphsMs",
        "sentenceMapMs",
    ];
    const denomMs = topLevelPhases.reduce(
        (sum, key) => sum + (phaseSums.get(key) ?? 0),
        0,
    );

    const phases: AggregatedPhase[] = PHASE_KEYS.map(([name, key]) => {
        const sum = phaseSums.get(key) ?? 0;
        const isNested = name.startsWith("  ");
        return {
            name,
            totalMs: sum / n,
            perPageMs: avgPages > 0 ? sum / n / avgPages : 0,
            sharePct: !isNested && denomMs > 0 ? (sum / denomMs) * 100 : 0,
            msPer1kChars: totalChars > 0 ? (sum / totalChars) * 1000 : 0,
        };
    });

    return {
        scope,
        runsInScope: n,
        totalCharCount: Math.round(totalChars / n),
        totalPages: Math.round(avgPages),
        phases,
        topLevel: {
            docOpenMs: docOpenMs / n,
            walkMs: walkMs / n,
            analysisMs: analysisMs / n,
            totalMs: cliWallMs / n,
            workerTotalMs: workerTotalMs / n,
            runtimeOverheadMs: Math.max(0, (cliWallMs - workerTotalMs) / n),
        },
    };
}

function fmtMs(ms: number): string {
    if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
    if (ms >= 10) return `${ms.toFixed(1)}ms`;
    return `${ms.toFixed(2)}ms`;
}

function fmtPhaseLine(p: AggregatedPhase): string {
    const total = fmtMs(p.totalMs).padStart(8);
    const perPage = fmtMs(p.perPageMs).padStart(8);
    const share = p.sharePct > 0 ? `${p.sharePct.toFixed(1)}%`.padStart(6) : "   -  ";
    const norm =
        p.msPer1kChars > 0
            ? `${p.msPer1kChars.toFixed(2)}ms/1k`.padStart(11)
            : "         - ";
    return `  ${p.name.padEnd(22)} ${total}  ${perPage}  ${share}  ${norm}`;
}

function renderHumanReport(
    runs: ProfileRun[],
    pdfPath: string,
): string {
    const lines: string[] = [];
    lines.push(`beaver-extract profile — ${pdfPath}`);
    lines.push(`runs: ${runs.length} (1 cold, ${Math.max(0, runs.length - 1)} warm)`);

    const cold = aggregate(runs, "cold");
    lines.push("");
    lines.push("cold run (1st execution):");
    lines.push(
        `  totalMs=${fmtMs(cold.topLevel.totalMs)}  worker=${fmtMs(cold.topLevel.workerTotalMs)}  runtimeOverhead=${fmtMs(cold.topLevel.runtimeOverheadMs)}  docOpen=${fmtMs(cold.topLevel.docOpenMs)}  walk=${fmtMs(cold.topLevel.walkMs)}  analysis=${fmtMs(cold.topLevel.analysisMs)}`,
    );
    lines.push(`  pages=${cold.totalPages}  chars=${cold.totalCharCount}`);
    lines.push("  phase                  total     /page   share  per1kchars");
    for (const p of cold.phases) lines.push(fmtPhaseLine(p));

    if (runs.length > 1) {
        const warm = aggregate(runs, "warm-avg");
        lines.push("");
        lines.push(`warm-cache avg (${warm.runsInScope} run${warm.runsInScope === 1 ? "" : "s"}):`);
        lines.push(
            `  totalMs=${fmtMs(warm.topLevel.totalMs)}  worker=${fmtMs(warm.topLevel.workerTotalMs)}  runtimeOverhead=${fmtMs(warm.topLevel.runtimeOverheadMs)}  docOpen=${fmtMs(warm.topLevel.docOpenMs)}  walk=${fmtMs(warm.topLevel.walkMs)}  analysis=${fmtMs(warm.topLevel.analysisMs)}`,
        );
        lines.push(`  pages=${warm.totalPages}  chars=${warm.totalCharCount}`);
        lines.push("  phase                  total     /page   share  per1kchars");
        for (const p of warm.phases) lines.push(fmtPhaseLine(p));
    }
    lines.push("");
    return lines.join("\n");
}

export function buildProfileCommand(deps: CliDeps): Command {
    const cmd = new Command("profile");
    cmd.description(
        "Run structured extraction and print a per-phase timing breakdown. " +
            "Intended for measuring extract bottlenecks and tracking " +
            "improvements over time.",
    )
        .argument("<pdf>", "path to the PDF file")
        .option("--pages <list>", "comma-separated page indices (e.g. '0,1,4')")
        .option("--page-range <range>", "page range '<start>:<end>' (end inclusive)")
        .option("--analysis-window <n>", "analysis window size around target pages")
        .option(
            "--repeat <n>",
            "re-run the extract N times (first run is cold; rest are warm averages)",
            "1",
        )
        .option("--language <lang>", "splitter language code (e.g. 'en')")
        .option("--settings <path>", "path to JSON file with ExtractionSettings")
        .option(
            "--paragraph-settings <path>",
            "path to JSON file with ParagraphDetectionSettings",
        )
        .option("--json", "emit a structured JSON envelope")
        .option("--pretty", "pretty-print JSON output (only with --json)")
        .action(async (pdfPath: string, opts: Record<string, string | undefined>) => {
            let bytes: Uint8Array | undefined;
            const effective: Record<string, unknown> = { file: pdfPath };
            try {
                bytes = await deps.loadPdf(pdfPath);

                const input: ExtractInput = {
                    pdfData: bytes,
                    mode: "structured",
                };
                effective.mode = "structured";
                if (opts.pages) {
                    input.pageIndices = parsePagesList(opts.pages);
                    effective.pageIndices = input.pageIndices;
                }
                if (opts.pageRange) {
                    input.pageRange = parsePageRange(opts.pageRange);
                    effective.pageRange = input.pageRange;
                }
                if (opts.analysisWindow != null) {
                    input.analysisWindow = parseAnalysisWindow(opts.analysisWindow);
                    effective.analysisWindow = input.analysisWindow;
                }
                if (opts.language) {
                    input.structured = {
                        splitterConfig: {
                            type: "sentencex",
                            language: opts.language,
                        },
                    };
                    effective.splitter = input.structured.splitterConfig;
                }
                if (opts.settings) {
                    input.settings = await loadJsonFile(opts.settings);
                    effective.settings = input.settings;
                }
                if (opts.paragraphSettings) {
                    input.paragraphSettings = await loadJsonFile(
                        opts.paragraphSettings,
                    );
                    effective.paragraphSettings = input.paragraphSettings;
                }

                const repeatRaw = opts.repeat ?? "1";
                const repeat = Math.max(1, Math.trunc(Number(repeatRaw)));
                if (!Number.isFinite(repeat)) {
                    throw new Error(`--repeat must be a positive integer (got ${repeatRaw})`);
                }
                effective.repeat = repeat;

                const runs: ProfileRun[] = [];
                let lastResult: ExtractionResult | undefined;
                for (let i = 0; i < repeat; i++) {
                    const startedAt = performance.now();
                    const result = await deps.api.extractPdf(input);
                    const cliWallMs = performance.now() - startedAt;
                    lastResult = result;
                    runs.push({
                        runIndex: i,
                        cold: i === 0,
                        cliWallMs,
                        timings: result.metadata.timings,
                        pageCount: result.pages.length,
                    });
                }

                const envelopeResult: ProfileEnvelopeResult = {
                    runs,
                    aggregated: aggregate(
                        runs,
                        runs.length > 1 ? "warm-avg" : "cold",
                    ),
                };

                if (opts.json) {
                    deps.stdout.write(
                        stringifyEnvelope(
                            buildSuccessEnvelope(
                                pdfPath,
                                bytes,
                                effective,
                                envelopeResult,
                            ),
                            !!opts.pretty,
                        ) + "\n",
                    );
                } else {
                    deps.stdout.write(renderHumanReport(runs, pdfPath));
                    // Keep `lastResult` alive for GC visibility only —
                    // some PDFs are large and we want the structured-clone
                    // pressure to be representative of the actual run.
                    if (lastResult && lastResult.pages.length === 0) {
                        deps.stdout.write("warning: no pages extracted\n");
                    }
                }
            } catch (e) {
                const env = buildErrorEnvelope(e, pdfPath, bytes, effective);
                deps.stderr.write(stringifyEnvelope(env, !!opts.pretty) + "\n");
                process.exitCode = 1;
            }
        });
    return cmd;
}
