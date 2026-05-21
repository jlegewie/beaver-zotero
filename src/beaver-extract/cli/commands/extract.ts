/**
 * `beaver-extract extract <pdf>` — full structured or markdown extract.
 *
 * Flags mirror `node/api.extractPdf` arguments. Default mode is
 * `structured`, which is what overlay/fixture work consumes.
 */
import { Command } from "commander";

import type { CliDeps } from "../runCliTypes";
import {
    buildErrorEnvelope,
    buildSuccessEnvelope,
    stringifyEnvelope,
} from "../envelope";
import {
    applyGraphicsLayerMode,
    loadJsonFile,
    parseAnalysisWindow,
    parsePageRange,
    parsePagesList,
} from "../options";
import type { ExtractInput } from "../../node/api";
import {
    validateMarkdownExtractResult,
    validateStructuredExtractResult,
} from "../../schema";

export function buildExtractCommand(deps: CliDeps): Command {
    const cmd = new Command("extract");
    cmd.description("Run structured or markdown extraction on a PDF.")
        .argument("<pdf>", "path to the PDF file")
        .option("--mode <mode>", "extraction mode: 'structured' | 'markdown'", "structured")
        .option("--pages <list>", "comma-separated page indices (e.g. '0,1,4')")
        .option("--page-range <range>", "page range '<start>:<end>' (end inclusive)")
        .option("--analysis-window <n>", "analysis window size around target pages")
        .option("--language <lang>", "splitter language code (e.g. 'en')")
        .option("--bbox-precision <n>", "structured bbox decimal precision", "1")
        .option("--settings <path>", "path to JSON file with ExtractionSettings")
        .option("--graphics-layer-mode <mode>", "graphics layer probe mode: off | auto | on")
        .option("--paragraph-settings <path>", "path to JSON file with ParagraphDetectionSettings")
        .option("--json", "emit a structured JSON envelope")
        .option("--pretty", "pretty-print JSON output (only with --json)")
        .action(async (pdfPath: string, opts: Record<string, string | undefined>) => {
            let bytes: Uint8Array | undefined;
            const effective: Record<string, unknown> = { file: pdfPath };
            try {
                bytes = await deps.loadPdf(pdfPath);

                const input: ExtractInput = { pdfData: bytes };
                if (opts.mode === "markdown" || opts.mode === "structured") {
                    input.mode = opts.mode;
                    effective.mode = opts.mode;
                }
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
                if (input.mode === "structured") {
                    const bboxPrecision = Number(opts.bboxPrecision ?? 1);
                    input.structured = {
                        ...(input.structured ?? {}),
                        bboxPrecision,
                    };
                    effective.bboxPrecision = bboxPrecision;
                }
                if (opts.settings) {
                    input.settings = await loadJsonFile(opts.settings);
                }
                input.settings = applyGraphicsLayerMode(
                    input.settings,
                    opts.graphicsLayerMode,
                );
                if (input.settings) {
                    effective.settings = input.settings;
                }
                if (opts.paragraphSettings) {
                    input.paragraphSettings = await loadJsonFile(opts.paragraphSettings);
                    effective.paragraphSettings = input.paragraphSettings;
                }

                const result = await deps.api.extractPdf(input);
                if (result.mode === "structured") {
                    validateStructuredExtractResult(result);
                } else if (result.mode === "markdown") {
                    validateMarkdownExtractResult(result);
                }

                if (opts.json) {
                    deps.stdout.write(
                        stringifyEnvelope(
                            buildSuccessEnvelope(pdfPath, bytes, effective, result),
                            !!opts.pretty,
                        ) + "\n",
                    );
                } else {
                    const pageCount = "document" in result
                        ? result.document.pages.length
                        : ((result as any).pages?.length ?? 0);
                    deps.stdout.write(
                        `extracted ${pageCount} page(s); ` +
                            `mode=${input.mode ?? "structured"}\n`,
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
