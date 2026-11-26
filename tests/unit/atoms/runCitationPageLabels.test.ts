/**
 * Page labels preloaded for a run's citations reach the renderer even when the
 * preload settles after the run, once the callback setter no longer writes.
 * The site icons sent beside a run's citations, once per host, are filled in
 * as the citations are stored.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { preloadPageLabelsForCitations } = vi.hoisted(() => ({
    preloadPageLabelsForCitations: vi.fn(),
}));

vi.mock('../../../react/utils/pageLabels', () => ({ preloadPageLabelsForCitations }));

vi.mock('../../../react/runtime/windowRuntime', () => ({
    tryGetWindowRuntime: () => ({ hostWindow: { closed: false, requestAnimationFrame: () => 1, cancelAnimationFrame: () => {} } }),
}));

vi.mock('@beaver/agent-core/transport/supabaseClient', () => ({
    supabase: { auth: { getSession: vi.fn(), refreshSession: vi.fn() } },
}));

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

vi.mock('../../../src/utils/zoteroUtils', () => ({
    loadFullItemDataWithAllTypes: vi.fn(),
    getZoteroUserIdentifier: vi.fn(() => ({ userID: undefined, localUserKey: 'test' })),
}));

vi.mock('../../../src/services/agentDataProvider', () => ({}));

import type { Setter } from 'jotai';
import type { WSRunCitationsEvent, WSRunCompleteEvent } from '@beaver/agent-core/protocol/agentProtocol';
import { citationsAtom, pageLabelsByAttachmentIdAtom } from '@beaver/agent-core/citations/atoms';
import { createWSCallbacks } from '../../../react/atoms/agentRunAtoms';
import { store } from '../../../react/store';
import { chatStore } from '../../helpers/runSession';

describe('run citation page labels', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        chatStore().set(citationsAtom, []);
        store.set(pageLabelsByAttachmentIdAtom, {});
    });

    it('merges labels that arrive after the run released its setter', async () => {
        let resolvePreload!: (labels: Record<number, Record<number, string>>) => void;
        preloadPageLabelsForCitations.mockReturnValue(new Promise(resolve => { resolvePreload = resolve; }));

        // The run's setter, revoked once the run settles.
        let revoked = false;
        const runSet = ((...args: Parameters<Setter>) => {
            if (!revoked) return (chatStore().set as any)(...args);
        }) as Setter;
        const callbacks = createWSCallbacks(runSet);

        callbacks.onRunCitations({
            event: 'run_citations',
            run_id: 'run-1',
            citations: [{
                citation_id: 'c1',
                resolved_ref: { kind: 'zotero', library_id: 1, zotero_key: 'ATTACH01' },
                locations: [{ page_idx: 0 }],
            }],
        } as unknown as WSRunCitationsEvent);
        expect(store.get(citationsAtom)).toHaveLength(1);

        revoked = true;
        resolvePreload({ 101: { 1: '1302' } });
        await vi.waitFor(() => {
            expect(store.get(pageLabelsByAttachmentIdAtom)).toEqual({ 101: { 1: '1302' } });
        });
    });
});

const icon = 'data:image/webp;base64,UklGRhwAAABXRUJQ';
const webCitation = (id: string, iconHost?: string) => ({
    citation_id: id,
    citation_type: 'external_reference',
    resolved_ref: { kind: 'external', external_id: id },
    web_page: { url: `https://www.who.int/${id}`, ...(iconHost ? { icon_host: iconHost } : {}) },
});

describe('run citation site icons', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        preloadPageLabelsForCitations.mockResolvedValue({});
        chatStore().set(citationsAtom, []);
    });

    it('fills in the icons a run_citations event sends beside its citations', () => {
        const callbacks = createWSCallbacks(chatStore().set);

        callbacks.onRunCitations({
            event: 'run_citations',
            run_id: 'run-1',
            citations: [webCitation('web-AAAAAAAAAA', 'www.who.int'), webCitation('web-BBBBBBBBBB', 'www.who.int'), webCitation('web-CCCCCCCCCC')],
            site_icons: { 'www.who.int': icon },
        } as unknown as WSRunCitationsEvent);

        expect(store.get(citationsAtom).map((citation) => [citation.run_id, citation.web_page?.icon])).toEqual([
            ['run-1', icon],
            ['run-1', icon],
            ['run-1', undefined],
        ]);
    });

    it('fills them in from a run_complete event that embeds the citations', async () => {
        const callbacks = createWSCallbacks(chatStore().set);

        await callbacks.onRunComplete({
            event: 'run_complete',
            run_id: 'run-2',
            usage: null,
            cost: null,
            citations: [webCitation('web-AAAAAAAAAA', 'www.who.int')],
            site_icons: { 'www.who.int': icon },
            agent_actions: null,
        } as unknown as WSRunCompleteEvent);

        expect(store.get(citationsAtom).map((citation) => citation.web_page?.icon)).toEqual([icon]);
    });
});
