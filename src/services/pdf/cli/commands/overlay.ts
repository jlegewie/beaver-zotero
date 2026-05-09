/**
 * `beaver-extract overlay <pdf>` — render one PDF page with extraction
 * overlays composited on top.
 *
 * Levels: `columns | lines | paragraphs | sentences | margins`. The
 * first four come from a structured-mode `extractPdf({ pageIndices: [n] })`;
 * `margins` comes from `analyzeLayout` so the candidates / removal
 * decisions match what production extract sees pre-filter.
 *
 * Always writes a PNG file to `--out`. With `--sidecar-json`, writes a
 * companion `<out>.json` with rect data + page dims + stats + effective
 * options.
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
    parsePageInt,
} from "../options";
import {
    buildColumnOverlayFromPage,
    buildLineOverlayFromPage,
    buildMarginsOverlayFromAnalysis,
    buildParagraphOverlayFromPage,
    buildSentenceOverlayFromPage,
} from "../../debug/overlayBuilders";
import type {
    OverlayLevel,
    OverlayResult,
} from "../../debug/overlayBuilders";
import type { ExtractInput, AnalyzeLayoutInput } from "../../node/api";
import type { ExtractionResult, ProcessedPage } from "../../types";

const VALID_LEVELS: ReadonlyArray<OverlayLevel> = [
    "columns",
    "lines",
    "paragraphs",
    "sentences",
    "margins",
];

function parseLevel(value: string): OverlayLevel {
    if ((VALID_LEVELS as readonly string[]).includes(value)) {
        return value as OverlayLevel;
    }
    throw new Error(
        `--level must be one of ${VALID_LEVELS.join(" | ")}, got "${value}"`,
    );
}

function findPage(
    extract: ExtractionResult,
    pageIndex: number,
): ProcessedPage {
    const page = extract.pages.find((p) => p.index === pageIndex);
    if (!page) {
        throw new Error(
            `overlay: page ${pageIndex} missing from extract.pages`,
        );
    }
    return page;
}

export function buildOverlayCommand(deps: CliDeps): Command {
    const cmd = new Command("overlay");
    cmd.description("Render a page with extraction overlays composited on top.")
        .argument("<pdf>", "path to the PDF file")
        .requiredOption("--page <n>", "page index (0-based)")
        .requiredOption(
            "--level <level>",
            `overlay level: ${VALID_LEVELS.join(" | ")}`,
        )
        .requiredOption("--out <path>", "output PNG file path")
        .option("--dpi <n>", "render DPI (default: scale=2.0 → 144 DPI)")
        .option("--scale <n>", "render scale factor (default: 2.0)")
        .option("--analysis-window <n>", "analysis window size around target page")
        .option("--language <lang>", "splitter language code (e.g. 'en')")
        .option("--settings <path>", "path to JSON file with ExtractionSettings")
        .option("--paragraph-settings <path>", "path to JSON file with ParagraphDetectionSettings")
        .option("--sidecar-json", "write a companion JSON sidecar with rect data + stats", false)
        .option("--json", "emit a structured JSON envelope on stdout")
        .option("--pretty", "pretty-print JSON output (only with --json)")
        .action(async (pdfPath: string, opts: Record<string, string | boolean | undefined>) => {
            let bytes: Uint8Array | undefined;
            const pageIndex = parsePageInt(String(opts.page));
            const level = parseLevel(String(opts.level));
            const outPath = String(opts.out);
            const effective: Record<string, unknown> = {
                file: pdfPath,
                pageIndex,
                level,
                out: outPath,
            };
            try {
                bytes = await deps.loadPdf(pdfPath);

                // Render the page first so we have target image dims.
                const renderScale =
                    opts.dpi != null ? undefined : opts.scale != null ? Number(opts.scale) : 2.0;
                const renderDpi = opts.dpi != null ? Number(opts.dpi) : undefined;
                effective.scale = renderScale;
                effective.dpi = renderDpi;

                const rendered = await deps.api.renderPages({
                    pdfData: bytes,
                    pageIndices: [pageIndex],
                    options:
                        renderDpi != null
                            ? { dpi: renderDpi }
                            : { scale: renderScale ?? 2.0 },
                });
                const page = rendered.pages.find((p) => p.pageIndex === pageIndex);
                if (!page) {
                    throw new Error(`overlay: render did not produce page ${pageIndex}`);
                }

                // Build the overlay rects for the requested level. `margins`
                // routes through analyzeLayout; everything else goes through
                // a single structured-mode extract for the target page.
                let overlay: OverlayResult;
                if (level === "margins") {
                    const input: AnalyzeLayoutInput = {
                        pdfData: bytes,
                        pageIndices: [pageIndex],
                    };
                    if (opts.analysisWindow != null) {
                        input.analysisWindow = parseAnalysisWindow(String(opts.analysisWindow));
                        effective.analysisWindow = input.analysisWindow;
                    }
                    if (opts.settings) {
                        input.settings = await loadJsonFile(String(opts.settings));
                        effective.settings = input.settings;
                    }
                    const layout = await deps.api.analyzeLayout(input);
                    overlay = buildMarginsOverlayFromAnalysis(layout, pageIndex);
                } else {
                    const input: ExtractInput = {
                        pdfData: bytes,
                        mode: "structured",
                        pageIndices: [pageIndex],
                    };
                    if (opts.analysisWindow != null) {
                        input.analysisWindow = parseAnalysisWindow(String(opts.analysisWindow));
                        effective.analysisWindow = input.analysisWindow;
                    }
                    if (opts.language) {
                        input.structured = {
                            splitterConfig: {
                                type: "sentencex",
                                language: String(opts.language),
                            },
                        };
                        effective.splitter = input.structured.splitterConfig;
                    }
                    if (opts.settings) {
                        input.settings = await loadJsonFile(String(opts.settings));
                        effective.settings = input.settings;
                    }
                    if (opts.paragraphSettings) {
                        input.paragraphSettings = await loadJsonFile(
                            String(opts.paragraphSettings),
                        );
                        effective.paragraphSettings = input.paragraphSettings;
                    }
                    const extract = await deps.api.extractPdf(input);
                    const ppage = findPage(extract, pageIndex);
                    switch (level) {
                        case "columns":
                            overlay = buildColumnOverlayFromPage(ppage);
                            break;
                        case "lines":
                            overlay = buildLineOverlayFromPage(ppage);
                            break;
                        case "paragraphs":
                            overlay = buildParagraphOverlayFromPage(ppage);
                            break;
                        case "sentences":
                            overlay = buildSentenceOverlayFromPage(ppage);
                            break;
                    }
                }

                const composited = await deps.drawOverlay(
                    page.data,
                    page.width,
                    page.height,
                    overlay.pageWidth,
                    overlay.pageHeight,
                    overlay.rects,
                );
                await deps.writePngFile(outPath, composited);

                if (opts.sidecarJson) {
                    const sidecar = {
                        ok: true,
                        input: { file: pdfPath, pageIndex, level },
                        options: effective,
                        result: {
                            outPath,
                            image: {
                                width: page.width,
                                height: page.height,
                                pageWidth: overlay.pageWidth,
                                pageHeight: overlay.pageHeight,
                            },
                            stats: overlay.stats,
                            rects: overlay.rects,
                        },
                    };
                    await deps.writeJsonFile(
                        `${outPath}.json`,
                        sidecar,
                        !!opts.pretty,
                    );
                }

                if (opts.json) {
                    const result = {
                        outPath,
                        image: {
                            width: page.width,
                            height: page.height,
                            pageWidth: overlay.pageWidth,
                            pageHeight: overlay.pageHeight,
                        },
                        stats: overlay.stats,
                        rectCount: overlay.rects.length,
                        sidecarJson: opts.sidecarJson ? `${outPath}.json` : null,
                    };
                    deps.stdout.write(
                        stringifyEnvelope(
                            buildSuccessEnvelope(pdfPath, bytes, effective, result),
                            !!opts.pretty,
                        ) + "\n",
                    );
                } else {
                    deps.stdout.write(
                        `wrote ${outPath} (${overlay.rects.length} rects, ${overlay.groupCount} group(s))\n`,
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
