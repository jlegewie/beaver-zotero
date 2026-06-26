/**
 * Frontend-facing OCR backend client.
 *
 * Thin typed wrapper over the authenticated `/api/v1/ocr/*` endpoints:
 *   POST /ocr/request   - cache hit, upload URL, or in-flight job
 *   POST /ocr/uploaded  - confirm the input PUT landed
 *   GET  /ocr/status    - poll job status
 *
 * Extends `ApiService` for Supabase-JWT auth + 401 refresh, so this module is
 * part of the webpack bundle. The OcrExecutor (registered from the webpack
 * GlobalContextInitializer) is the only consumer; the esbuild background
 * dispatcher never imports it.
 */

import { ApiService } from '../apiService';
import API_BASE_URL from '../../utils/getAPIBaseURL';
import { OCR_API_PREFIX } from './constants';

/** Lifecycle phase of a job (the `/uploaded` and `/status` `status` field). */
export type OcrJobStatus = 'pending' | 'queued' | 'completed' | 'failed';

/** Discriminator of the `/request` response. */
export type OcrRequestStatus =
    | 'ready'
    | 'pending'
    | 'queued'
    | 'failed'
    | 'rejected'
    | 'disabled';

export interface OcrError {
    code: string;
    message: string;
    kind: 'transient' | 'permanent';
}

export interface OcrRequestResponse {
    status: OcrRequestStatus;
    job_id?: string | null;
    /** Signed PUT URL, present only while still awaiting upload (`pending`). */
    put_url?: string | null;
    /** Signed GET URL, present once the searchable PDF is `ready`. */
    get_url?: string | null;
    /** Page-cap rejection detail. */
    reason?: 'page_cap' | null;
    limit?: number | null;
    page_count?: number | null;
    error?: OcrError | null;
}

export interface OcrUploadedResponse {
    status: OcrJobStatus;
    job_id: string;
}

export interface OcrStatusResponse {
    status: OcrJobStatus;
    get_url?: string | null;
    error?: OcrError | null;
}

/** One job's status in a batched `/ocr/status/batch` response. */
export interface OcrStatusItem {
    job_id: string;
    status: OcrJobStatus;
    get_url?: string | null;
    error?: OcrError | null;
}

/**
 * Batched status response. Missing job IDs are omitted, so callers can decide
 * how to recover absent rows.
 */
export interface OcrStatusBatchResponse {
    jobs: OcrStatusItem[];
}

export class OcrApiClient extends ApiService {
    /** Request OCR for a content hash, joining/creating the backend job. */
    requestOcr(fileHash: string, pageCount: number): Promise<OcrRequestResponse> {
        return this.post<OcrRequestResponse>(`${OCR_API_PREFIX}/request`, {
            file_hash: fileHash,
            page_count: pageCount,
        });
    }

    /** Confirm the input PUT landed and move the job into the queue. */
    markUploaded(jobId: string): Promise<OcrUploadedResponse> {
        return this.post<OcrUploadedResponse>(`${OCR_API_PREFIX}/uploaded`, {
            job_id: jobId,
        });
    }

    /** Poll a job's status (and the signed GET URL once ready). */
    status(jobId: string): Promise<OcrStatusResponse> {
        return this.get<OcrStatusResponse>(
            `${OCR_API_PREFIX}/status?job_id=${encodeURIComponent(jobId)}`,
        );
    }

    /** Poll several jobs in one request. Missing job IDs are omitted. */
    statusBatch(jobIds: string[]): Promise<OcrStatusBatchResponse> {
        const query = jobIds
            .map((id) => `job_ids=${encodeURIComponent(id)}`)
            .join('&');
        return this.get<OcrStatusBatchResponse>(
            `${OCR_API_PREFIX}/status/batch?${query}`,
        );
    }
}

export const ocrApiClient = new OcrApiClient(API_BASE_URL);
