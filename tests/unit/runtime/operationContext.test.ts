import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ runtime: { id: 'window-A', status: 'ready' }, values: new Map<unknown, any>(), writes: vi.fn(), prepare: vi.fn(async (_content: string, context: any) => context) }));
vi.mock('../../../react/store', () => ({ store: { get: (atom: unknown) => state.values.get(atom), set: state.writes } }));
vi.mock('../../../react/utils/citationRenderContext', () => ({ prepareCitationRenderContext: state.prepare }));
vi.mock('../../../react/utils/citationRenderers', () => ({ renderToHTML: (_text: string, _mode: string, context: any) => JSON.stringify(context) }));
vi.mock('../../../react/utils/attachmentResolvedEvent', () => ({ emitAttachmentResolved: vi.fn() }));
vi.mock('../../../react/atoms/threads', () => ({ currentThreadIdAtom: Symbol('thread') }));
vi.mock('../../../react/runtime/windowRuntime', () => ({ tryGetWindowRuntime: () => state.runtime }));
vi.mock('../../../src/services/deferredToolPolicy', async importOriginal => {
    const actual = await importOriginal<any>();
    return { ...actual, loadPreferences: () => ({ toolToGroup: {}, groupPreferences: {} }) };
});

import { emitAttachmentResolved } from '../../../react/utils/attachmentResolvedEvent';
import { captureOperationContext } from '../../../react/runtime/operationContext';
import { activeRunAtom } from '@beaver/agent-core/run-state/atoms';
import { citationMapAtom } from '@beaver/agent-core/citations/atoms';
import { externalReferenceMappingAtom, externalReferenceItemMappingAtom } from '@beaver/agent-core/citations/externalReferences';
import { currentThreadIdAtom } from '../../../react/atoms/threads';
import { runApprovalPolicyAtom } from '../../../react/atoms/runApprovalPolicy';

beforeEach(() => {
    vi.clearAllMocks();
    state.values.clear();
    state.runtime.status = 'ready';
    (Zotero as any).Beaver = { account: { getGeneration: () => 4, getSnapshot: () => ({ session: { user: { id: 'account-A' } } }) } };
    state.values.set(activeRunAtom, { id: 'run-A' });
    state.values.set(currentThreadIdAtom, 'thread-A');
    state.values.set(runApprovalPolicyAtom, { runId: 'run-A', fullAccess: true, approvedResources: new Set() });
    state.values.set(citationMapAtom, { a: { citation_id: 'citation-A' } });
    state.values.set(externalReferenceMappingAtom, { a: { title: 'Reference A' } });
    state.values.set(externalReferenceItemMappingAtom, { a: { zotero_key: 'ITEMAAAA' } });
});

describe('explicit data operation context', () => {
    const completion = { threadId: 'thread-A', actionId: 'action-A', libraryId: 1, zoteroKey: 'ITEMAAAA', attachmentStatus: 'available' as const };

    it.each(['new run', 'different thread', 'completed run'])('reports attachment completion after a %s', change => {
        const context = captureOperationContext(true);
        state.values.set(activeRunAtom, change === 'completed run' ? null : { id: 'run-B' });
        if (change === 'different thread') state.values.set(currentThreadIdAtom, 'thread-B');
        context.onAttachmentResolved!(completion);
        expect(emitAttachmentResolved).toHaveBeenCalledExactlyOnceWith(completion);
        context.grantCreatedNote!(1, 'NEWNOTE1');
        expect(state.writes).not.toHaveBeenCalled();
    });

    it.each(['window closing', 'account changed'])('drops attachment completion when %s', change => {
        const context = captureOperationContext(true);
        if (change === 'window closing') state.runtime.status = 'closing';
        else (Zotero as any).Beaver.account.getGeneration = () => 5;
        context.onAttachmentResolved!(completion);
        expect(emitAttachmentResolved).not.toHaveBeenCalled();
    });

    it('keeps captured citations and identity when the local chat changes during async work', async () => {
        const context = captureOperationContext(true);
        state.values.set(activeRunAtom, { id: 'run-B' });
        state.values.set(citationMapAtom, { b: { citation_id: 'citation-B' } });
        expect(context.threadId).toBe('thread-A');
        expect(context.runId).toBe('run-A');
        expect(await context.renderMarkdown!('text')).toContain('citation-A');
        expect(await context.renderMarkdown!('text')).not.toContain('citation-B');
        context.grantCreatedNote!(1, 'NEWNOTE1');
        expect(state.writes).not.toHaveBeenCalled();
    });

    it('never gives an originless request the local chat’s full access or citations', async () => {
        const local = captureOperationContext(true);
        const remote = captureOperationContext();
        expect(local.preference!('edit_metadata')).toBe('always_apply');
        expect(remote.preference!('edit_metadata')).toBe('always_ask');
        expect(remote.fullAccess).toBe(false);
        expect(remote.owner).toBeUndefined();
        expect(remote.threadId).toBeNull();
        expect(await remote.renderMarkdown!('text')).not.toContain('citation-A');
    });
});
