/**
 * The backend's copy of an open-access PDF, as a PDF source.
 *
 * OpenAlex keeps cached copies of open-access PDFs, which publisher bot walls
 * and CAPTCHAs cannot block. Fetching them needs Beaver's OpenAlex key, so the
 * backend fetches the file (`POST /api/v1/fulltext/pdf`) and returns its bytes.
 * Only items with a DOI can be looked up.
 *
 * Esbuild-safe: no `react/*` imports, no bare `addon`.
 */

import { ApiService } from '@beaver/agent-core/transport/apiService';
import { logger } from '@beaver/agent-core/platform/logger';
import { awaitWithRequestAbort } from './agentDataProvider/timeout';
import { removeDirectory, type DownloadedFile, type PdfSourceContext } from './pdfAttachmentFetch';
import { PDF_FETCH_CANCELLED_MESSAGE } from './pdfFetchDiagnostics';

const SERVER_PDF_PATH = '/api/v1/fulltext/pdf';
/** The backend looks the work up and downloads the file; give it room, but never wait forever. */
const SERVER_PDF_TIMEOUT_MS = 45_000;

/** Reported as the access method of a file from this source. */
export const SERVER_PDF_ACCESS_METHOD = 'openalex_content';
/** Reported as the host of this source's attempt: where the file comes from. */
const SERVER_PDF_HOST = 'content.openalex.org';

interface ServerPdfResponse {
    bytes: Uint8Array;
    headers: { get(name: string): string | null };
}

class ServerPdfApi extends ApiService {
    fetchPdf(doi: string, assertDispatch: () => void): Promise<ServerPdfResponse> {
        return this.postForBytes(SERVER_PDF_PATH, { doi }, { timeoutMs: SERVER_PDF_TIMEOUT_MS, assertDispatch });
    }
}

let api: ServerPdfApi | null = null;

function client(): ServerPdfApi {
    api ??= new ServerPdfApi();
    return api;
}

/** The item's DOI from its DOI field or an `Extra` line, or null. */
function itemDoi(item: Zotero.Item): string | null {
    const raw = item.getField('DOI') || (item as any).getExtraField?.('DOI') || '';
    return Zotero.Utilities.cleanDOI(String(raw)) || null;
}

/** An http(s) URL to record as the attachment's source, or null. */
function httpUrl(value: string | null): string | null {
    if (!value) return null;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
    } catch {
        return null;
    }
}

function isPdf(bytes: Uint8Array): boolean {
    return bytes.length > 5 && String.fromCharCode(...bytes.subarray(0, 5)) === '%PDF-';
}

/**
 * Download the backend's copy of `item`'s PDF into a private temporary
 * directory. Returns null when the item has no DOI or the backend has no
 * file; the attempt is recorded on `diagnostics` either way. Throws only when
 * the task was cancelled or access was revoked.
 */
export async function downloadServerPdf({ item, signal, assertAccess, diagnostics }: PdfSourceContext): Promise<DownloadedFile | null> {
    const assertCurrent = () => {
        if (signal.aborted) throw new Error(PDF_FETCH_CANCELLED_MESSAGE);
        assertAccess();
    };
    assertCurrent();
    const doi = itemDoi(item);
    if (!doi) return null;

    let response: ServerPdfResponse;
    try {
        assertCurrent();
        const request = client().fetchPdf(doi, assertCurrent);
        request.catch(() => {});
        // The request cannot be cancelled; stop waiting for it when the task is.
        response = await awaitWithRequestAbort(request, signal, assertCurrent, 'server PDF');
        if (!isPdf(response.bytes)) throw new Error('Downloaded file was not a supported type (PDF)');
    } catch (error) {
        assertCurrent();
        diagnostics?.recordSourceAttempt(SERVER_PDF_ACCESS_METHOD, SERVER_PDF_HOST, error);
        logger(`serverPdfSource: no server PDF for ${item.key}: ${(error as Error)?.message ?? error}`, 2);
        return null;
    }

    const attachments = Zotero.Attachments as any;
    const directory: string = (await attachments.createTemporaryStorageDirectory()).path;
    try {
        assertCurrent();
        const path = PathUtils.join(directory, 'file.pdf');
        await IOUtils.write(path, response.bytes);
        assertCurrent();
        diagnostics?.recordSourceAttempt(SERVER_PDF_ACCESS_METHOD, SERVER_PDF_HOST);
        const version = response.headers.get('X-Beaver-Pdf-Version');
        return {
            directory,
            path,
            url: httpUrl(response.headers.get('X-Beaver-Pdf-Url')) ?? `https://doi.org/${doi}`,
            mimeType: 'application/pdf',
            props: version ? { articleVersion: version } : undefined,
            accessMethod: SERVER_PDF_ACCESS_METHOD,
        };
    } catch (error) {
        await removeDirectory(directory);
        throw error;
    }
}
