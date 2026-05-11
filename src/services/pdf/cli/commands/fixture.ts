/**
 * `beaver-extract fixture …` — capture, evaluate, and rebaseline regression
 * fixtures for the structured-mode extract pipeline.
 *
 * Three subcommands with clean read/write separation:
 *   capture <pdf>       create or replace-config (mutating)
 *   evaluate <id>       read-only — diff captured against fresh
 *   update <id>         rebaseline preserving captured config (mutating)
 *
 * All three share `--root` (default `tests/fixtures/pdfs/extract-public`)
 * so a single corpus root selects the storage directory.
 */
import { Command } from "commander";

import type { CliDeps } from "../runCliTypes";
import {
    emitFailure,
    emitSuccess,
    parsePositiveFloat,
} from "./_sharedHelpers";
import { loadJsonFile, parseAnalysisWindow, parsePagesList } from "../options";
import {
    DEFAULT_ANALYSIS_SCOPE,
    resolveAnalysisWindow,
    scopeFromCliFlags,
    type AnalysisScope,
} from "../fixture/analysisScope";
import {
    captureFingerprints,
    diffFingerprints,
} from "../fixture/fingerprints";
import {
    PUBLIC_FIXTURE_ROOT_REL,
    ensureSharedPdf,
    ensureSourcePdfLink,
    fixtureLocation,
    listFixtureIds,
    readFixture,
    readSharedPdf,
    semanticallyEqual,
    sharedPdfPath,
    writeFixtureFile,
} from "../fixture/fixtureFile";
import {
    FIXTURE_SCHEMA_VERSION,
    type CapturedFixture,
    type FixtureConfig,
} from "../fixture/fixtureSchema";
import {
    diffExtractionSnapshots,
    formatDiffs,
    projectExtractionSnapshot,
} from "../../debug/extractionSnapshot";
import { buildSentenceOverlayFromPage } from "../../debug/overlayBuilders";
import type { ExtractInput } from "../../node/api";
import type {
    ExtractionResult,
    ExtractionSettings,
    ProcessedPage,
} from "../../types";
import type { ParagraphDetectionSettings } from "../../ParagraphDetector";
import type { SentenceSplitterConfig } from "../../sentenceTypes";
import { join, resolve as resolvePath } from "node:path";
import { existsSync } from "node:fs";

const DEFAULT_BBOX_TOL_PT = 0.5;
/** Render scale for preview PNGs. */
const PREVIEW_RENDER_SCALE = 1.5;

function resolveDefaultRoot(): string {
    // Resolve against process.cwd() so a dev's relative invocations work,
    // but keep the literal path stable for the CLI's --help text.
    return resolvePath(process.cwd(), PUBLIC_FIXTURE_ROOT_REL);
}

// ---------------------------------------------------------------------------
// Top-level builder
// ---------------------------------------------------------------------------

export function buildFixtureCommand(deps: CliDeps): Command {
    const cmd = new Command("fixture");
    cmd.description("Capture, evaluate, or rebaseline an extraction fixture.");
    cmd.addCommand(buildCaptureCommand(deps));
    cmd.addCommand(buildEvaluateCommand(deps));
    cmd.addCommand(buildUpdateCommand(deps));
    cmd.addCommand(buildListCommand(deps));
    return cmd;
}

// ---------------------------------------------------------------------------
// fixture capture <pdf>
// ---------------------------------------------------------------------------

function buildCaptureCommand(deps: CliDeps): Command {
    const cmd = new Command("capture");
    cmd.description(
        "Capture (or with --update, replace-config) a fixture from a PDF.",
    )
        .argument("<pdf>", "path to the PDF file")
        .requiredOption("--id <id>", "fixture id (folder name)")
        .requiredOption("--pages <list>", "comma-separated page indices (e.g. '0,3,4')")
        .option(
            "--root <dir>",
            `corpus root (default: ${PUBLIC_FIXTURE_ROOT_REL})`,
        )
        .option(
            "--analysis-scope <scope>",
            `"document" (default) — analyze whole PDF`,
        )
        .option("--analysis-window <n>", "finite analysis window (mutually exclusive with --analysis-scope)")
        .option("--language <lang>", "splitter language code (e.g. 'en')")
        .option("--splitter <type>", "splitter type: sentencex (default) | simple")
        .option("--settings <path>", "path to JSON file with ExtractionSettings")
        .option(
            "--paragraph-settings <path>",
            "path to JSON file with ParagraphDetectionSettings",
        )
        .option("--bbox-tolerance <pt>", "stored tolerance in points (default 0.5)")
        .option(
            "--update",
            "allow replacing an existing fixture (config-changing path)",
        )
        .option(
            "--allow-ocr",
            "skip the OCR pre-check (use only for mixed scan/text PDFs)",
            false,
        )
        .option(
            "--preview",
            "render preview-p<n>.png with sentence overlay per captured page",
            false,
        )
        .option("--json", "emit a structured JSON envelope")
        .option("--pretty", "pretty-print JSON output (only with --json)")
        .action(async (pdfPath: string, opts: CaptureOpts) => {
            const root = opts.root
                ? resolvePath(process.cwd(), opts.root)
                : resolveDefaultRoot();
            const effective: Record<string, unknown> = {
                file: pdfPath,
                id: opts.id,
                root,
            };
            let bytes: Uint8Array | undefined;
            try {
                if (!opts.id) throw new Error("--id is required");
                if (!opts.pages) throw new Error("--pages is required");

                const config = await buildConfigFromCaptureOpts(opts);
                effective.config = config;

                bytes = await deps.loadPdf(pdfPath);
                const sha = ensureSharedPdf(root, bytes);
                effective.pdfSha256 = sha;

                const loc = fixtureLocation(root, opts.id);
                const exists = existsSync(loc.fixtureJson);
                if (exists && !opts.update) {
                    throw new Error(
                        `fixture exists at ${loc.fixtureJson}; pass --update to replace config, or use \`fixture update ${opts.id}\` to rebaseline only \`expected\``,
                    );
                }

                // Refuse to capture an extraction fixture from a scanned PDF
                if (!opts.allowOcr) {
                    const ocr = await deps.api.analyzeOCRNeeds(bytes);
                    if (ocr.needsOCR) {
                        throw new Error(
                            `PDF needs OCR (${ocr.primaryReason}); use \`ocr-fixture capture\` for OCR-detection fixtures, or pass --allow-ocr to capture anyway`,
                        );
                    }
                }

                const result = await deps.api.extractPdf(buildExtractInput(bytes, config));
                const expected = projectExtractionSnapshot(result);
                const fingerprints = captureFingerprints();
                const tolerance = {
                    bboxAbsPt:
                        opts.bboxTolerance != null
                            ? parsePositiveFloat("--bbox-tolerance", opts.bboxTolerance)
                            : DEFAULT_BBOX_TOL_PT,
                };

                const now = new Date().toISOString();
                let fixture: CapturedFixture;
                let wrote = false;
                if (exists) {
                    const previous = readFixture(root, opts.id);
                    const candidate: CapturedFixture = {
                        schema: FIXTURE_SCHEMA_VERSION,
                        id: opts.id,
                        capturedAt: previous.capturedAt,
                        updatedAt: now,
                        pdfSha256: sha,
                        pdfBytes: bytes.byteLength,
                        config,
                        fingerprints,
                        tolerance,
                        expected,
                    };
                    if (semanticallyEqual(previous, candidate)) {
                        // True no-op — snapshot, config, and fingerprints all match.
                        fixture = previous;
                    } else {
                        fixture = candidate;
                        writeFixtureFile(loc, fixture);
                        wrote = true;
                    }
                } else {
                    fixture = {
                        schema: FIXTURE_SCHEMA_VERSION,
                        id: opts.id,
                        capturedAt: now,
                        updatedAt: now,
                        pdfSha256: sha,
                        pdfBytes: bytes.byteLength,
                        config,
                        fingerprints,
                        tolerance,
                        expected,
                    };
                    writeFixtureFile(loc, fixture);
                    wrote = true;
                }

                const previewPaths = opts.preview
                    ? await renderPreviewsForFixture(
                          deps,
                          bytes,
                          loc.folder,
                          result,
                          config.pageIndices,
                      )
                    : [];

                const sourcePdfLink = ensureSourcePdfLink(loc, sha, (msg) =>
                    deps.stderr.write(`[${opts.id}] warning: ${msg}\n`),
                );

                emitSuccess(deps, opts, pdfPath, bytes, effective, {
                    folder: loc.folder,
                    fixtureJson: loc.fixtureJson,
                    sharedPdf: sharedPdfPath(root, sha),
                    sourcePdfLink,
                    pageCount: expected.perPage.length,
                    sentenceCount: expected.totals.sentenceCount,
                    wrote,
                    previews: previewPaths,
                    capturedAt: fixture.capturedAt,
                    updatedAt: fixture.updatedAt,
                });
            } catch (e) {
                emitFailure(deps, opts, pdfPath, bytes, effective, e);
            }
        });
    return cmd;
}

interface CaptureOpts {
    id: string;
    pages: string;
    root?: string;
    analysisScope?: string;
    analysisWindow?: string;
    language?: string;
    splitter?: string;
    settings?: string;
    paragraphSettings?: string;
    bboxTolerance?: string;
    update?: boolean;
    allowOcr?: boolean;
    preview?: boolean;
    json?: boolean;
    pretty?: boolean;
}

async function buildConfigFromCaptureOpts(opts: CaptureOpts): Promise<FixtureConfig> {
    const pageIndices = parsePagesList(opts.pages);
    const scope = scopeFromCliFlags({
        analysisScopeFlag: opts.analysisScope,
        analysisWindowFlag:
            opts.analysisWindow != null
                ? parseAnalysisWindow(opts.analysisWindow)
                : undefined,
    });
    const splitterConfig = buildSplitterConfig(opts.splitter, opts.language);
    const settings = opts.settings
        ? await loadJsonFile<ExtractionSettings>(opts.settings)
        : ({} as ExtractionSettings);
    const paragraphSettings = opts.paragraphSettings
        ? await loadJsonFile<ParagraphDetectionSettings>(opts.paragraphSettings)
        : ({} as ParagraphDetectionSettings);
    return {
        pageIndices,
        analysisScope: scope ?? DEFAULT_ANALYSIS_SCOPE,
        splitterConfig,
        settings,
        paragraphSettings,
    };
}

function buildSplitterConfig(
    splitterFlag: string | undefined,
    language: string | undefined,
): SentenceSplitterConfig {
    const type = splitterFlag ?? "sentencex";
    if (type === "simple") {
        if (language) {
            throw new Error("--language is not applicable to --splitter simple");
        }
        return { type: "simple" };
    }
    if (type !== "sentencex") {
        throw new Error(`--splitter must be "sentencex" or "simple", got "${type}"`);
    }
    const out: { type: "sentencex"; language?: string } = { type: "sentencex" };
    if (language) out.language = language;
    return out;
}

// ---------------------------------------------------------------------------
// fixture evaluate <id>
// ---------------------------------------------------------------------------

function buildEvaluateCommand(deps: CliDeps): Command {
    const cmd = new Command("evaluate");
    cmd.description("Re-run extraction with the captured config and diff against expected. Read-only.")
        .argument("<id>", "fixture id (folder name)")
        .option(
            "--root <dir>",
            `corpus root (default: ${PUBLIC_FIXTURE_ROOT_REL})`,
        )
        .option("--bbox-tolerance <pt>", "override stored tolerance")
        .option("--verbose", "surface git-SHA fingerprint mismatches")
        .option("--json", "emit a structured JSON envelope")
        .option("--pretty", "pretty-print JSON output (only with --json)")
        .action(async (id: string, opts: EvaluateOpts) => {
            const root = opts.root
                ? resolvePath(process.cwd(), opts.root)
                : resolveDefaultRoot();
            const effective: Record<string, unknown> = { id, root };
            try {
                const fixture = readFixture(root, id);
                const pdfBytes = readSharedPdf(root, fixture.pdfSha256);
                const tol =
                    opts.bboxTolerance != null
                        ? parsePositiveFloat("--bbox-tolerance", opts.bboxTolerance)
                        : fixture.tolerance.bboxAbsPt;

                const result = await deps.api.extractPdf(
                    buildExtractInput(pdfBytes, fixture.config),
                );
                const actual = projectExtractionSnapshot(result);
                const diffs = diffExtractionSnapshots(fixture.expected, actual, {
                    bboxAbsPt: tol,
                });

                const fpDiff = diffFingerprints(fixture.fingerprints, captureFingerprints());
                emitFingerprintWarnings(deps, id, fpDiff, !!opts.verbose);

                const ok = diffs.length === 0;
                if (opts.json) {
                    const envelope = {
                        ok,
                        input: { fixtureId: id, root },
                        options: { bboxAbsPt: tol, verbose: !!opts.verbose },
                        result: {
                            id,
                            diffCount: diffs.length,
                            diffs,
                            fingerprints: fpDiff,
                        },
                    };
                    deps.stdout.write(
                        JSON.stringify(envelope, null, opts.pretty ? 2 : 0) + "\n",
                    );
                } else {
                    deps.stdout.write(formatDiffs(id, diffs) + "\n");
                }
                if (!ok) process.exitCode = 1;
            } catch (e) {
                emitFailure(deps, opts, id, undefined, effective, e);
            }
        });
    return cmd;
}

interface EvaluateOpts {
    root?: string;
    bboxTolerance?: string;
    verbose?: boolean;
    json?: boolean;
    pretty?: boolean;
}

// ---------------------------------------------------------------------------
// fixture update <id>
// ---------------------------------------------------------------------------

function buildUpdateCommand(deps: CliDeps): Command {
    const cmd = new Command("update");
    cmd.description("Rebaseline a fixture's expected snapshot. Preserves the stored config.")
        .argument("<id>", "fixture id (folder name)")
        .option(
            "--root <dir>",
            `corpus root (default: ${PUBLIC_FIXTURE_ROOT_REL})`,
        )
        .option(
            "--preview",
            "re-render preview-p<n>.png with sentence overlay per captured page",
            false,
        )
        .option("--json", "emit a structured JSON envelope")
        .option("--pretty", "pretty-print JSON output (only with --json)")
        .action(async (id: string, opts: UpdateOpts) => {
            const root = opts.root
                ? resolvePath(process.cwd(), opts.root)
                : resolveDefaultRoot();
            const effective: Record<string, unknown> = { id, root };
            try {
                const previous = readFixture(root, id);
                const pdfBytes = readSharedPdf(root, previous.pdfSha256);
                const result = await deps.api.extractPdf(
                    buildExtractInput(pdfBytes, previous.config),
                );
                const expected = projectExtractionSnapshot(result);
                const fingerprints = captureFingerprints();

                const now = new Date().toISOString();
                const candidate: CapturedFixture = {
                    ...previous,
                    schema: FIXTURE_SCHEMA_VERSION,
                    expected,
                    fingerprints,
                    updatedAt: now,
                };
                const loc = fixtureLocation(root, id);
                let wrote = false;
                if (!semanticallyEqual(previous, candidate)) {
                    writeFixtureFile(loc, candidate);
                    wrote = true;
                }

                const previewPaths = opts.preview
                    ? await renderPreviewsForFixture(
                          deps,
                          pdfBytes,
                          loc.folder,
                          result,
                          previous.config.pageIndices,
                      )
                    : [];

                const sourcePdfLink = ensureSourcePdfLink(loc, previous.pdfSha256, (msg) =>
                    deps.stderr.write(`[${id}] warning: ${msg}\n`),
                );

                emitSuccess(deps, opts, id, undefined, effective, {
                    id,
                    wrote,
                    previews: previewPaths,
                    sourcePdfLink,
                    capturedAt: previous.capturedAt,
                    updatedAt: wrote ? candidate.updatedAt : previous.updatedAt,
                });
            } catch (e) {
                emitFailure(deps, opts, id, undefined, effective, e);
            }
        });
    return cmd;
}

interface UpdateOpts {
    root?: string;
    preview?: boolean;
    json?: boolean;
    pretty?: boolean;
}

// ---------------------------------------------------------------------------
// fixture list
// ---------------------------------------------------------------------------

function buildListCommand(deps: CliDeps): Command {
    const cmd = new Command("list");
    cmd.description("List fixture ids under a corpus root.")
        .option(
            "--root <dir>",
            `corpus root (default: ${PUBLIC_FIXTURE_ROOT_REL})`,
        )
        .option("--json", "emit a structured JSON envelope")
        .option("--pretty", "pretty-print JSON output (only with --json)")
        .action((opts: { root?: string; json?: boolean; pretty?: boolean }) => {
            const root = opts.root
                ? resolvePath(process.cwd(), opts.root)
                : resolveDefaultRoot();
            const ids = listFixtureIds(root);
            if (opts.json) {
                deps.stdout.write(
                    JSON.stringify(
                        { ok: true, input: { root }, result: { ids } },
                        null,
                        opts.pretty ? 2 : 0,
                    ) + "\n",
                );
            } else {
                if (ids.length === 0) {
                    deps.stdout.write(`(no fixtures under ${root})\n`);
                } else {
                    for (const id of ids) deps.stdout.write(id + "\n");
                }
            }
        });
    return cmd;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Render one preview-p<n>.png per captured page, with the sentence-level
 * overlay composited on top.
 *
 * Returns the absolute paths written, in the same order as `pageIndices`.
 * Pages that aren't present in `result.pages` are skipped silently — that
 * shouldn't happen because the same `extractPdf` call produced the result,
 * but we don't want a missing page to crash the capture command.
 */
async function renderPreviewsForFixture(
    deps: CliDeps,
    pdfBytes: Uint8Array,
    fixtureFolder: string,
    result: ExtractionResult,
    pageIndices: number[],
): Promise<string[]> {
    const rendered = await deps.api.renderPages({
        pdfData: pdfBytes,
        pageIndices,
        options: { scale: PREVIEW_RENDER_SCALE, format: "png" },
    });
    const paths: string[] = [];
    for (const pageIndex of pageIndices) {
        const renderedPage = rendered.pages.find((p) => p.pageIndex === pageIndex);
        const ppage: ProcessedPage | undefined = result.pages.find(
            (p) => p.index === pageIndex,
        );
        if (!renderedPage || !ppage) continue;
        const overlay = buildSentenceOverlayFromPage(ppage);
        const composited = await deps.drawOverlay(
            renderedPage.data,
            renderedPage.width,
            renderedPage.height,
            overlay.pageWidth,
            overlay.pageHeight,
            overlay.rects,
        );
        const outPath = join(fixtureFolder, `preview-p${pageIndex}.png`);
        await deps.writePngFile(outPath, composited);
        paths.push(outPath);
    }
    return paths;
}

function buildExtractInput(pdfBytes: Uint8Array, config: FixtureConfig): ExtractInput {
    return {
        pdfData: pdfBytes,
        mode: "structured",
        pageIndices: config.pageIndices,
        analysisWindow: resolveAnalysisWindow(config.analysisScope),
        settings: config.settings,
        paragraphSettings: config.paragraphSettings,
        structured: { splitterConfig: config.splitterConfig },
    };
}

function emitFingerprintWarnings(
    deps: CliDeps,
    id: string,
    diff: ReturnType<typeof diffFingerprints>,
    verbose: boolean,
): void {
    for (const w of diff.wasm) {
        deps.stderr.write(
            `[${id}] warning: ${w.kind} WASM SHA differs (expected ${w.expected.slice(0, 12)}…, got ${w.actual.slice(0, 12)}…)\n`,
        );
    }
    if (diff.version) {
        deps.stderr.write(
            `[${id}] warning: extractor version differs (expected ${diff.version.expected ?? "(null)"}, got ${diff.version.actual ?? "(null)"})\n`,
        );
    }
    if (verbose && diff.gitSha) {
        deps.stderr.write(
            `[${id}] info: git SHA differs (expected ${diff.gitSha.expected ?? "(null)"}, got ${diff.gitSha.actual ?? "(null)"})\n`,
        );
    }
}

