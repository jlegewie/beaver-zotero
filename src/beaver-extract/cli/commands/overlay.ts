/**
 * `beaver-extract overlay <pdf>` — render one PDF page with extraction
 * overlays composited on top.
 *
 * Levels: `columns | lines | items | sentences | margins`. The
 * page-content levels come from a structured-mode `extractPdf({ pageIndices: [n] })`;
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
    applyGraphicsLayerMode,
    loadJsonFile,
    parseAnalysisWindow,
    parsePageInt,
} from "../options";
import {
    buildColumnOverlayFromPage,
    buildItemOverlayFromPage,
    buildLineOverlayFromPage,
    buildMarginsOverlayFromAnalysis,
    buildSentenceOverlayFromPage,
} from "../../debug/overlayBuilders";
import type {
    OverlayLevel,
    OverlayResult,
} from "../../debug/overlayBuilders";
import type { ExtractInput, AnalyzeLayoutInput } from "../../node/api";
import type { BeaverExtractResult, StructuredPage } from "../../schema";
import type { InternalProcessedPage } from "../../types";

const VALID_LEVELS: ReadonlyArray<OverlayLevel> = [
    "columns",
    "lines",
    "items",
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

function findPage(extract: BeaverExtractResult, pageIndex: number): InternalProcessedPage {
    if (Array.isArray((extract as any).pages)) {
        const page = (extract as any).pages.find(
            (p: InternalProcessedPage) => p.index === pageIndex,
        );
        if (!page) {
            throw new Error(`overlay: page ${pageIndex} missing from extract.pages`);
        }
        return page;
    }
    if (extract.mode === "markdown") {
        const page = extract.document.pages.find((p) => p.index === pageIndex);
        if (!page) {
            throw new Error(`overlay: page ${pageIndex} missing from extract.pages`);
        }
        return {
            index: page.index,
            label: page.label,
            width: page.width,
            height: page.height,
            content: page.markdown,
            columns: [],
            items: [],
        };
    }
    const page = extract.document.pages.find((p) => p.index === pageIndex);
    if (!page) {
        throw new Error(`overlay: page ${pageIndex} missing from extract.pages`);
    }
    const structuredPage = page as StructuredPage;
    return {
        index: structuredPage.index,
        label: structuredPage.label,
        width: structuredPage.width,
        height: structuredPage.height,
        content: structuredPage.items
            .map((item) => ("text" in item ? item.text : ""))
            .filter(Boolean)
            .join("\n\n"),
        columns: [],
        items: structuredPage.items.map((item) => ({
            id: item.id,
            pageIndex: item.pageIndex,
            index: item.order,
            bbox: {
                l: item.bbox[0],
                t: item.bbox[1],
                r: item.bbox[2],
                b: item.bbox[3],
                origin: "top-left",
            },
            columnIndex: 0,
            kind: item.kind,
            ...("text" in item ? { text: item.text, lines: [] } : {}),
            ...("level" in item ? { level: item.level } : {}),
        })) as InternalProcessedPage["items"],
        sentences: structuredPage.items.flatMap((item) =>
            "sentences" in item
                ? (item.sentences ?? []).map((sentence) => ({
                    parentId: item.id,
                    index: sentence.order,
                    text: sentence.text,
                    bboxes: sentence.bboxes.map((bbox) => ({
                        l: bbox[0],
                        t: bbox[1],
                        r: bbox[2],
                        b: bbox[3],
                        origin: "top-left" as const,
                    })),
                    joinWithNext: sentence.joinWithNext,
                }))
                : [],
        ),
    };
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
        .option("--graphics-layer-mode <mode>", "graphics layer probe mode: off | auto | on")
        .option("--paragraph-settings <path>", "path to JSON file with ParagraphDetectionSettings")
        .option("--sidecar-json", "write a companion JSON sidecar with rect data + stats", false)
        .option("--json", "emit a structured JSON envelope on stdout")
        .option("--pretty", "pretty-print JSON output (only with --json)")
        .action(async (pdfPath: string, opts: Record<string, string | boolean | undefined>) => {
            let bytes: Uint8Array | undefined;
            const outPath = String(opts.out);
            // `effective` is filled progressively so it's still useful in
            // the error envelope even when option parsing throws.
            const effective: Record<string, unknown> = {
                file: pdfPath,
                out: outPath,
            };
            try {
                // Parse argv-derived options inside the try so that
                // structured `--json` errors surface bad input instead of
                // commander's plain-text failure path.
                const pageIndex = parsePageInt(String(opts.page));
                const level = parseLevel(String(opts.level));
                effective.pageIndex = pageIndex;
                effective.level = level;
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
                    }
                    input.settings = applyGraphicsLayerMode(
                        input.settings,
                        typeof opts.graphicsLayerMode === "string"
                            ? opts.graphicsLayerMode
                            : undefined,
                    );
                    if (input.settings) {
                        effective.settings = input.settings;
                    }
                    const layout = await deps.api.analyzeLayout(input);
                    overlay = buildMarginsOverlayFromAnalysis(layout, pageIndex);
                } else {
                    const input: ExtractInput = {
                        pdfData: bytes,
                        mode: "structured",
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
                    }
                    input.settings = applyGraphicsLayerMode(
                        input.settings,
                        typeof opts.graphicsLayerMode === "string"
                            ? opts.graphicsLayerMode
                            : undefined,
                    );
                    if (input.settings) {
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
                        case "items":
                            overlay = buildItemOverlayFromPage(ppage);
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
