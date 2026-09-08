/**
 * `openTable`: the one way a stored table gets on screen.
 *
 * A stored table has a single surface — Zotero's snapshot reader — so what is
 * tested here is the contract around that: the preflight that keeps the reader
 * off a table with no file, and the promise that nothing throws, because every
 * caller is a UI path that has to degrade rather than raise.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolveTableItem = vi.hoisted(() => vi.fn());

vi.mock('../../../src/services/artifacts/tableItemIdentity', () => ({
    resolveTableItem,
}));

import { openTable } from '../../../src/ui/openTable';

const REF = { libraryID: 1, key: 'TABLEKEY' };

let readerOpen: ReturnType<typeof vi.fn>;

function fileItem(path: string | null) {
    return {
        id: 42,
        key: REF.key,
        libraryID: REF.libraryID,
        getFilePathAsync: vi.fn().mockResolvedValue(path),
    };
}

let prefs: Record<string, unknown>;

beforeEach(() => {
    vi.clearAllMocks();
    prefs = {};
    readerOpen = vi.fn().mockResolvedValue(undefined);
    (Zotero as any).Reader = { open: readerOpen };
    (Zotero as any).Prefs = { get: vi.fn((key: string) => prefs[key]) };
    resolveTableItem.mockResolvedValue(fileItem('/tmp/table.html'));
});

describe('openTable', () => {
    it('opens the table item in the reader', async () => {
        await expect(openTable(REF)).resolves.toEqual({ ok: true });
        expect(readerOpen).toHaveBeenCalledWith(42, undefined, {
            openInWindow: false,
            allowDuplicate: false,
        });
    });

    it("honours Zotero's own openReaderInNewWindow preference", async () => {
        // Zotero's other open paths pass this through `FileHandlers.open`, so
        // the item-pane button has to as well or it contradicts the setting.
        prefs.openReaderInNewWindow = true;

        await expect(openTable(REF)).resolves.toEqual({ ok: true });
        // `allowDuplicate` tracks it, exactly as `FileHandlers.open` does:
        // without it `Zotero.Reader.open` selects any existing tab for the item
        // — including a session-restored unloaded one — and never reaches the
        // window branch, so the table would open in a tab instead.
        expect(readerOpen).toHaveBeenCalledWith(42, undefined, {
            openInWindow: true,
            allowDuplicate: true,
        });
    });

    it('still opens when the preference cannot be read', async () => {
        (Zotero as any).Prefs.get = vi.fn(() => {
            throw new Error('prefs unavailable');
        });

        await expect(openTable(REF)).resolves.toEqual({ ok: true });
        expect(readerOpen).toHaveBeenCalledWith(42, undefined, {
            openInWindow: false,
            allowDuplicate: false,
        });
    });

    it('refuses on a build with no reader API, without looking the item up', async () => {
        (Zotero as any).Reader = undefined;

        const result = await openTable(REF);

        expect(result).toEqual({ error: expect.stringContaining('no reader API') });
        expect(resolveTableItem).not.toHaveBeenCalled();
    });

    it('refuses before opening when the table has no file on disk', async () => {
        resolveTableItem.mockResolvedValue(fileItem(null));

        const result = await openTable(REF);

        expect(result).toEqual({ error: expect.stringContaining('no file on disk') });
        expect(result).toEqual({ error: expect.stringContaining(REF.key) });
        // The reader on a fileless snapshot is an error dialog, so it is never
        // reached — the caller gets a message it can use instead.
        expect(readerOpen).not.toHaveBeenCalled();
    });

    it('never throws: a lookup that rejects becomes a returned error', async () => {
        resolveTableItem.mockRejectedValue(new Error('Item NOSUCH is not a table.'));

        // The thrown message carries its own period, so the wrapper adds none —
        // `... is not a table..` reads like a typo wherever it is logged.
        await expect(openTable(REF)).resolves.toEqual({
            error: `Could not open table ${REF.key} — Item NOSUCH is not a table.`,
        });
    });

    it('never throws: a reader open that rejects becomes a returned error', async () => {
        readerOpen.mockRejectedValue(new Error('reader exploded'));

        await expect(openTable(REF)).resolves.toEqual({
            error: expect.stringContaining('reader exploded'),
        });
    });
});
