/**
 * `beaver-extract ocr-fixture …` — capture, evaluate, and rebaseline
 * regression fixtures for `analyzeOCRNeeds`.
 *
 * Subcommands mirror the structured-extract fixture group:
 *   capture <pdf>       create or replace (mutating)
 *   evaluate <id>       read-only — diff captured against fresh
 *   update <id>         rebaseline preserving captured config (mutating)
 *   list                discover fixture ids under a corpus root
 *
 * Shares `_shared/<sha>.pdf` storage and corpus roots with the extract
 * fixtures but uses `ocr.json` as the per-fixture file. Folder ids are
 * paperKey-only (no `__pN` suffix) because OCR detection is document-wide.
 */
import { Command } from "commander";
import { join, resolve as resolvePath } from "node:path";
import { existsSync } from "node:fs";

import type { CliDeps } from "../runCliTypes";
import { emitFailure, emitSuccess, parsePositiveFloat } from "./_sharedHelpers";
import { loadJsonFile } from "../options";
import {
    PUBLIC_FIXTURE_ROOT_REL,
    ensureSharedPdf,
    ensureSourcePdfLink,
    readSharedPdf,
    sharedPdfPath,
} from "../fixture/fixtureFile";
import {
    listOcrFixtureIds,
    ocrFixtureLocation,
    readOcrFixture,
    semanticallyEqualOcr,
    writeOcrFixtureFile,
} from "../fixture/ocrFixtureFile";
import {
    OCR_FIXTURE_SCHEMA_VERSION,
    type CapturedOcrFixture,
} from "../fixture/ocrFixtureSchema";
import {
    captureOcrFingerprints,
    diffOcrFingerprints,
    emitOcrFingerprintWarnings,
} from "../fixture/ocrFingerprints";
import {
    diffOcrSnapshots,
    formatOcrDiffs,
    mergeEffectiveOptions,
    projectOcrSnapshot,
} from "../../debug/ocrSnapshot";
import type { OCRDetectionOptions } from "../../types";

const DEFAULT_ISSUE_RATIO_TOL = 0.02;
const DEFAULT_TEXT_LENGTH_TOL = 5;

function resolveDefaultRoot(): string {
    return resolvePath(process.cwd(), PUBLIC_FIXTURE_ROOT_REL);
}

// ---------------------------------------------------------------------------
// Top-level builder
// ---------------------------------------------------------------------------

export function buildOcrFixtureCommand(deps: CliDeps): Command {
    const cmd = new Command("ocr-fixture");
    cmd.description("Capture, evaluate, or rebaseline an OCR-detection fixture.");
    cmd.addCommand(buildCaptureCommand(deps));
    cmd.addCommand(buildEvaluateCommand(deps));
    cmd.addCommand(buildUpdateCommand(deps));
    cmd.addCommand(buildListCommand(deps));
    return cmd;
}

// ---------------------------------------------------------------------------
// ocr-fixture capture <pdf>
// ---------------------------------------------------------------------------

interface CaptureOpts {
    id: string;
    options?: string;
    issueRatioTolerance?: string;
    textLengthTolerance?: string;
    update?: boolean;
    notes?: string;
    root?: string;
    json?: boolean;
    pretty?: boolean;
}

function buildCaptureCommand(deps: CliDeps): Command {
    const cmd = new Command("capture");
    cmd.description("Capture (or with --update, replace) an OCR fixture from a PDF.")
        .argument("<pdf>", "path to the PDF file")
        .requiredOption("--id <id>", "fixture id (folder name — paperKey, no __pN suffix)")
        .option("--options <path>", "path to JSON file with OCRDetectionOptions overrides")
        .option(
            "--issue-ratio-tolerance <n>",
            `stored absolute tolerance for issueRatio (default ${DEFAULT_ISSUE_RATIO_TOL})`,
        )
        .option(
            "--text-length-tolerance <n>",
            `stored absolute tolerance for per-page textLength (default ${DEFAULT_TEXT_LENGTH_TOL})`,
        )
        .option(
            "--root <dir>",
            `corpus root (default: ${PUBLIC_FIXTURE_ROOT_REL})`,
        )
        .option(
            "--update",
            "allow replacing an existing fixture",
        )
        .option("--notes <text>", "human-readable notes (e.g. \"false positive\")")
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
                if (opts.id.includes("__p")) {
                    throw new Error(
                        `--id "${opts.id}" contains "__p" — OCR fixture ids are paperKey-only so they don't collide with extract fixtures (paperKey__pN)`,
                    );
                }

                const overrides = opts.options
                    ? await loadJsonFile<OCRDetectionOptions>(opts.options)
                    : ({} as OCRDetectionOptions);
                const effectiveOptions = mergeEffectiveOptions(overrides);

                const issueRatioAbs =
                    opts.issueRatioTolerance != null
                        ? parsePositiveFloat(
                              "--issue-ratio-tolerance",
                              opts.issueRatioTolerance,
                          )
                        : DEFAULT_ISSUE_RATIO_TOL;
                const textLengthAbs =
                    opts.textLengthTolerance != null
                        ? parsePositiveInt(
                              "--text-length-tolerance",
                              opts.textLengthTolerance,
                          )
                        : DEFAULT_TEXT_LENGTH_TOL;

                effective.config = { options: overrides };

                bytes = await deps.loadPdf(pdfPath);
                const sha = ensureSharedPdf(root, bytes);
                effective.pdfSha256 = sha;

                const loc = ocrFixtureLocation(root, opts.id);
                guardExtractFixtureCollision(loc.folder);

                const exists = existsSync(loc.ocrJson);
                if (exists && !opts.update) {
                    throw new Error(
                        `OCR fixture exists at ${loc.ocrJson}; pass --update to replace it`,
                    );
                }

                const result = await deps.api.analyzeOCRNeeds(bytes, overrides);
                const snapshot = projectOcrSnapshot(result);
                const fingerprints = captureOcrFingerprints();

                const now = new Date().toISOString();
                let fixture: CapturedOcrFixture;
                let wrote = false;
                if (exists) {
                    const previous = readOcrFixture(root, opts.id);
                    const candidate: CapturedOcrFixture = {
                        schema: OCR_FIXTURE_SCHEMA_VERSION,
                        id: opts.id,
                        capturedAt: previous.capturedAt,
                        updatedAt: now,
                        pdfSha256: sha,
                        pdfBytes: bytes.byteLength,
                        config: { options: overrides, effectiveOptions },
                        fingerprints,
                        tolerance: { issueRatioAbs, textLengthAbs },
                        expected: snapshot,
                    };
                    if (opts.notes != null) candidate.notes = opts.notes;
                    else if (previous.notes != null) candidate.notes = previous.notes;
                    if (semanticallyEqualOcr(previous, candidate)) {
                        fixture = previous;
                    } else {
                        fixture = candidate;
                        writeOcrFixtureFile(loc, fixture);
                        wrote = true;
                    }
                } else {
                    fixture = {
                        schema: OCR_FIXTURE_SCHEMA_VERSION,
                        id: opts.id,
                        capturedAt: now,
                        updatedAt: now,
                        pdfSha256: sha,
                        pdfBytes: bytes.byteLength,
                        config: { options: overrides, effectiveOptions },
                        fingerprints,
                        tolerance: { issueRatioAbs, textLengthAbs },
                        expected: snapshot,
                    };
                    if (opts.notes != null) fixture.notes = opts.notes;
                    writeOcrFixtureFile(loc, fixture);
                    wrote = true;
                }

                const sourcePdfLink = ensureSourcePdfLink(loc, sha, (msg) =>
                    deps.stderr.write(`[${opts.id}] warning: ${msg}\n`),
                );

                emitSuccess(deps, opts, pdfPath, bytes, effective, {
                    folder: loc.folder,
                    ocrJson: loc.ocrJson,
                    sharedPdf: sharedPdfPath(root, sha),
                    sourcePdfLink,
                    needsOCR: snapshot.needsOCR,
                    primaryReason: snapshot.primaryReason,
                    wrote,
                    capturedAt: fixture.capturedAt,
                    updatedAt: fixture.updatedAt,
                });
            } catch (e) {
                emitFailure(deps, opts, pdfPath, bytes, effective, e);
            }
        });
    return cmd;
}

// ---------------------------------------------------------------------------
// ocr-fixture evaluate <id>
// ---------------------------------------------------------------------------

interface EvaluateOpts {
    root?: string;
    issueRatioTolerance?: string;
    textLengthTolerance?: string;
    verbose?: boolean;
    json?: boolean;
    pretty?: boolean;
}

function buildEvaluateCommand(deps: CliDeps): Command {
    const cmd = new Command("evaluate");
    cmd.description(
        "Re-run analyzeOCRNeeds with the captured config and diff against expected. Read-only.",
    )
        .argument("<id>", "fixture id (folder name)")
        .option(
            "--root <dir>",
            `corpus root (default: ${PUBLIC_FIXTURE_ROOT_REL})`,
        )
        .option(
            "--issue-ratio-tolerance <n>",
            "override stored issueRatio tolerance",
        )
        .option(
            "--text-length-tolerance <n>",
            "override stored textLength tolerance",
        )
        .option("--verbose", "surface git-SHA fingerprint mismatches")
        .option("--json", "emit a structured JSON envelope")
        .option("--pretty", "pretty-print JSON output (only with --json)")
        .action(async (id: string, opts: EvaluateOpts) => {
            const root = opts.root
                ? resolvePath(process.cwd(), opts.root)
                : resolveDefaultRoot();
            const effective: Record<string, unknown> = { id, root };
            try {
                const fixture = readOcrFixture(root, id);
                const pdfBytes = readSharedPdf(root, fixture.pdfSha256);
                const issueRatioAbs =
                    opts.issueRatioTolerance != null
                        ? parsePositiveFloat(
                              "--issue-ratio-tolerance",
                              opts.issueRatioTolerance,
                          )
                        : fixture.tolerance.issueRatioAbs;
                const textLengthAbs =
                    opts.textLengthTolerance != null
                        ? parsePositiveInt(
                              "--text-length-tolerance",
                              opts.textLengthTolerance,
                          )
                        : fixture.tolerance.textLengthAbs;

                const result = await deps.api.analyzeOCRNeeds(
                    pdfBytes,
                    fixture.config.options,
                );
                const snapshot = projectOcrSnapshot(result);
                const effectiveOptions = mergeEffectiveOptions(
                    fixture.config.options,
                );

                const diffs = diffOcrSnapshots(
                    fixture,
                    { snapshot, effectiveOptions },
                    { issueRatioAbs, textLengthAbs },
                );

                const fpDiff = diffOcrFingerprints(
                    fixture.fingerprints,
                    captureOcrFingerprints(),
                );
                emitOcrFingerprintWarnings(deps, id, fpDiff, !!opts.verbose);

                const ok = diffs.length === 0;
                if (opts.json) {
                    const envelope = {
                        ok,
                        input: { fixtureId: id, root },
                        options: {
                            issueRatioAbs,
                            textLengthAbs,
                            verbose: !!opts.verbose,
                        },
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
                    deps.stdout.write(formatOcrDiffs(id, diffs) + "\n");
                }
                if (!ok) process.exitCode = 1;
            } catch (e) {
                emitFailure(deps, opts, id, undefined, effective, e);
            }
        });
    return cmd;
}

// ---------------------------------------------------------------------------
// ocr-fixture update <id>
// ---------------------------------------------------------------------------

interface UpdateOpts {
    root?: string;
    notes?: string;
    clearNotes?: boolean;
    json?: boolean;
    pretty?: boolean;
}

function buildUpdateCommand(deps: CliDeps): Command {
    const cmd = new Command("update");
    cmd.description(
        "Rebaseline an OCR fixture's expected snapshot. Preserves the stored config and notes by default.",
    )
        .argument("<id>", "fixture id (folder name)")
        .option(
            "--root <dir>",
            `corpus root (default: ${PUBLIC_FIXTURE_ROOT_REL})`,
        )
        .option("--notes <text>", "replace the stored notes field")
        .option("--clear-notes", "remove the stored notes field")
        .option("--json", "emit a structured JSON envelope")
        .option("--pretty", "pretty-print JSON output (only with --json)")
        .action(async (id: string, opts: UpdateOpts) => {
            const root = opts.root
                ? resolvePath(process.cwd(), opts.root)
                : resolveDefaultRoot();
            const effective: Record<string, unknown> = { id, root };
            try {
                if (opts.notes != null && opts.clearNotes) {
                    throw new Error(
                        "--notes and --clear-notes are mutually exclusive",
                    );
                }
                const previous = readOcrFixture(root, id);
                const pdfBytes = readSharedPdf(root, previous.pdfSha256);
                const result = await deps.api.analyzeOCRNeeds(
                    pdfBytes,
                    previous.config.options,
                );
                const expected = projectOcrSnapshot(result);
                const effectiveOptions = mergeEffectiveOptions(
                    previous.config.options,
                );
                const fingerprints = captureOcrFingerprints();

                const now = new Date().toISOString();
                const candidate: CapturedOcrFixture = {
                    ...previous,
                    schema: OCR_FIXTURE_SCHEMA_VERSION,
                    expected,
                    fingerprints,
                    config: {
                        options: previous.config.options,
                        effectiveOptions,
                    },
                    updatedAt: now,
                };
                if (opts.clearNotes) delete candidate.notes;
                else if (opts.notes != null) candidate.notes = opts.notes;

                const loc = ocrFixtureLocation(root, id);
                let wrote = false;
                if (!semanticallyEqualOcr(previous, candidate)) {
                    writeOcrFixtureFile(loc, candidate);
                    wrote = true;
                }

                const sourcePdfLink = ensureSourcePdfLink(
                    loc,
                    previous.pdfSha256,
                    (msg) => deps.stderr.write(`[${id}] warning: ${msg}\n`),
                );

                emitSuccess(deps, opts, id, undefined, effective, {
                    id,
                    wrote,
                    sourcePdfLink,
                    needsOCR: expected.needsOCR,
                    primaryReason: expected.primaryReason,
                    capturedAt: previous.capturedAt,
                    updatedAt: wrote ? candidate.updatedAt : previous.updatedAt,
                });
            } catch (e) {
                emitFailure(deps, opts, id, undefined, effective, e);
            }
        });
    return cmd;
}

// ---------------------------------------------------------------------------
// ocr-fixture list
// ---------------------------------------------------------------------------

function buildListCommand(deps: CliDeps): Command {
    const cmd = new Command("list");
    cmd.description("List OCR fixture ids under a corpus root.")
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
            const ids = listOcrFixtureIds(root);
            if (opts.json) {
                deps.stdout.write(
                    JSON.stringify(
                        { ok: true, input: { root }, result: { ids } },
                        null,
                        opts.pretty ? 2 : 0,
                    ) + "\n",
                );
            } else if (ids.length === 0) {
                deps.stdout.write(`(no OCR fixtures under ${root})\n`);
            } else {
                for (const id of ids) deps.stdout.write(id + "\n");
            }
        });
    return cmd;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parsePositiveInt(name: string, raw: string): number {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) {
        throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
    }
    return n;
}

/**
 * OCR fixture ids must not collide with extract fixture folders. The
 * convention is paperKey-only for OCR vs paperKey__pN for extract, but a
 * mistaken `--id paperKey__p0` would otherwise overwrite the extract
 * fixture's folder. Belt-and-suspenders: reject any id whose target folder
 * already holds a `fixture.json`.
 */
function guardExtractFixtureCollision(folder: string): void {
    if (existsSync(join(folder, "fixture.json"))) {
        throw new Error(
            `target folder ${folder} already holds an extract fixture (fixture.json); refusing to co-locate`,
        );
    }
}
