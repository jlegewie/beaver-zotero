/**
 * Import proposals prepared by the backend at click time.
 *
 * An external record imported without an approved proposal (a citation's
 * Import, or a result row's) is prepared by `POST
 * /api/v1/external-references/import-proposals`, so every import path writes
 * an item built by the same backend code from current record data. There is
 * no fallback to data embedded in the thread: a failed request fails the
 * import with a message that asks the user to retry.
 */

import { ApiService } from '@beaver/agent-core/transport/apiService';
import { isApiError, isCredentialsBlockedError, isSessionExpiredError } from '@beaver/agent-core/types/apiErrors';
import type { ImportItemProposedData } from '@beaver/agent-core/types/itemImport';
import { supplierForExternalId } from '@beaver/agent-core/citations/externalRecords';
import { externalSourceLabel } from '@beaver/agent-core/citations/externalRecordDisplay';
import { logger } from '@beaver/agent-core/platform/logger';
import { ImportItemError } from './errors';

const IMPORT_PROPOSALS_PATH = '/api/v1/external-references/import-proposals';
/** The backend fetches live registry records; give it room, but never block the click forever. */
const PROPOSAL_TIMEOUT_MS = 45_000;

export interface ImportProposalError {
    code: 'not_found' | 'provider_unavailable' | string;
    message: string;
}

export interface ImportProposalsResponse {
    proposals?: Record<string, ImportItemProposedData>;
    errors?: Record<string, ImportProposalError>;
}

class ImportProposalsApi extends ApiService {
    /** One proposal or error per requested id (1–20 ids). */
    prepare(externalIds: string[]): Promise<ImportProposalsResponse> {
        return this.post<ImportProposalsResponse>(
            IMPORT_PROPOSALS_PATH,
            { external_ids: externalIds },
            { timeoutMs: PROPOSAL_TIMEOUT_MS },
        );
    }
}

let api: ImportProposalsApi | null = null;

function client(): ImportProposalsApi {
    api ??= new ImportProposalsApi();
    return api;
}

function sourceName(externalId: string, provider?: string | null): string {
    return externalSourceLabel(provider || supplierForExternalId(externalId)) || 'The source';
}

/**
 * The backend's current import proposal for one external record.
 *
 * Throws `ImportItemError`: `not_found` when the source no longer has the
 * record, `provider_unavailable` when the source is down, and
 * `proposal_unavailable` when Beaver could not be reached.
 */
export async function fetchImportProposal(externalId: string, provider?: string | null): Promise<ImportItemProposedData> {
    let response: ImportProposalsResponse;
    try {
        response = await client().prepare([externalId]);
    } catch (error) {
        logger(`itemImport/importProposals: request for ${externalId} failed: ${error}`, 1);
        if (isSessionExpiredError(error) || isCredentialsBlockedError(error)) {
            throw new ImportItemError('signed_out', 'Sign in to Beaver again, then retry the import.');
        }
        const status = isApiError(error) && error.status > 0 ? ` (${error.status})` : '';
        throw new ImportItemError(
            'proposal_unavailable',
            `Beaver could not prepare this import${status}. Check your connection and try again.`,
        );
    }
    const proposal = response?.proposals?.[externalId];
    if (proposal?.source) return proposal;
    const failure = response?.errors?.[externalId];
    const name = sourceName(externalId, provider);
    if (failure?.code === 'not_found') {
        throw new ImportItemError('not_found', `${name} no longer has ${externalId}. It cannot be imported.`);
    }
    if (failure?.code === 'provider_unavailable') {
        throw new ImportItemError(
            'provider_unavailable',
            `${name} is unavailable right now. Try importing again in a few minutes.`,
        );
    }
    throw new ImportItemError(
        'proposal_unavailable',
        failure?.message
            ? `${failure.message} Try importing again.`
            : 'Beaver could not prepare this import. Try again.',
    );
}
