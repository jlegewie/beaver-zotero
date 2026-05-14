/**
 * JSON envelope for CLI commands.
 *
 * Every `--json` output is wrapped in `{ ok, input, options, result }` for
 * success or `{ ok: false, error }` for failure. Matches the contract in
 * the implementation plan; preserves the useful `ExtractionError` fields
 * (`code`, `message`, `details`, `pageLabels`, `pageCount`) that the
 * dev-only HTTP handlers expose today.
 *
 * Render's `--json` envelope does NOT inline PNG bytes — the per-page
 * result includes `path`, `width`, `height`, `byteLength`, `sha256`. The
 * only opt-in to base64 is via the explicit `--inline-base64` flag on
 * the render command itself.
 */
import { ExtractionError } from "../types";
import { pdfSha256 } from "./io";

export interface InputDescriptor {
    file: string;
    pdfSha256: string;
    pdfBytes: number;
}

export interface SuccessEnvelope<T = unknown> {
    ok: true;
    input: InputDescriptor;
    options: Record<string, unknown>;
    result: T;
}

export interface ErrorEnvelope {
    ok: false;
    input?: InputDescriptor;
    options?: Record<string, unknown>;
    error: {
        name: string;
        code?: string;
        message: string;
        payload?: unknown;
    };
}

export function buildInputDescriptor(
    file: string,
    bytes: Uint8Array,
): InputDescriptor {
    return {
        file,
        pdfSha256: pdfSha256(bytes),
        pdfBytes: bytes.byteLength,
    };
}

export function buildSuccessEnvelope<T>(
    file: string,
    bytes: Uint8Array,
    options: Record<string, unknown>,
    result: T,
): SuccessEnvelope<T> {
    return {
        ok: true,
        input: buildInputDescriptor(file, bytes),
        options,
        result,
    };
}

export function buildErrorEnvelope(
    err: unknown,
    file?: string,
    bytes?: Uint8Array,
    options?: Record<string, unknown>,
): ErrorEnvelope {
    const env: ErrorEnvelope = {
        ok: false,
        error: errorToWire(err),
    };
    if (file && bytes) env.input = buildInputDescriptor(file, bytes);
    if (options) env.options = options;
    return env;
}

function errorToWire(err: unknown): ErrorEnvelope["error"] {
    if (err instanceof ExtractionError) {
        return {
            name: "ExtractionError",
            code: err.code,
            message: err.message,
            payload: {
                details: err.details,
                pageLabels: err.pageLabels,
                pageCount: err.pageCount,
            },
        };
    }
    if (err && typeof err === "object" && (err as { name?: string }).name === "ExtractionError") {
        const e = err as {
            name?: string;
            code?: string;
            message?: string;
            payload?: unknown;
        };
        return {
            name: "ExtractionError",
            code: e.code,
            message: e.message ?? String(err),
            payload: e.payload,
        };
    }
    if (err instanceof Error) {
        return { name: err.name, message: err.message };
    }
    return { name: "Error", message: String(err) };
}

export function stringifyEnvelope(
    env: SuccessEnvelope | ErrorEnvelope,
    pretty: boolean,
): string {
    return pretty ? JSON.stringify(env, null, 2) : JSON.stringify(env);
}
