import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    isConnected: vi.fn(() => true),
    send: vi.fn(),
}));

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));
vi.mock('@beaver/agent-core/transport/agentService', () => ({
    agentService: { isConnected: mocks.isConnected, send: mocks.send },
}));
vi.mock('../../../src/utils/libraryIdentity', () => ({
    libraryRefForLibraryID: (id: number) => (id === 1 ? 'u' : null),
}));

import { emitAttachmentResolved } from '../../../react/utils/attachmentResolvedEvent';

const base = {
    threadId: 'thread-1',
    libraryId: 1,
    zoteroKey: 'ITEM0001',
    attachmentStatus: 'failed' as const,
    elapsedMs: 1200,
};

/** What the backend receives: undefined keys vanish when the message is serialized. */
const wire = () => JSON.parse(JSON.stringify(mocks.send.mock.calls[0][0]));

beforeEach(() => {
    vi.clearAllMocks();
    mocks.isConnected.mockReturnValue(true);
});

describe('emitAttachmentResolved', () => {
    it('sends the failure reason and the attempt trail in snake_case', () => {
        emitAttachmentResolved({
            ...base,
            failureReason: 'bot_challenge',
            attempts: [
                { accessMethod: 'doi', host: 'doi.org', outcome: 'bot_challenge', status: 403 },
                { accessMethod: 'openalex', outcome: 'no_pdf_found' },
            ],
        });
        expect(wire()).toMatchObject({
            type: 'attachment_resolved',
            thread_id: 'thread-1',
            attachment_status: 'failed',
            failure_reason: 'bot_challenge',
            attempts: [
                { access_method: 'doi', host: 'doi.org', outcome: 'bot_challenge', status: 403 },
                { access_method: 'openalex', outcome: 'no_pdf_found' },
            ],
        });
        expect(wire().attempts[1]).not.toHaveProperty('host');
        expect(wire().attempts[1]).not.toHaveProperty('status');
    });

    it('sends the attempts of an available attachment without a failure reason', () => {
        emitAttachmentResolved({
            ...base,
            attachmentStatus: 'available',
            attachmentKey: '1-PDFKEY01',
            accessMethod: 'openalex',
            attempts: [{ accessMethod: 'openalex', host: 'oa.example', outcome: 'ok' }],
        });
        expect(wire()).toMatchObject({ attachment_status: 'available', attempts: [{ outcome: 'ok' }] });
        expect(wire()).not.toHaveProperty('failure_reason');
    });

    it('omits both fields for an old-style payload and for an empty trail', () => {
        emitAttachmentResolved({ ...base, attempts: [] });
        expect(wire()).not.toHaveProperty('attempts');
        expect(wire()).not.toHaveProperty('failure_reason');
        expect(wire()).toMatchObject({ elapsed_ms: 1200, library_ref: 'u' });
    });

    it('sends nothing without a thread or a connection', () => {
        emitAttachmentResolved({ ...base, threadId: undefined });
        mocks.isConnected.mockReturnValue(false);
        emitAttachmentResolved(base);
        expect(mocks.send).not.toHaveBeenCalled();
    });
});
