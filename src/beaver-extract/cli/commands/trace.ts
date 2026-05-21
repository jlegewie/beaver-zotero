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
    parsePageInt,
} from "../options";
import { projectTracePage, type TraceVerbosity } from "../../debug/traceProjection";
import type { StructuredTraceInput } from "../../node/api";

function parseMode(value: string | undefined): TraceVerbosity {
    if (value === undefined || value === "triage") return "triage";
    if (value === "full") return "full";
    throw new Error('--mode must be one of "triage" | "full"');
}

export function buildTraceCommand(deps: CliDeps): Command {
    const cmd = new Command("trace");
    cmd.description("Run full-document structured extraction and print page debug trace.")
        .argument("<pdf>", "path to the PDF file")
        .requiredOption("--page <n>", "page index (0-based)")
        .option("--mode <mode>", "trace verbosity: triage | full", "triage")
        .option("--analysis-window <n>", "analysis window size")
        .option("--language <lang>", "splitter language code (e.g. 'en')")
        .option("--bbox-precision <n>", "structured bbox decimal precision", "1")
        .option("--settings <path>", "path to JSON file with ExtractionSettings")
        .option("--graphics-layer-mode <mode>", "graphics layer probe mode: off | auto | on")
        .option("--paragraph-settings <path>", "path to JSON file with ParagraphDetectionSettings")
        .option("--json", "emit a structured JSON envelope")
        .option("--pretty", "pretty-print JSON output")
        .action(async (pdfPath: string, opts: Record<string, string | undefined>) => {
            let bytes: Uint8Array | undefined;
            const effective: Record<string, unknown> = { file: pdfPath };
            try {
                bytes = await deps.loadPdf(pdfPath);
                const pageIndex = parsePageInt(String(opts.page));
                const mode = parseMode(opts.mode);
                const input: StructuredTraceInput = {
                    pdfData: bytes,
                    mode: "structured",
                    capturePages: [pageIndex],
                    debugMode: mode,
                    structured: {
                        bboxPrecision: Number(opts.bboxPrecision ?? 1),
                    },
                };
                effective.pageIndex = pageIndex;
                effective.mode = mode;
                if (opts.language) {
                    input.structured = {
                        ...input.structured,
                        splitterConfig: {
                            type: "sentencex",
                            language: opts.language,
                        },
                    };
                }
                if (opts.analysisWindow != null) {
                    input.analysisWindow = parseAnalysisWindow(opts.analysisWindow);
                    effective.analysisWindow = input.analysisWindow;
                }
                if (opts.settings) input.settings = await loadJsonFile(opts.settings);
                input.settings = applyGraphicsLayerMode(
                    input.settings,
                    opts.graphicsLayerMode,
                );
                if (opts.paragraphSettings) {
                    input.paragraphSettings = await loadJsonFile(opts.paragraphSettings);
                }

                const out = await deps.api.structuredExtractWithDebug(input);
                const projection = projectTracePage(
                    out.result,
                    out.debug,
                    pageIndex,
                    mode,
                );
                if (opts.json) {
                    deps.stdout.write(
                        stringifyEnvelope(
                            buildSuccessEnvelope(pdfPath, bytes, effective, projection),
                            !!opts.pretty,
                        ) + "\n",
                    );
                } else {
                    deps.stdout.write(
                        `trace page=${pageIndex} mode=${mode} items=${projection.page.counts.items} sentences=${projection.page.counts.sentences}\n`,
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
