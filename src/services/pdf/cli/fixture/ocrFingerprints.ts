/**
 * Fingerprint helpers for OCR fixture provenance.
 *
 * Distinct from `fingerprints.ts` (used by extract fixtures) because
 * `analyzeOCRNeeds` doesn't load sentencex — including a sentencex WASM
 * hash in OCR fixtures would falsely imply that bumping sentencex could
 * cause drift, which it can't. Same overall structure: a captured
 * snapshot, a diff helper that categorizes loud vs quiet drift, and a
 * stderr renderer.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { CliDeps } from "../runCliTypes";
import { defaultWasmDir, repoRoot as defaultRepoRoot } from "../../node/paths";
import type { OcrFingerprints } from "./ocrFixtureSchema";

// Re-export so existing callers (`commands/ocrFixture.ts`, tests) keep
// importing the type from this module — the schema file is the source of
// truth, but most code lives next to the runtime helpers.
export type { OcrFingerprints };

/** Compute fingerprints from the local repo + bundled MuPDF WASM. */
export function captureOcrFingerprints(args?: {
    wasmDir?: string;
    repoRoot?: string;
}): OcrFingerprints {
    const wasmDir = args?.wasmDir ?? defaultWasmDir;
    const repoRoot = args?.repoRoot ?? defaultRepoRoot;
    return {
        extractorGitSha: tryReadGitSha(repoRoot),
        extractorVersion: tryReadPackageVersion(repoRoot),
        mupdfWasmSha256: sha256File(join(wasmDir, "mupdf-wasm.wasm")),
    };
}

function sha256File(path: string): string {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function tryReadGitSha(repoRoot: string): string | null {
    try {
        const out = execFileSync("git", ["rev-parse", "--short=8", "HEAD"], {
            cwd: repoRoot,
            stdio: ["ignore", "pipe", "ignore"],
            encoding: "utf8",
        });
        const trimmed = out.trim();
        return trimmed.length > 0 ? trimmed : null;
    } catch {
        return null;
    }
}

function tryReadPackageVersion(repoRoot: string): string | null {
    try {
        const pkg = JSON.parse(
            readFileSync(join(repoRoot, "package.json"), "utf8"),
        ) as { version?: string };
        return pkg.version ?? null;
    } catch {
        return null;
    }
}

export interface OcrFingerprintDiff {
    /** Loud — MuPDF WASM drift causes detection drift. */
    mupdf: { expected: string; actual: string } | null;
    /** Loud — package bump signals intentional change. */
    version: { expected: string | null; actual: string | null } | null;
    /** Quiet by default — git SHAs change constantly during dev. */
    gitSha: { expected: string | null; actual: string | null } | null;
}

export function diffOcrFingerprints(
    expected: OcrFingerprints,
    actual: OcrFingerprints,
): OcrFingerprintDiff {
    return {
        mupdf:
            expected.mupdfWasmSha256 === actual.mupdfWasmSha256
                ? null
                : {
                      expected: expected.mupdfWasmSha256,
                      actual: actual.mupdfWasmSha256,
                  },
        version:
            expected.extractorVersion === actual.extractorVersion
                ? null
                : {
                      expected: expected.extractorVersion,
                      actual: actual.extractorVersion,
                  },
        gitSha:
            expected.extractorGitSha === actual.extractorGitSha
                ? null
                : {
                      expected: expected.extractorGitSha,
                      actual: actual.extractorGitSha,
                  },
    };
}

export function emitOcrFingerprintWarnings(
    deps: CliDeps,
    id: string,
    diff: OcrFingerprintDiff,
    verbose: boolean,
): void {
    if (diff.mupdf) {
        deps.stderr.write(
            `[${id}] warning: mupdf WASM SHA differs (expected ${diff.mupdf.expected.slice(0, 12)}…, got ${diff.mupdf.actual.slice(0, 12)}…)\n`,
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
