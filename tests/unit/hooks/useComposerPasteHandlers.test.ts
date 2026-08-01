// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// =============================================================================
// Module mocks — the paste path reaches the clipboard and Zotero services.
// =============================================================================

const clipboard = vi.hoisted(() => ({
    writePastedFileToTemp: vi.fn(),
    readClipboardFilePath: vi.fn(),
    readClipboardImageToTemp: vi.fn(),
    removeTempFile: vi.fn(),
}));
vi.mock('../../../src/services/clipboardFiles', () => ({
    clipboardHasFile: () => false,
    clipboardHasImage: () => false,
    writePastedFileToTemp: clipboard.writePastedFileToTemp,
    readClipboardFilePath: clipboard.readClipboardFilePath,
    readClipboardImageToTemp: clipboard.readClipboardImageToTemp,
    removeTempFile: clipboard.removeTempFile,
}));

const attachExternalFileMock = vi.fn();
vi.mock('../../../src/services/externalFiles', () => ({
    attachExternalFile: (...args: unknown[]) => attachExternalFileMock(...args),
}));

vi.mock('../../../src/utils/prefs', () => ({
    getPref: () => 10,
    setPref: vi.fn(),
}));

const atoms = vi.hoisted(() => ({} as {
    composerResetToken: any;
    pendingAttachmentCount: any;
    selectedModel: any;
    requestPlusTools: any;
}));

vi.mock('../../../react/atoms/messageComposition', async () => {
    const { atom } = await import('jotai');
    atoms.composerResetToken = atom(0);
    atoms.pendingAttachmentCount = atom(0);
    return {
        addExternalFilesToCurrentMessageAtom: atom(null, () => {}),
        composerResetTokenAtom: atoms.composerResetToken,
        pendingAttachmentCountAtom: atoms.pendingAttachmentCount,
    };
});

vi.mock('../../../react/atoms/models', async () => {
    const { atom } = await import('jotai');
    atoms.selectedModel = atom({ supports_vision: true });
    return { selectedModelAtom: atoms.selectedModel };
});

vi.mock('../../../react/atoms/ui', async () => {
    const { atom } = await import('jotai');
    atoms.requestPlusTools = atom(false);
    return { requestPlusToolsAtom: atoms.requestPlusTools };
});

const popupMessages: { text?: string }[] = [];
vi.mock('../../../react/utils/popupMessageUtils', async () => {
    const { atom } = await import('jotai');
    return {
        addPopupMessageAtom: atom(null, (_get, _set, message: { text?: string }) => {
            popupMessages.push(message);
        }),
    };
});

import { getDefaultStore } from 'jotai';
import { useComposerPasteHandlers } from '../../../react/hooks/useComposerPasteHandlers';
import type { ComposerPasteHandlers } from '../../../react/components/input/lexical/LexicalEditorInput';

const mounted: { root: ReturnType<typeof createRoot>; container: HTMLDivElement }[] = [];

async function mountHook(): Promise<ComposerPasteHandlers> {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    let handlers: ComposerPasteHandlers | null = null;
    const container = globalThis.document.createElement('div');
    globalThis.document.body.append(container);
    const root = createRoot(container);
    mounted.push({ root, container });
    function Harness() {
        handlers = useComposerPasteHandlers();
        return null;
    }
    await act(async () => root.render(React.createElement(Harness)));
    return handlers!;
}

const pendingCount = () => getDefaultStore().get(atoms.pendingAttachmentCount);
const fakeFile = (name = 'image.png') => ({ name, type: 'image/png' }) as unknown as File;

describe('useComposerPasteHandlers', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        popupMessages.length = 0;
        getDefaultStore().set(atoms.pendingAttachmentCount, 0);
        getDefaultStore().set(atoms.composerResetToken, 0);
        clipboard.removeTempFile.mockResolvedValue(undefined);
        attachExternalFileMock.mockResolvedValue({ status: 'attached', record: { extKey: 'AAA' } });
    });

    afterEach(async () => {
        await act(async () => {
            for (const { root } of mounted) root.unmount();
        });
        for (const { container } of mounted) container.remove();
        mounted.length = 0;
    });

    it('holds sending while the pasted bytes are still being copied to disk', async () => {
        // The copy runs before the attach, so the hold has to span it too.
        let pendingDuringCopy = -1;
        clipboard.writePastedFileToTemp.mockImplementation(async () => {
            pendingDuringCopy = pendingCount();
            return '/tmp/beaver-paste-1/pasted-image-1.png';
        });
        const handlers = await mountHook();

        await act(async () => {
            handlers.onPasteFiles!([fakeFile()]);
            await vi.waitFor(() => expect(attachExternalFileMock).toHaveBeenCalled());
        });

        expect(pendingDuringCopy).toBe(1);
        await act(async () => vi.waitFor(() => expect(pendingCount()).toBe(0)));
    });

    it('releases the hold when the paste fails', async () => {
        clipboard.writePastedFileToTemp.mockRejectedValue(new Error('out of disk'));
        const handlers = await mountHook();

        await act(async () => {
            handlers.onPasteFiles!([fakeFile()]);
            await vi.waitFor(() => expect(popupMessages).toHaveLength(1));
        });

        // A stuck count would leave the composer unable to send.
        expect(pendingCount()).toBe(0);
    });

    it('reports a paste whose bytes could not be read', async () => {
        clipboard.writePastedFileToTemp.mockResolvedValue(null);
        const handlers = await mountHook();

        await act(async () => {
            handlers.onPasteFiles!([fakeFile()]);
            await vi.waitFor(() => expect(popupMessages).toHaveLength(1));
        });

        expect(popupMessages[0].text).toBe('The pasted content could not be read.');
        expect(attachExternalFileMock).not.toHaveBeenCalled();
    });

    it('attaches a clipboard file from its own path, with no temp copy', async () => {
        clipboard.readClipboardFilePath.mockReturnValue('/Users/me/paper.pdf');
        const handlers = await mountHook();

        await act(async () => {
            handlers.onPasteFromClipboard!();
            await vi.waitFor(() => expect(attachExternalFileMock).toHaveBeenCalled());
        });

        expect(attachExternalFileMock).toHaveBeenCalledWith('/Users/me/paper.pdf', expect.anything());
        expect(clipboard.removeTempFile).not.toHaveBeenCalled();
        expect(popupMessages).toHaveLength(0);
    });

    it('discards the temp copy once a clipboard image is attached', async () => {
        clipboard.readClipboardFilePath.mockReturnValue(null);
        clipboard.readClipboardImageToTemp.mockResolvedValue('/tmp/beaver-paste-2/pasted-image-1.png');
        const handlers = await mountHook();

        await act(async () => {
            handlers.onPasteFromClipboard!();
            await vi.waitFor(() => expect(clipboard.removeTempFile).toHaveBeenCalled());
        });

        expect(clipboard.removeTempFile).toHaveBeenCalledWith('/tmp/beaver-paste-2/pasted-image-1.png');
    });

    it('reports a clipboard that yielded nothing attachable', async () => {
        clipboard.readClipboardFilePath.mockReturnValue(null);
        clipboard.readClipboardImageToTemp.mockResolvedValue(null);
        const handlers = await mountHook();

        await act(async () => {
            handlers.onPasteFromClipboard!();
            await vi.waitFor(() => expect(popupMessages).toHaveLength(1));
        });

        expect(attachExternalFileMock).not.toHaveBeenCalled();
    });
});
