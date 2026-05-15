/**
 * Shared CLI envelope helpers used by every `fixture` / `ocr-fixture`
 *
 * Pure envelope plumbing — no domain knowledge of fixtures or OCR. The
 * fingerprint-warning rendering stays close to the fingerprint type it
 * consumes (see `fixture/fingerprints.ts` and `fixture/ocrFingerprints.ts`).
 */
import { InvalidArgumentError } from "commander";

import type { CliDeps } from "../runCliTypes";
import {
    buildErrorEnvelope,
    buildSuccessEnvelope,
    stringifyEnvelope,
} from "../envelope";

export function parsePositiveFloat(name: string, raw: string): number {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
        throw new InvalidArgumentError(
            `${name} must be a non-negative finite number, got "${raw}"`,
        );
    }
    return n;
}

export function errToWire(err: unknown): { name: string; message: string } {
    if (err instanceof Error) return { name: err.name, message: err.message };
    return { name: "Error", message: String(err) };
}

export function renderSuccessPlain(deps: CliDeps, result: unknown): void {
    if (result && typeof result === "object") {
        const r = result as Record<string, unknown>;
        const lines: string[] = [];
        if ("fixtureJson" in r) lines.push(`wrote ${String(r.fixtureJson)}`);
        if ("ocrJson" in r) lines.push(`wrote ${String(r.ocrJson)}`);
        if ("pageCount" in r && "sentenceCount" in r) {
            lines.push(`pages: ${r.pageCount}, sentences: ${r.sentenceCount}`);
        }
        if ("needsOCR" in r) lines.push(`needsOCR=${r.needsOCR}`);
        if ("wrote" in r) lines.push(`wrote=${r.wrote}`);
        if ("capturedAt" in r) lines.push(`capturedAt=${r.capturedAt}`);
        if ("updatedAt" in r) lines.push(`updatedAt=${r.updatedAt}`);
        deps.stdout.write(lines.join("\n") + "\n");
    } else {
        deps.stdout.write(String(result) + "\n");
    }
}

export function emitSuccess(
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

export function emitFailure(
    deps: CliDeps,
    opts: { json?: boolean; pretty?: boolean },
    file: string,
    bytes: Uint8Array | undefined,
    effective: Record<string, unknown>,
    err: unknown,
): void {
    const env = bytes
        ? buildErrorEnvelope(err, file, bytes, effective)
        : {
              ok: false as const,
              input: { file },
              options: effective,
              error: errToWire(err),
          };
    deps.stderr.write(stringifyEnvelope(env as never, !!opts.pretty) + "\n");
    process.exitCode = 1;
}
