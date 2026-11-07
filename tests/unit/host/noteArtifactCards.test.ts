// @vitest-environment jsdom

/**
 * The note artifact cards at the end of a run, and the list that folds many
 * of them into one group card: the whole card opens the note, its buttons
 * keep their own clicks, a proposal offers Create and Reject, and a group
 * unfolds its notes in the order the answer wrote them.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentAction } from '@beaver/agent-core/agents/agentActionTypes';

const mocks = vi.hoisted(() => ({
    openSource: vi.fn(),
    apply: vi.fn(),
    reject: vi.fn(),
    exportNoteToFile: vi.fn(),
}));

vi.mock('../../../react/host/zotero/agentActionExecution', async () => {
    const { atom } = await vi.importActual<typeof import('jotai')>('jotai');
    return {
        applyAgentActionsAtom: atom(null, (_get, _set, args: unknown) => mocks.apply(args)),
        rejectAgentActionsAtom: atom(null, (_get, _set, args: unknown) => mocks.reject(args)),
        inFlightAgentActionIdsAtom: atom<ReadonlySet<string>>(new Set<string>()),
    };
});
vi.mock('../../../react/utils/sourceUtils', () => ({ openSource: (...args: unknown[]) => mocks.openSource(...args) }));
vi.mock('../../../src/utils/libraryIdentity', () => ({ resolveLibraryRef: () => 1 }));
vi.mock('../../../react/host/zotero/fileExport', () => ({
    exportNoteToFile: (...args: unknown[]) => mocks.exportNoteToFile(...args),
    openExportedFile: vi.fn(),
    revealExportedFile: vi.fn(),
}));
vi.mock('../../../react/host/zotero/components/reviewChanges/useRunActionRows', () => ({ countPendingNoteEdits: () => 0 }));

import { CreatedNoteCard, EditedNoteCard } from '../../../react/host/zotero/components/reviewChanges/NoteArtifactCards';
import { ArtifactsList } from '../../../react/host/zotero/components/reviewChanges/ArtifactsList';
import { toolCallOrder } from '../../../react/host/zotero/components/reviewChanges/runArtifacts';
import type { ReviewRow } from '../../../react/host/zotero/components/reviewChangeRows';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function noteRow(toolcallId: string, action: Partial<AgentAction> = {}): ReviewRow {
    return {
        runId: 'run-1',
        toolcallId,
        actionType: 'create_note',
        bulkApplicable: true,
        resolved: action.status !== 'pending',
        actions: [
            {
                id: `action-${toolcallId}`,
                run_id: 'run-1',
                toolcall_id: toolcallId,
                action_type: 'create_note',
                status: 'applied',
                proposed_data: { title: `Note ${toolcallId}`, content: 'Three short words' },
                result_data: { library_id: 1, library_ref: 'u', zotero_key: `KEY-${toolcallId}` },
                ...action,
            } as AgentAction,
        ],
    };
}

function mount(element: React.ReactElement) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root!.render(h(Provider, { store: createStore() }, element)));
}

const actions = (scope: ParentNode = container!) =>
    Array.from(scope.querySelectorAll(':scope .run-artifact-actions button')).map(
        (b) => b.textContent?.trim() || b.getAttribute('aria-label'),
    );
const click = async (el: Element | null) => act(async () => (el as HTMLElement).click());

beforeEach(() => {
    vi.clearAllMocks();
});

afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    document.body.innerHTML = '';
});

describe('a created note card', () => {
    it('names the note on two lines and opens it from anywhere on the card, not from its buttons', async () => {
        mount(h(CreatedNoteCard, { row: noteRow('a') }));
        expect(container!.querySelector('.run-artifact-headline')?.textContent).toBe('Note a');
        expect(container!.querySelector('.run-artifact-condition')?.textContent).toBe('Note · 3 words');
        expect(actions()).toEqual(['Export', 'Open note']);
        await click(container!.querySelector('.run-artifact-body'));
        expect(mocks.openSource).toHaveBeenCalledWith(expect.objectContaining({ zotero_key: 'KEY-a' }));
        await click(container!.querySelector('button[aria-label="Export"]'));
        expect(mocks.openSource).toHaveBeenCalledTimes(1);
    });

    it('exports through a menu of formats, each with its icon', async () => {
        mount(h(CreatedNoteCard, { row: noteRow('a') }));
        await click(container!.querySelector('button[aria-label="Export"]'));
        const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
        expect(items.map((item) => item.textContent?.trim())).toEqual(['Word…', 'PDF…', 'Markdown…', 'LaTeX…']);
        expect(items.every((item) => item.querySelector('svg'))).toBe(true);
    });

    it('offers Reject and Create for an undecided proposal, and is not clickable', async () => {
        mount(h(CreatedNoteCard, { row: noteRow('a', { status: 'pending', result_data: undefined }) }));
        expect(actions()).toEqual(['Reject', 'Create']);
        expect(container!.querySelector('button.run-artifact-target')).toBeNull();
        await click(container!.querySelector('.run-artifact-body'));
        expect(mocks.openSource).not.toHaveBeenCalled();
        const create = [...container!.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Create');
        await click(create!);
        expect(mocks.apply).toHaveBeenCalledWith({ actions: expect.any(Array), runId: 'run-1' });
        const reject = [...container!.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Reject');
        await click(reject!);
        expect(mocks.reject).toHaveBeenCalled();
    });

    it('offers Create again for an undone note', () => {
        mount(h(CreatedNoteCard, { row: noteRow('a', { status: 'undone', result_data: undefined }) }));
        expect(container!.querySelector('.run-artifact-condition')?.textContent).toBe('Deleted with Undo');
        expect(actions()).toEqual(['Create again']);
    });
});

describe('an edited note card', () => {
    it('says what the answer changed, and opens the note from the card', async () => {
        mount(
            h(EditedNoteCard, {
                summary: {
                    runId: 'run-1',
                    toolcallId: 'edit',
                    note: { library_ref: 'u', library_id: 1, zotero_key: 'EDITED01' },
                    appliedChanges: 2,
                    pendingChanges: 0,
                },
            }),
        );
        expect(container!.querySelector('.run-artifact-condition')?.textContent).toBe('Edited · 2 changes');
        expect(actions()).toEqual(['Export', 'Open note']);
        await click(container!.querySelector('.run-artifact-body'));
        expect(mocks.openSource).toHaveBeenCalledWith(expect.objectContaining({ zotero_key: 'EDITED01' }));
    });
});

describe('many notes from one run', () => {
    const calls = ['a', 'b', 'c', 'd', 'e'];
    const runs = [
        {
            id: 'run-1',
            model_messages: [
                {
                    kind: 'response',
                    parts: calls.map((id) => ({ part_kind: 'tool-call', tool_call_id: id, tool_name: 'create_note', args: {} })),
                },
            ],
        },
    ];

    it('fold into one card that unfolds them, in the order the answer wrote them', async () => {
        // The store can hold the actions out of order.
        const rows = ['a', 'e', 'd', 'c', 'b'].map((id) => noteRow(id));
        mount(h(ArtifactsList, { rows, order: toolCallOrder(runs as never) }));
        const cards = () => container!.querySelectorAll('.run-artifact');
        expect(cards()).toHaveLength(1);
        expect(container!.querySelector('.run-artifact-headline')?.textContent).toBe('5 notes');
        expect(container!.querySelector('.run-artifact-condition')?.textContent).toBe('Note a and 4 more');

        await click(container!.querySelector('.run-artifact-body'));
        const members = [...container!.querySelectorAll('.run-artifact-members .run-artifact-headline')].map((el) => el.textContent);
        expect(members).toEqual(['Note a', 'Note b', 'Note c', 'Note d', 'Note e']);

        // A member opens its note; the group stays open.
        const third = container!.querySelectorAll('.run-artifact-members .run-artifact')[2];
        await click(third.querySelector('.run-artifact-body'));
        expect(mocks.openSource).toHaveBeenCalledWith(expect.objectContaining({ zotero_key: 'KEY-c' }));
        expect(cards()).toHaveLength(6);

        // So does a member's own button: it never folds the group.
        await click(third.querySelector('button[aria-label="Export"]'));
        expect(cards()).toHaveLength(6);
        await click(container!.querySelector('button[aria-label="Hide"]'));
        expect(cards()).toHaveLength(1);
    });

    it('stay unfolded when the list mounts again, as when the chat moves to the reader\'s sidebar', async () => {
        const store = createStore();
        const rows = ['a', 'b', 'c', 'd'].map((id) => noteRow(id));
        const list = () => h(Provider, { store }, h(ArtifactsList, { rows, order: toolCallOrder(runs as never) }));
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        act(() => root!.render(list()));
        await click(container!.querySelector('.run-artifact-body'));
        act(() => root!.unmount());
        root = createRoot(container);
        act(() => root!.render(list()));
        expect(container!.querySelectorAll('.run-artifact')).toHaveLength(5);
    });

    it('keep their own cards below the threshold', () => {
        mount(h(ArtifactsList, { rows: ['a', 'b', 'c'].map((id) => noteRow(id)), order: toolCallOrder(runs as never) }));
        expect(container!.querySelectorAll('.run-artifact')).toHaveLength(3);
    });
});
