/**
 * Signed-URL transfer helpers for the OCR pipeline.
 *
 * The backend mints short-lived V4 signed URLs scoped to an exact GCS object;
 * the frontend PUTs the input scan and GETs the searchable PDF directly to/from
 * GCS.
 *
 * Bundle-neutral: plain `fetch`, no Supabase / React imports.
 */

import { logger } from '../../utils/logger';

const DEFAULT_RETRIES = 2;
const RETRY_DELAY_MS = 1_000;

export class SignedUrlTransferError extends Error {
    constructor(
        message: string,
        readonly status?: number,
    ) {
        super(message);
        this.name = 'SignedUrlTransferError';
    }
}

function isAbort(signal?: AbortSignal): boolean {
    return signal?.aborted === true;
}

/** Copy into a standalone ArrayBuffer so the request body is never a SAB view. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    return buffer;
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(new SignedUrlTransferError('aborted'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

/**
 * PUT bytes to a signed GCS upload URL. The `Content-Type` must match the type
 * the backend signed the URL with.
 */
export async function putBytesToSignedUrl(
    signedUrl: string,
    bytes: Uint8Array,
    options: {
        contentType?: string;
        signal?: AbortSignal;
        retries?: number;
    } = {},
): Promise<void> {
    const contentType = options.contentType ?? 'application/pdf';
    const maxRetries = options.retries ?? DEFAULT_RETRIES;

    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        if (isAbort(options.signal)) throw new SignedUrlTransferError('aborted');
        try {
            const response = await fetch(signedUrl, {
                method: 'PUT',
                // Blob keeps the request body type unambiguous and avoids SAB views.
                body: new Blob([toArrayBuffer(bytes)], { type: contentType }),
                headers: { 'Content-Type': contentType },
                signal: options.signal,
            });
            if (!response.ok) {
                throw new SignedUrlTransferError(
                    `signed PUT failed: ${response.status} ${response.statusText}`,
                    response.status,
                );
            }
            return;
        } catch (error) {
            if (isAbort(options.signal)) throw new SignedUrlTransferError('aborted');
            lastError = error;
            if (attempt < maxRetries) {
                logger(`putBytesToSignedUrl: attempt ${attempt + 1} failed, retrying: ${error}`, 2);
                await delay(RETRY_DELAY_MS * (attempt + 1), options.signal);
            }
        }
    }
    const detail = lastError instanceof Error ? lastError.message : String(lastError);
    throw new SignedUrlTransferError(`signed PUT failed after retries: ${detail}`);
}

/**
 * GET bytes from a signed GCS download URL into memory. Used to pull the
 * searchable PDF for transient re-extraction (never written to disk).
 */
export async function getBytesFromSignedUrl(
    signedUrl: string,
    options: { signal?: AbortSignal; retries?: number } = {},
): Promise<Uint8Array> {
    const maxRetries = options.retries ?? DEFAULT_RETRIES;

    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        if (isAbort(options.signal)) throw new SignedUrlTransferError('aborted');
        try {
            const response = await fetch(signedUrl, {
                method: 'GET',
                signal: options.signal,
            });
            if (!response.ok) {
                throw new SignedUrlTransferError(
                    `signed GET failed: ${response.status} ${response.statusText}`,
                    response.status,
                );
            }
            const buffer = await response.arrayBuffer();
            return new Uint8Array(buffer);
        } catch (error) {
            if (isAbort(options.signal)) throw new SignedUrlTransferError('aborted');
            lastError = error;
            if (attempt < maxRetries) {
                logger(`getBytesFromSignedUrl: attempt ${attempt + 1} failed, retrying: ${error}`, 2);
                await delay(RETRY_DELAY_MS * (attempt + 1), options.signal);
            }
        }
    }
    const detail = lastError instanceof Error ? lastError.message : String(lastError);
    throw new SignedUrlTransferError(`signed GET failed after retries: ${detail}`);
}
