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
import { Command, InvalidArgumentError } from "commander";

import type { CliDeps } from "../runCliTypes";
import {
    buildErrorEnvelope,
    buildSuccessEnvelope,
    stringifyEnvelope,
} from "../envelope";
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
    type Fingerprints,
} from "../fixture/fingerprints";
import {
    PUBLIC_FIXTURE_ROOT_REL,
    ensureSharedPdf,
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
import type { ExtractInput } from "../../node/api";
import type { ExtractionSettings } from "../../types";
import type { ParagraphDetectionSettings } from "../../ParagraphDetector";
import type { SentenceSplitterConfig } from "../../sentenceTypes";
import { join, resolve as resolvePath } from "node:path";
import { existsSync } from "node:fs";

const DEFAULT_BBOX_TOL_PT = 0.5;

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
                }

                emitSuccess(deps, opts, pdfPath, bytes, effective, {
                    folder: loc.folder,
                    fixtureJson: loc.fixtureJson,
                    sharedPdf: sharedPdfPath(root, sha),
                    pageCount: expected.perPage.length,
                    sentenceCount: expected.totals.sentenceCount,
                    wrote: !exists || !semanticallyEqual(readFixture(root, opts.id), {
                        ...fixture,
                        // Force the comparison after the write to detect a true no-op
                        // (this branch only matters when exists && wrote)
                    }),
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
                let wrote = false;
                if (!semanticallyEqual(previous, candidate)) {
                    const loc = fixtureLocation(root, id);
                    writeFixtureFile(loc, candidate);
                    wrote = true;
                }
                emitSuccess(deps, opts, id, undefined, effective, {
                    id,
                    wrote,
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

function parsePositiveFloat(name: string, raw: string): number {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
        throw new InvalidArgumentError(
            `${name} must be a non-negative finite number, got "${raw}"`,
        );
    }
    return n;
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

function emitSuccess(
    deps: CliDeps,
    opts: { json?: boolean; pretty?: boolean },
    file: string,
    bytes: Uint8Array | undefined,
    effective: Record<string, unknown>,
    result: unknown,
): void {
    if (opts.json) {
        if (bytes) {
            deps.stdout.write(
                stringifyEnvelope(
                    buildSuccessEnvelope(file, bytes, effective, result),
                    !!opts.pretty,
                ) + "\n",
            );
        } else {
            // No PDF bytes (evaluate / update / list) — emit a slim envelope
            // without InputDescriptor so we don't fabricate a sha.
            deps.stdout.write(
                JSON.stringify(
                    { ok: true, input: { file }, options: effective, result },
                    null,
                    opts.pretty ? 2 : 0,
                ) + "\n",
            );
        }
    } else {
        renderSuccessPlain(deps, result);
    }
}

function emitFailure(
    deps: CliDeps,
    opts: { json?: boolean; pretty?: boolean },
    file: string,
    bytes: Uint8Array | undefined,
    effective: Record<string, unknown>,
    err: unknown,
): void {
    const env = bytes
        ? buildErrorEnvelope(err, file, bytes, effective)
        : { ok: false as const, input: { file }, options: effective, error: errToWire(err) };
    deps.stderr.write(stringifyEnvelope(env as never, !!opts.pretty) + "\n");
    process.exitCode = 1;
}

function errToWire(err: unknown): { name: string; message: string } {
    if (err instanceof Error) return { name: err.name, message: err.message };
    return { name: "Error", message: String(err) };
}

function renderSuccessPlain(deps: CliDeps, result: unknown): void {
    if (result && typeof result === "object") {
        const r = result as Record<string, unknown>;
        const lines: string[] = [];
        if ("fixtureJson" in r) lines.push(`wrote ${String(r.fixtureJson)}`);
        if ("pageCount" in r && "sentenceCount" in r) {
            lines.push(`pages: ${r.pageCount}, sentences: ${r.sentenceCount}`);
        }
        if ("wrote" in r) lines.push(`wrote=${r.wrote}`);
        if ("capturedAt" in r) lines.push(`capturedAt=${r.capturedAt}`);
        if ("updatedAt" in r) lines.push(`updatedAt=${r.updatedAt}`);
        deps.stdout.write(lines.join("\n") + "\n");
    } else {
        deps.stdout.write(String(result) + "\n");
    }
}

// silence unused import warning when join() is unused above; keep available for
// future fixture-folder absolute-path display.
void join;
