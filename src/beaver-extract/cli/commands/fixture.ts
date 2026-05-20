/**
 * `beaver-extract fixture …` — capture, evaluate, and rebaseline regression
 * fixtures for the structured-mode extract pipeline.
 *
 * Three subcommands with clean read/write separation:
 *   capture <pdf>       create or replace-config (mutating)
 *   evaluate <id>       read-only — diff captured against fresh
 *   update <id>         rebaseline preserving captured config (mutating)
 *
 * All three share `--root`, which selects the storage directory. When
 * `$BEAVER_EXTRACT_FIXTURES_DIR` is set the default points at it; otherwise
 * the default is the in-tree public corpus
 * (`tests/fixtures/pdfs/extract-public`).
 */
import { Command } from "commander";

import type { CliDeps } from "../runCliTypes";
import {
    emitFailure,
    emitSuccess,
    parsePositiveFloat,
} from "./_sharedHelpers";
import {
    applyGraphicsLayerMode,
    loadJsonFile,
    parseAnalysisWindow,
    parsePagesList,
} from "../options";
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
    PRIVATE_FIXTURE_DIR_ENV,
    PUBLIC_FIXTURE_ROOT_REL,
    ensureSharedPdf,
    ensureSourcePdfLink,
    fixtureLocation,
    listFixtureIds,
    readFixture,
    readSharedPdf,
    resolvePrivateFixtureRoot,
    semanticallyEqual,
    sharedPdfPath,
    writeFixtureFile,
} from "../fixture/fixtureFile";
import {
    FIXTURE_SCHEMA_VERSION,
    type CapturedFixture,
    type ExpectedExtraction,
    FixtureValidationError,
    type FixtureConfig,
    validateConfig,
    validateFixture,
    validateTolerance,
} from "../fixture/fixtureSchema";
import {
    diffMarkdownPages,
    diffStructuredPages,
    formatDiffs,
    type SnapshotDiff,
} from "../fixture/pageDiff";
import { buildSentenceOverlayFromPage } from "../../debug/overlayBuilders";
import type { ExtractInput } from "../../node/api";
import type {
    ExtractionSettings,
    InternalProcessedPage,
} from "../../types";
import type {
    StructuredExtractResult,
    StructuredPage,
} from "../../schema";
import type { ParagraphDetectionSettings } from "../../ParagraphDetector";
import type { SentenceSplitterConfig } from "../../sentenceTypes";
import { join, resolve as resolvePath } from "node:path";
import { existsSync, readFileSync } from "node:fs";

const DEFAULT_BBOX_TOL_PT = 0.5;
/** Render scale for preview PNGs. */
const PREVIEW_RENDER_SCALE = 1.5;

function resolveDefaultRoot(): string {
    // When $BEAVER_EXTRACT_FIXTURES_DIR is set, that's the user's working
    // corpus (typically a checkout of beaver-extract-fixtures) — default to
    // it so capture/update/list target the right place without --root.
    // Otherwise fall back to the in-tree public corpus.
    const envRoot = process.env[PRIVATE_FIXTURE_DIR_ENV]?.trim();
    if (envRoot && envRoot.length > 0) {
        return resolvePrivateFixtureRoot(process.cwd());
    }
    return resolvePath(process.cwd(), PUBLIC_FIXTURE_ROOT_REL);
}

function defaultRootHelp(): string {
    return `corpus root (default: $${PRIVATE_FIXTURE_DIR_ENV} if set, else ${PUBLIC_FIXTURE_ROOT_REL})`;
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
    cmd.addCommand(buildMigrateCommand(deps));
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
            defaultRootHelp(),
        )
        .option(
            "--analysis-scope <scope>",
            `"document" (default) — analyze whole PDF`,
        )
        .option("--analysis-window <n>", "finite analysis window (mutually exclusive with --analysis-scope)")
        .option("--language <lang>", "splitter language code (e.g. 'en')")
        .option("--splitter <type>", "splitter type: sentencex (default) | simple")
        .option("--settings <path>", "path to JSON file with ExtractionSettings")
        .option("--graphics-layer-mode <mode>", "graphics layer probe mode: off | auto | on")
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

                const captured = await captureExpected(deps, bytes, config);
                const expected = captured.expected;
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
                    validateFixture(candidate, `${loc.fixtureJson}#`);
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
                    validateFixture(fixture, `${loc.fixtureJson}#`);
                    writeFixtureFile(loc, fixture);
                    wrote = true;
                }

                const previewPaths = opts.preview
                    ? await renderPreviewsForFixture(
                          deps,
                          bytes,
                          loc.folder,
                          captured.structured,
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
                    pageCount: expected.structured.pages.length,
                    sentenceCount: countStructuredSentences(expected.structured.pages),
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
    graphicsLayerMode?: string;
    paragraphSettings?: string;
    bboxTolerance?: string;
    update?: boolean;
    allowOcr?: boolean;
    preview?: boolean;
    json?: boolean;
    pretty?: boolean;
}

async function buildConfigFromCaptureOpts(opts: CaptureOpts): Promise<FixtureConfig> {
    const pageIndices = parsePagesList(opts.pages).sort((a, b) => a - b);
    const scope = scopeFromCliFlags({
        analysisScopeFlag: opts.analysisScope,
        analysisWindowFlag:
            opts.analysisWindow != null
                ? parseAnalysisWindow(opts.analysisWindow)
                : undefined,
    });
    const splitterConfig = buildSplitterConfig(opts.splitter, opts.language);
    const loadedSettings = opts.settings
        ? await loadJsonFile<ExtractionSettings>(opts.settings)
        : ({} as ExtractionSettings);
    const settings =
        applyGraphicsLayerMode(loadedSettings, opts.graphicsLayerMode) ??
        ({} as ExtractionSettings);
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
            defaultRootHelp(),
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

                const actual = await captureExpected(deps, pdfBytes, fixture.config);
                const structuredDiffs = prefixDiffs(
                    "structured.",
                    diffStructuredPages(
                        fixture.expected.structured.pages,
                        actual.expected.structured.pages,
                        { bboxAbsPt: tol },
                    ),
                );
                const markdownDiffs = prefixDiffs(
                    "markdown.",
                    diffMarkdownPages(
                        fixture.expected.markdown.pages,
                        actual.expected.markdown.pages,
                        {},
                    ),
                );
                const diffs = [...structuredDiffs, ...markdownDiffs];

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
            defaultRootHelp(),
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
                const captured = await captureExpected(deps, pdfBytes, previous.config);
                const expected = captured.expected;
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
                validateFixture(candidate, `${loc.fixtureJson}#`);
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
                          captured.structured,
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
// fixture migrate <id>
// ---------------------------------------------------------------------------

function buildMigrateCommand(deps: CliDeps): Command {
    const cmd = new Command("migrate");
    cmd.description("Re-extract a legacy fixture into the current fixture schema.")
        .argument("<id>", "fixture id (folder name)")
        .option(
            "--root <dir>",
            defaultRootHelp(),
        )
        .option("--json", "emit a structured JSON envelope")
        .option("--pretty", "pretty-print JSON output (only with --json)")
        .action(async (id: string, opts: MigrateOpts) => {
            const root = opts.root
                ? resolvePath(process.cwd(), opts.root)
                : resolveDefaultRoot();
            const loc = fixtureLocation(root, id);
            const effective: Record<string, unknown> = { id, root };
            try {
                const parsed = parseRawFixtureFile(loc.fixtureJson);
                const raw = expectRawObject(parsed, `${loc.fixtureJson}#`);
                const fromSchema = typeof raw.schema === "number" ? raw.schema : null;
                const parsedId = expectRawString(raw.id, `${loc.fixtureJson}#.id`);
                if (parsedId !== id) {
                    throw new Error(
                        `${loc.fixtureJson}#.id: expected "${id}", got "${parsedId}"`,
                    );
                }
                const pdfSha256 = expectRawString(
                    raw.pdfSha256,
                    `${loc.fixtureJson}#.pdfSha256`,
                );
                if (!/^[0-9a-f]{64}$/.test(pdfSha256)) {
                    throw new FixtureValidationError(
                        `${loc.fixtureJson}#.pdfSha256: not a 64-char lowercase hex string`,
                    );
                }
                const capturedAt = expectRawString(
                    raw.capturedAt,
                    `${loc.fixtureJson}#.capturedAt`,
                );
                const config = validateConfig(raw.config, `${loc.fixtureJson}#.config`);
                const tolerance = readLegacyTolerance(raw.tolerance, loc.fixtureJson);
                const pdfBytes = readSharedPdf(root, pdfSha256);
                const captured = await captureExpected(deps, pdfBytes, config);
                const fingerprints = captureFingerprints();
                const now = new Date().toISOString();
                const candidate: CapturedFixture = {
                    schema: FIXTURE_SCHEMA_VERSION,
                    id,
                    capturedAt,
                    updatedAt: now,
                    pdfSha256,
                    pdfBytes: pdfBytes.byteLength,
                    config,
                    fingerprints,
                    tolerance,
                    expected: captured.expected,
                };
                validateFixture(candidate, `${loc.fixtureJson}#`);

                let wrote = false;
                if (fromSchema === FIXTURE_SCHEMA_VERSION) {
                    const previous = validateFixture(parsed, `${loc.fixtureJson}#`);
                    if (!semanticallyEqual(previous, candidate)) {
                        writeFixtureFile(loc, candidate);
                        wrote = true;
                    }
                } else {
                    writeFixtureFile(loc, candidate);
                    wrote = true;
                }

                const sourcePdfLink = ensureSourcePdfLink(loc, pdfSha256, (msg) =>
                    deps.stderr.write(`[${id}] warning: ${msg}\n`),
                );
                const result = {
                    id,
                    root,
                    fromSchema,
                    toSchema: FIXTURE_SCHEMA_VERSION,
                    wrote,
                    sourcePdfLink,
                    capturedAt,
                    updatedAt: wrote ? candidate.updatedAt : raw.updatedAt,
                };
                if (opts.json) {
                    deps.stdout.write(
                        JSON.stringify(
                            { ok: true, input: { fixtureId: id, root }, result },
                            null,
                            opts.pretty ? 2 : 0,
                        ) + "\n",
                    );
                } else {
                    deps.stdout.write(
                        `${id}: migrated schema ${fromSchema ?? "unknown"} -> ${FIXTURE_SCHEMA_VERSION}${wrote ? "" : " (no changes)"}\n`,
                    );
                }
            } catch (e) {
                emitFailure(deps, opts, id, undefined, effective, e);
            }
        });
    return cmd;
}

interface MigrateOpts {
    root?: string;
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
            defaultRootHelp(),
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

async function captureExpected(
    deps: CliDeps,
    pdfBytes: Uint8Array,
    config: FixtureConfig,
): Promise<{ expected: ExpectedExtraction; structured: StructuredExtractResult }> {
    const structured = await deps.api.extractPdf(buildStructuredExtractInput(pdfBytes, config));
    if (structured.mode !== "structured") {
        throw new Error("fixture extraction expected a structured result");
    }
    const structuredPages = selectPages(
        structured.document.pages,
        config.pageIndices,
    );

    const markdown = await deps.api.extractPdf(buildMarkdownExtractInput(pdfBytes, config));
    if (markdown.mode !== "markdown") {
        throw new Error("fixture extraction expected a markdown result");
    }
    const markdownPages = selectPages(markdown.document.pages, config.pageIndices);

    return {
        expected: {
            structured: { pages: structuredPages },
            markdown: { pages: markdownPages },
        },
        structured,
    };
}

function selectPages<T extends { index: number }>(pages: T[], pageIndices: number[]): T[] {
    const selected = new Set(pageIndices);
    return pages
        .filter((page) => selected.has(page.index))
        .sort((a, b) => a.index - b.index);
}

function countStructuredSentences(pages: StructuredPage[]): number {
    return pages.reduce(
        (total, page) =>
            total +
            page.items.reduce(
                (pageTotal, item) =>
                    pageTotal + ("sentences" in item ? item.sentences?.length ?? 0 : 0),
                0,
            ),
        0,
    );
}

function prefixDiffs(prefix: string, diffs: SnapshotDiff[]): SnapshotDiff[] {
    return diffs.map((diff) => ({ ...diff, path: `${prefix}${diff.path}` }));
}

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
    result: StructuredExtractResult | any,
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
        const page = "document" in result
            ? result.document.pages.find((p: StructuredPage) => p.index === pageIndex)
            : result.pages.find((p: InternalProcessedPage) => p.index === pageIndex);
        if (!renderedPage || !page) continue;
        const ppage = "document" in result
            ? internalPageFromStructuredPage(page)
            : page;
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

function buildStructuredExtractInput(pdfBytes: Uint8Array, config: FixtureConfig): ExtractInput {
    return {
        pdfData: pdfBytes,
        mode: "structured",
        analysisWindow: resolveAnalysisWindow(config.analysisScope),
        settings: config.settings,
        paragraphSettings: config.paragraphSettings,
        structured: { splitterConfig: config.splitterConfig },
    };
}

function buildMarkdownExtractInput(pdfBytes: Uint8Array, config: FixtureConfig): ExtractInput {
    return {
        pdfData: pdfBytes,
        mode: "markdown",
        analysisWindow: resolveAnalysisWindow(config.analysisScope),
        pageIndices: config.pageIndices,
        settings: config.settings,
        paragraphSettings: config.paragraphSettings,
    };
}

function internalPageFromStructuredPage(page: StructuredPage): InternalProcessedPage {
    return {
        index: page.index,
        label: page.label,
        width: page.width,
        height: page.height,
        content: page.items
            .map((item) => ("text" in item ? item.text : ""))
            .filter(Boolean)
            .join("\n\n"),
        columns: [],
        items: page.items.map((item) => ({
            id: item.id,
            pageIndex: item.pageIndex,
            index: item.order,
            bbox: {
                l: item.bbox[0],
                t: item.bbox[1],
                r: item.bbox[2],
                b: item.bbox[3],
                origin: "top-left" as const,
            },
            columnIndex: 0,
            kind: item.kind,
            ...("text" in item ? { text: item.text, lines: [] } : {}),
            ...("level" in item ? { level: item.level } : {}),
        })) as InternalProcessedPage["items"],
        sentences: page.items.flatMap((item) =>
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

function parseRawFixtureFile(path: string): unknown {
    if (!existsSync(path)) {
        throw new Error(`fixture not found: ${path}`);
    }
    const raw = readFileSync(path, "utf8");
    try {
        return JSON.parse(raw) as unknown;
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`failed to parse JSON in ${path}: ${msg}`);
    }
}

function expectRawObject(value: unknown, source: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new FixtureValidationError(`${source}: expected object`);
    }
    return value as Record<string, unknown>;
}

function expectRawString(value: unknown, source: string): string {
    if (typeof value !== "string") {
        throw new FixtureValidationError(`${source}: expected string`);
    }
    return value;
}

function readLegacyTolerance(
    value: unknown,
    fixtureJson: string,
): { bboxAbsPt: number } {
    if (value === undefined) return { bboxAbsPt: DEFAULT_BBOX_TOL_PT };
    try {
        return validateTolerance(value, `${fixtureJson}#.tolerance`);
    } catch {
        return { bboxAbsPt: DEFAULT_BBOX_TOL_PT };
    }
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
