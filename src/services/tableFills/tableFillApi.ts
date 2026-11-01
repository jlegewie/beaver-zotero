/**
 * The backend's table fill endpoints: `GET /tables/pricing` and
 * `POST /tables/fill`, one row per request.
 */

import { ApiService } from '@beaver/agent-core/transport/apiService';
import {
    isApiError,
    isCredentialsBlockedError,
    isServerError,
    isSessionExpiredError,
    isSessionRefreshError,
} from '@beaver/agent-core/types/apiErrors';
import {
    TABLE_FILL_API_PREFIX,
    type TableFillDocumentKind,
    type TableFillErrorCode,
    type TableFillPricing,
    type TableFillRequest,
    type TableFillResponse,
} from '@beaver/agent-core/protocol/tableFillProtocol';
import { gzipUtf8BytesChunked } from '../../utils/gzip';

/**
 * Client-side ceiling for one row. The backend bounds a row by its own
 * deadline and answers first; this only frees the job's slot when the server
 * never answers. A request abandoned here is retried with the same key, which
 * the backend never charges twice.
 */
const FILL_TIMEOUT_MS = 6 * 60_000;

/** Bodies are deflated fast, in short slices, so the main thread stays free. */
const FILL_GZIP_OPTIONS = { level: 1, yieldAfterChars: 256 * 1024 };

/** A row's document as the shared helper serialized it. */
export interface SerializedFillDocument {
    id: string;
    kind: TableFillDocumentKind;
    /** The backend-bound extraction as JSON, spliced into the body unparsed. */
    json: string;
}

/**
 * The request body as JSON text: the envelope serialized once, the document's
 * extraction spliced in as it was serialized for the backend.
 */
export function fillRequestBody(
    request: Omit<TableFillRequest, 'document'>,
    document?: SerializedFillDocument,
): string {
    const envelope = JSON.stringify(request);
    if (!document) return envelope;
    const head = `{"id":${JSON.stringify(document.id)},"kind":${JSON.stringify(document.kind)},"content":`;
    const field = `"document":${head}${document.json}}`;
    return envelope === '{}' ? `{${field}}` : `${envelope.slice(0, -1)},${field}}`;
}

/** How a failed request is handled by the job. */
export type FillFailure =
    /** Try again with the same key after a backoff. */
    | { kind: 'retry'; code: 'network' | 'rate_limited' | 'unavailable'; retryAfterMs?: number }
    /** Stop starting rows; the row stays pending. */
    | { kind: 'stop'; code: 'insufficient_credits' | 'price_changed' | 'signed_out' }
    /** The row cannot be answered as sent. */
    | { kind: 'row'; code: 'too_large' | 'invalid_request'; message: string };

/** Classifies an error thrown by {@link TableFillApiClient.fill}. */
export function classifyFillError(error: unknown): FillFailure {
    if (isSessionExpiredError(error) || isCredentialsBlockedError(error)) {
        return { kind: 'stop', code: 'signed_out' };
    }
    // A network failure or a client deadline: nothing reached the server, or
    // its answer was lost. The same key is answered again without a charge.
    if (isSessionRefreshError(error)) return { kind: 'retry', code: 'network' };
    if (isApiError(error)) {
        const code = error.code as TableFillErrorCode | undefined;
        if (error.status === 402 || code === 'insufficient_credits')
            return { kind: 'stop', code: 'insufficient_credits' };
        if (code === 'price_changed') return { kind: 'stop', code: 'price_changed' };
        if (error.status === 429 || code === 'rate_limited')
            return {
                kind: 'retry',
                code: 'rate_limited',
                ...(error.retryAfterSeconds ? { retryAfterMs: error.retryAfterSeconds * 1000 } : {}),
            };
        if (error.status === 413 || code === 'too_large')
            return { kind: 'row', code: 'too_large', message: error.message };
        if (error.status >= 500 || code === 'unavailable') return { kind: 'retry', code: 'unavailable' };
        return { kind: 'row', code: 'invalid_request', message: error.message };
    }
    if (isServerError(error) || error instanceof TypeError) return { kind: 'retry', code: 'network' };
    return { kind: 'retry', code: 'network' };
}

export class TableFillApiClient extends ApiService {
    pricing(): Promise<TableFillPricing> {
        return this.get<TableFillPricing>(`${TABLE_FILL_API_PREFIX}/pricing`, { timeoutMs: 30_000 });
    }

    /** Posts one row, gzip-compressed. Throws the transport's errors; see {@link classifyFillError}. */
    async fill(body: string, assertDispatch?: () => void): Promise<TableFillResponse> {
        assertDispatch?.();
        const bytes = await gzipUtf8BytesChunked(new TextEncoder().encode(body), FILL_GZIP_OPTIONS);
        assertDispatch?.();
        // Checked again right before each fetch, a 401 retry included.
        return await this.postRaw<TableFillResponse>(
            `${TABLE_FILL_API_PREFIX}/fill`,
            bytes,
            { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
            { timeoutMs: FILL_TIMEOUT_MS, assertDispatch },
        );
    }
}

export const tableFillApiClient = new TableFillApiClient();
