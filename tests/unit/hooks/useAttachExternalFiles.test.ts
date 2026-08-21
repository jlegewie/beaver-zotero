// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// =============================================================================
// Module mocks — the attach path reaches Zotero services and supabase-backed
// atoms, none of which the hook's own behavior depends on.
// =============================================================================

const attachExternalFileMock = vi.fn();
vi.mock('../../../src/services/externalFiles', () => ({
    attachExternalFile: (...args: unknown[]) => attachExternalFileMock(...args),
}));

const getPrefMock = vi.fn();
vi.mock('../../../src/utils/prefs', () => ({
    getPref: (...args: unknown[]) => getPrefMock(...args),
    setPref: vi.fn(),
}));

const addedRecords: unknown[][] = [];
vi.mock('../../../react/atoms/messageComposition', async () => {
    const { atom } = await import('jotai');
    atoms.composerResetToken = atom(0);
    atoms.pendingAttachmentTokens = atom([]);
    return {
        addExternalFilesToCurrentMessageAtom: atom(null, (_get, _set, records: unknown[]) => {
            addedRecords.push(records);
        }),
        composerResetTokenAtom: atoms.composerResetToken,
        pendingAttachmentTokensAtom: atoms.pendingAttachmentTokens,
    };
});

// Atom identities the tests write to. Hoisted because the mock factories
// populate it before this file's body runs.
const atoms = vi.hoisted(() => ({} as {
    selectedModel: any;
    requestPlusTools: any;
    composerResetToken: any;
    pendingAttachmentTokens: any;
}));

vi.mock('../../../react/atoms/models', async () => {
    const { atom } = await import('jotai');
    atoms.selectedModel = atom<{ supports_vision: boolean } | null>({ supports_vision: true });
    return { selectedModelAtom: atoms.selectedModel };
});

vi.mock('../../../react/atoms/ui', async () => {
    const { atom } = await import('jotai');
    atoms.requestPlusTools = atom(false);
    return { requestPlusToolsAtom: atoms.requestPlusTools };
});

const popupMessages: { title?: string; text?: string }[] = [];
vi.mock('../../../react/utils/popupMessageUtils', async () => {
    const { atom } = await import('jotai');
    return {
        addPopupMessageAtom: atom(null, (_get, _set, message: { title?: string; text?: string }) => {
            popupMessages.push(message);
        }),
    };
});

import { getDefaultStore } from 'jotai';
import { useAttachExternalFiles } from '../../../react/hooks/useAttachExternalFiles';

type Attach = ReturnType<typeof useAttachExternalFiles>;

/** Mounted harnesses, torn down after each test so a still-subscribed one
 *  cannot re-render when the next test writes the atoms. */
const mounted: { root: ReturnType<typeof createRoot>; container: HTMLDivElement }[] = [];

/** Mount the hook and return its callback. */
async function mountHook(): Promise<Attach> {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    let attach: Attach | null = null;
    const container = globalThis.document.createElement('div');
    globalThis.document.body.append(container);
    const root = createRoot(container);
    mounted.push({ root, container });
    function Harness() {
        attach = useAttachExternalFiles();
        return null;
    }
    await act(async () => root.render(React.createElement(Harness)));
    return attach!;
}

const attached = (extKey: string) => ({ status: 'attached', record: { extKey } });
const rejected = (message: string, reason = 'unsupported_type') => ({ status: 'rejected', reason, message });

describe('useAttachExternalFiles', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        addedRecords.length = 0;
        popupMessages.length = 0;
        getDefaultStore().set(atoms.selectedModel, { supports_vision: true });
        getDefaultStore().set(atoms.requestPlusTools, false);
        getDefaultStore().set(atoms.composerResetToken, 0);
        getDefaultStore().set(atoms.pendingAttachmentTokens, []);
        getPrefMock.mockReturnValue(10);
    });

    afterEach(async () => {
        await act(async () => {
            for (const { root } of mounted) root.unmount();
        });
        for (const { container } of mounted) container.remove();
        mounted.length = 0;
    });

    it('attaches every file and adds the records to the message', async () => {
        attachExternalFileMock
            .mockResolvedValueOnce(attached('AAA'))
            .mockResolvedValueOnce(attached('BBB'));
        const attach = await mountHook();

        const result = await act(async () => attach(['/a.pdf', '/b.png']));

        expect(result!.attached.map((r) => r.extKey)).toEqual(['AAA', 'BBB']);
        expect(result!.rejectedCount).toBe(0);
        expect(addedRecords).toHaveLength(1);
        expect(popupMessages).toHaveLength(0);
    });

    it('reports a rejected file as a popup and keeps the accepted ones', async () => {
        attachExternalFileMock
            .mockResolvedValueOnce(rejected('Unsupported file type: notes.docx'))
            .mockResolvedValueOnce(attached('AAA'));
        const attach = await mountHook();

        const result = await act(async () => attach(['/notes.docx', '/a.pdf']));

        expect(result!.rejectedCount).toBe(1);
        expect(result!.attached.map((r) => r.extKey)).toEqual(['AAA']);
        expect(popupMessages).toEqual([
            expect.objectContaining({ title: 'File not added', text: 'Unsupported file type: notes.docx' }),
        ]);
    });

    it('routes rejections to a caller-supplied reporter instead of a popup', async () => {
        attachExternalFileMock.mockResolvedValueOnce(rejected('File too large: big.pdf'));
        const attach = await mountHook();
        const onReject = vi.fn();

        await act(async () => attach(['/big.pdf'], { onReject }));

        expect(onReject).toHaveBeenCalledWith('File too large: big.pdf');
        expect(popupMessages).toHaveLength(0);
    });

    it('refuses a batch over the per-message limit without attaching anything', async () => {
        getPrefMock.mockReturnValue(2);
        const attach = await mountHook();

        const result = await act(async () => attach(['/a.pdf', '/b.pdf', '/c.pdf']));

        expect(attachExternalFileMock).not.toHaveBeenCalled();
        expect(result!.attached).toEqual([]);
        expect(result!.rejectedCount).toBe(3);
        expect(popupMessages[0].text).toBe('You can add up to 2 files at a time.');
    });

    it('passes the model capabilities that gate images and scanned PDFs', async () => {
        getDefaultStore().set(atoms.selectedModel, { supports_vision: false });
        getDefaultStore().set(atoms.requestPlusTools, true);
        attachExternalFileMock.mockResolvedValueOnce(attached('AAA'));
        const attach = await mountHook();

        await act(async () => attach(['/a.pdf']));

        expect(attachExternalFileMock).toHaveBeenCalledWith('/a.pdf', {
            supportsVision: false,
            // Plus tools can OCR a scanned PDF even without model vision.
            canHandleOCRLocally: true,
        });
    });

    it('holds sending under the token of the composition being attached to', async () => {
        const heldDuringAttach: number[][] = [];
        attachExternalFileMock.mockImplementationOnce(async () => {
            heldDuringAttach.push([...getDefaultStore().get(atoms.pendingAttachmentTokens)]);
            return attached('AAA');
        });
        const attach = await mountHook();

        await act(async () => attach(['/a.pdf']));

        expect(heldDuringAttach).toEqual([[0]]);
        expect(getDefaultStore().get(atoms.pendingAttachmentTokens)).toEqual([]);
    });

    it('releases the hold when an attach throws', async () => {
        attachExternalFileMock.mockRejectedValueOnce(new Error('disk full'));
        const attach = await mountHook();

        await act(async () => expect(attach(['/a.pdf'])).rejects.toThrow('disk full'));

        // A stuck hold would leave the composer unable to send.
        expect(getDefaultStore().get(atoms.pendingAttachmentTokens)).toEqual([]);
    });

    it('stops holding the new composition when the composer is reset mid-attach', async () => {
        // The leftover work still runs, but it belongs to the old composition,
        // so the new draft must be free to send while it finishes.
        let release: (result: unknown) => void = () => {};
        attachExternalFileMock.mockImplementationOnce(
            () => new Promise((resolve) => { release = resolve; }),
        );
        const attach = await mountHook();

        let done: Promise<unknown>;
        await act(async () => { done = attach(['/big.pdf']); });
        expect(getDefaultStore().get(atoms.pendingAttachmentTokens)).toEqual([0]);

        await act(async () => { getDefaultStore().set(atoms.composerResetToken, 1); });
        // Still in flight, but tagged to the composition the user left.
        expect(getDefaultStore().get(atoms.pendingAttachmentTokens)).toEqual([0]);
        expect(getDefaultStore().get(atoms.pendingAttachmentTokens))
            .not.toContain(getDefaultStore().get(atoms.composerResetToken));

        await act(async () => { release(attached('AAA')); await done; });
        expect(getDefaultStore().get(atoms.pendingAttachmentTokens)).toEqual([]);
    });

    it('drops the files when the composer is reset mid-attach', async () => {
        // A send, new thread, or thread switch replaces the composition these
        // files were staged for; adding them would put them on the next message.
        attachExternalFileMock.mockImplementationOnce(async () => {
            getDefaultStore().set(atoms.composerResetToken, 1);
            return attached('AAA');
        });
        const attach = await mountHook();

        const result = await act(async () => attach(['/a.pdf']));

        expect(result!.discarded).toBe(true);
        expect(result!.attached).toEqual([]);
        expect(addedRecords).toHaveLength(0);
    });

    it('does nothing for an empty list', async () => {
        const attach = await mountHook();

        const result = await act(async () => attach([]));

        expect(attachExternalFileMock).not.toHaveBeenCalled();
        expect(result!.rejectedCount).toBe(0);
        expect(popupMessages).toHaveLength(0);
    });
});
