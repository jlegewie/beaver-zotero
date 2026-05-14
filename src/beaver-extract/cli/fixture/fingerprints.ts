/**
 * Fingerprint helpers for fixture provenance.
 *
 * Captured `fingerprints` are stored on every fixture so the evaluator can
 * surface drift causes:
 *  - WASM SHA mismatch is the *real* cause of bbox jitter (most common
 *    failure mode after a bump). Warn loudly.
 *  - `extractorVersion` mismatch signals an intentional package bump.
 *  - `extractorGitSha` mismatch is constant during normal dev work; show
 *    only with `--verbose` or in the diagnostics block.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { defaultWasmDir, repoRoot as defaultRepoRoot } from "../../node/paths";

export interface Fingerprints {
    extractorGitSha: string | null;
    extractorVersion: string | null;
    mupdfWasmSha256: string;
    sentencexWasmSha256: string;
}

/** Compute fingerprints from the local repo + bundled WASM artifacts. */
export function captureFingerprints(args?: {
    wasmDir?: string;
    repoRoot?: string;
}): Fingerprints {
    const wasmDir = args?.wasmDir ?? defaultWasmDir;
    const repoRoot = args?.repoRoot ?? defaultRepoRoot;
    const mupdfWasmSha256 = sha256File(join(wasmDir, "mupdf-wasm.wasm"));
    const sentencexWasmSha256 = sha256File(
        join(wasmDir, "sentencex/sentencex_wasm_bg.wasm"),
    );
    return {
        extractorGitSha: tryReadGitSha(repoRoot),
        extractorVersion: tryReadPackageVersion(repoRoot),
        mupdfWasmSha256,
        sentencexWasmSha256,
    };
}

function sha256File(path: string): string {
    const bytes = readFileSync(path);
    return createHash("sha256").update(bytes).digest("hex");
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
        // Not a git checkout, or git unavailable — fingerprint stays null.
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

/**
 * Compare two fingerprints. Returns the categorized differences for the
 * evaluator to render with the right verbosity policy.
 */
export interface FingerprintDiff {
    /** Loud — WASM bytes drift causes coordinate drift. */
    wasm: Array<{ kind: "mupdf" | "sentencex"; expected: string; actual: string }>;
    /** Loud — package bump signals intentional change. */
    version: { expected: string | null; actual: string | null } | null;
    /** Quiet by default — git SHAs change constantly during dev. */
    gitSha: { expected: string | null; actual: string | null } | null;
}

export function diffFingerprints(
    expected: Fingerprints,
    actual: Fingerprints,
): FingerprintDiff {
    const wasm: FingerprintDiff["wasm"] = [];
    if (expected.mupdfWasmSha256 !== actual.mupdfWasmSha256) {
        wasm.push({
            kind: "mupdf",
            expected: expected.mupdfWasmSha256,
            actual: actual.mupdfWasmSha256,
        });
    }
    if (expected.sentencexWasmSha256 !== actual.sentencexWasmSha256) {
        wasm.push({
            kind: "sentencex",
            expected: expected.sentencexWasmSha256,
            actual: actual.sentencexWasmSha256,
        });
    }
    return {
        wasm,
        version:
            expected.extractorVersion === actual.extractorVersion
                ? null
                : { expected: expected.extractorVersion, actual: actual.extractorVersion },
        gitSha:
            expected.extractorGitSha === actual.extractorGitSha
                ? null
                : { expected: expected.extractorGitSha, actual: actual.extractorGitSha },
    };
}
