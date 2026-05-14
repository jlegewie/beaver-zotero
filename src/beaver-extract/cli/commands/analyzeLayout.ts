/**
 * `beaver-extract analyze-layout <pdf>` — document-wide style and margin
 * analysis. Wire shape matches the `/beaver/test/pdf-analyze-layout`
 * endpoint via the shared `debug/analyzeLayoutProjection`.
 */
import { Command } from "commander";

import type { CliDeps } from "../runCliTypes";
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
import { projectAnalyzeLayout } from "../../debug/analyzeLayoutProjection";
import type { AnalyzeLayoutInput } from "../../node/api";

export function buildAnalyzeLayoutCommand(deps: CliDeps): Command {
    const cmd = new Command("analyze-layout");
    cmd.description("Run document-wide style + margin analysis.")
        .argument("<pdf>", "path to the PDF file")
        .option("--pages <list>", "comma-separated page indices (e.g. '0,1,4')")
        .option("--page-range <range>", "page range '<start>:<end>' (end inclusive)")
        .option("--analysis-window <n>", "analysis window size around target pages")
        .option("--settings <path>", "path to JSON file with ExtractionSettings")
        .option("--json", "emit a structured JSON envelope")
        .option("--pretty", "pretty-print JSON output (only with --json)")
        .action(async (pdfPath: string, opts: Record<string, string | undefined>) => {
            let bytes: Uint8Array | undefined;
            const effective: Record<string, unknown> = { file: pdfPath };
            try {
                bytes = await deps.loadPdf(pdfPath);
                const input: AnalyzeLayoutInput = { pdfData: bytes };
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
                if (opts.settings) {
                    input.settings = await loadJsonFile(opts.settings);
                    effective.settings = input.settings;
                }

                const result = await deps.api.analyzeLayout(input);
                const wire = projectAnalyzeLayout(result);

                if (opts.json) {
                    deps.stdout.write(
                        stringifyEnvelope(
                            buildSuccessEnvelope(pdfPath, bytes, effective, wire),
                            !!opts.pretty,
                        ) + "\n",
                    );
                } else {
                    const candidates = wire.analysis.margin_removal.candidates.length;
                    const totalRemovals = Object.values(
                        wire.analysis.margin_removal.removalsByPage,
                    ).reduce((sum, arr) => sum + arr.length, 0);
                    deps.stdout.write(
                        `analyzed ${wire.analysis_page_indices.length} page(s); ` +
                            `${candidates} candidate(s), ${totalRemovals} removal(s)\n`,
                    );
                }
            } catch (e) {
                const env = buildErrorEnvelope(e, pdfPath, bytes, effective);
                deps.stderr.write(stringifyEnvelope(env, !!opts.pretty) + "\n");
                process.exitCode = 1;
            }
        });
    return cmd;
}
