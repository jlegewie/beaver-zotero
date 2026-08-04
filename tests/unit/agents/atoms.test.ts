import { createStore } from 'jotai';
import { describe, expect, it, vi } from 'vitest';
import type {
    AgentRun,
    RetryPromptPart,
    ToolReturnPart,
} from '@beaver/agent-core/agents/types';
import type {
    MessageAttachment,
    SourceAttachment,
} from '@beaver/agent-core/types/attachments/apiTypes';

vi.mock('@beaver/agent-core/transport/supabaseClient', () => ({
    supabase: { auth: { getSession: vi.fn() } },
}));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));
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
    getToolCallStatus,
    threadRunsAtom,
} from '../../../react/agents/atoms';

function run(id: string, attachments: MessageAttachment[]): AgentRun {
    return {
        id,
        user_prompt: { content: '', attachments },
        model_messages: [],
    } as AgentRun;
}

describe('getToolCallStatus', () => {
    function resultsMap(
        part: ToolReturnPart | RetryPromptPart,
    ): Map<string, ToolReturnPart | RetryPromptPart> {
        return new Map([['call-1', part]]);
    }

    const toolReturn = (extra: Partial<ToolReturnPart> = {}): ToolReturnPart => ({
        part_kind: 'tool-return',
        tool_name: 'read',
        content: 'ok',
        tool_call_id: 'call-1',
        ...extra,
    });

    it('reports error for a terminal tool failure', () => {
        const map = resultsMap(toolReturn({ outcome: 'failed', content: 'Reading files is not available.' }));
        expect(getToolCallStatus('call-1', map)).toBe('error');
    });

    it('reports error for a retry prompt', () => {
        const map = resultsMap({
            part_kind: 'retry-prompt',
            tool_name: 'read',
            content: 'Fix the errors and try again.',
            tool_call_id: 'call-1',
        });
        expect(getToolCallStatus('call-1', map)).toBe('error');
    });

    it('reports completed for an explicit success outcome', () => {
        expect(getToolCallStatus('call-1', resultsMap(toolReturn({ outcome: 'success' })))).toBe('completed');
    });

    it('treats a missing outcome as success, for threads persisted before the field existed', () => {
        expect(getToolCallStatus('call-1', resultsMap(toolReturn()))).toBe('completed');
    });

    it('reports in_progress only while the run is active and no result has arrived', () => {
        const empty = new Map<string, ToolReturnPart | RetryPromptPart>();
        expect(getToolCallStatus('call-1', empty, 'in_progress')).toBe('in_progress');
        expect(getToolCallStatus('call-1', empty)).toBe('error');
    });
});

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
