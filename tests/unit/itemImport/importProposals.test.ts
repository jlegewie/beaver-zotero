import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

// A plain stub: the endpoint's answer (or failure) for the next request.
const endpoint = vi.hoisted(() => ({
    calls: [] as unknown[][],
    answer: (): Promise<unknown> => Promise.resolve({}),
}));
vi.mock('@beaver/agent-core/transport/apiService', () => ({
    ApiService: class {
        post(...args: unknown[]) {
            endpoint.calls.push(args);
            return endpoint.answer();
        }
    },
}));
const post = {
    resolveWith: (value: unknown) => { endpoint.answer = () => Promise.resolve(value); },
    failWith: (error: unknown) => { endpoint.answer = () => Promise.reject(error); },
};

import { fetchImportProposal } from '../../../src/services/itemImport/importProposals';
import { SessionExpiredError } from '@beaver/agent-core/types/apiErrors';

const proposal = { source: { kind: 'external', input: 'NCT03548935', external_id: 'NCT03548935' } };

describe('fetchImportProposal', () => {
    beforeEach(() => { endpoint.calls = []; });

    it('asks the endpoint for one id and returns its proposal', async () => {
        post.resolveWith({ proposals: { NCT03548935: proposal } });
        await expect(fetchImportProposal('NCT03548935')).resolves.toBe(proposal);
        expect(endpoint.calls).toEqual([[
            '/api/v1/external-references/import-proposals',
            { external_ids: ['NCT03548935'] },
            expect.objectContaining({ timeoutMs: expect.any(Number) }),
        ]]);
    });

    it('reports an unavailable source by name with a retry message', async () => {
        post.resolveWith({ errors: { NCT03548935: { code: 'provider_unavailable', message: 'down' } } });
        await expect(fetchImportProposal('NCT03548935')).rejects.toMatchObject({
            code: 'provider_unavailable',
            message: expect.stringMatching(/ClinicalTrials\.gov is unavailable.*Try importing again/),
        });
    });

    it('reports a record the source no longer has', async () => {
        post.resolveWith({ errors: { 'pmid:1': { code: 'not_found', message: 'gone' } } });
        await expect(fetchImportProposal('pmid:1')).rejects.toMatchObject({ code: 'not_found', message: expect.stringContaining('PubMed') });
    });

    it('fails with a retry message when Beaver cannot be reached', async () => {
        post.failWith(new Error('network'));
        await expect(fetchImportProposal('W1')).rejects.toMatchObject({
            code: 'proposal_unavailable',
            message: expect.stringContaining('try again'),
        });
    });

    it('asks a signed-out user to sign in again', async () => {
        post.failWith(new SessionExpiredError('expired'));
        await expect(fetchImportProposal('W1')).rejects.toMatchObject({ code: 'signed_out' });
    });
});
