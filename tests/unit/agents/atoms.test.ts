import { createStore } from 'jotai';
import { describe, expect, it, vi } from 'vitest';
import type { AgentRun } from '../../../react/agents/types';
import type {
    MessageAttachment,
    SourceAttachment,
} from '../../../react/types/attachments/apiTypes';

vi.mock('../../../src/services/supabaseClient', () => ({
    supabase: { auth: { getSession: vi.fn() } },
}));
vi.mock('../../../src/utils/logger', () => ({ logger: vi.fn() }));
vi.mock('../../../src/utils/zoteroUtils', () => ({
    getZoteroUserIdentifier: vi.fn(() => ({ userID: undefined, localUserKey: 'test' })),
}));
vi.mock('../../../src/utils/prefs', () => ({
    getPref: vi.fn(() => true),
    setPref: vi.fn(),
}));

import {
    allUserAttachmentKeysAtom,
    allUserAttachmentsAtom,
    threadRunsAtom,
} from '../../../react/agents/atoms';

function run(id: string, attachments: MessageAttachment[]): AgentRun {
    return {
        id,
        user_prompt: { content: '', attachments },
        model_messages: [],
    } as AgentRun;
}

describe('allUserAttachmentsAtom', () => {
    it('replaces a legacy representative with a later portable attachment', () => {
        const legacy: SourceAttachment = {
            type: 'source',
            library_id: 5,
            zotero_key: 'SOURCE12',
            include: 'fulltext',
        };
        const portable: SourceAttachment = {
            ...legacy,
            library_ref: 'g42',
        };
        const store = createStore();

        store.set(threadRunsAtom, [
            run('legacy-run', [legacy]),
            run('portable-run', [portable]),
        ]);

        expect(store.get(allUserAttachmentsAtom)).toEqual(
            new Map([['g42-SOURCE12', portable]])
        );
        expect(store.get(allUserAttachmentKeysAtom)).toEqual(
            new Set(['g42-SOURCE12'])
        );
    });

    it('keeps a portable representative when a legacy attachment appears later', () => {
        const portable: SourceAttachment = {
            type: 'source',
            library_id: 5,
            library_ref: 'g42',
            zotero_key: 'SOURCE12',
            include: 'fulltext',
        };
        const legacy: SourceAttachment = {
            ...portable,
            library_ref: undefined,
        };
        const store = createStore();

        store.set(threadRunsAtom, [
            run('portable-run', [portable]),
            run('legacy-run', [legacy]),
        ]);

        expect(store.get(allUserAttachmentsAtom)).toEqual(
            new Map([['g42-SOURCE12', portable]])
        );
        expect(store.get(allUserAttachmentKeysAtom)).toEqual(
            new Set(['g42-SOURCE12'])
        );
    });
});
