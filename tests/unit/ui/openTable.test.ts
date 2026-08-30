import { beforeEach, describe, expect, it, vi } from 'vitest';

const getPref = vi.hoisted(() => vi.fn());
const canOpenTableTab = vi.hoisted(() => vi.fn());
const openTableTab = vi.hoisted(() => vi.fn());
const readTable = vi.hoisted(() => vi.fn());
const resolveTableItem = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/prefs', () => ({
    getPref,
    setPref: vi.fn(),
    clearPref: vi.fn(),
}));

vi.mock('../../../src/ui/tableTab', () => ({
    canOpenTableTab,
    openTableTab,
    zoteroLinksFor: vi.fn(() => ({})),
}));

vi.mock('../../../src/services/artifacts/tableItemIdentity', () => ({
    readTable,
    resolveTableItem,
}));

import {
    canOpenTable,
    openTable,
    resolveTableTarget,
} from '../../../src/ui/openTable';

const REF = { libraryID: 1, key: 'TABLEKEY' };
const SPEC = { id: 't1', title: 'Table', columns: [], rows: [] };

const win = {} as unknown as Window;

let readerOpen: ReturnType<typeof vi.fn>;

function stubZotero(): void {
    readerOpen = vi.fn().mockResolvedValue(undefined);
    (Zotero as any).getMainWindow = vi.fn(() => win);
    (Zotero as any).Reader = { open: readerOpen };
}

function fileItem(path: string | null) {
    return { id: 42, key: REF.key, libraryID: REF.libraryID, getFilePathAsync: vi.fn().mockResolvedValue(path) };
}

beforeEach(() => {
    vi.clearAllMocks();
    stubZotero();
    getPref.mockReturnValue('tab');
    canOpenTableTab.mockReturnValue(true);
    openTableTab.mockReturnValue('tab-1');
    readTable.mockResolvedValue({ spec: SPEC, version: 3 });
    resolveTableItem.mockResolvedValue(fileItem('/tmp/table.html'));
});

describe('resolveTableTarget', () => {
    it('prefers an explicit target over the preference', () => {
        getPref.mockReturnValue('reader');
        expect(resolveTableTarget('tab')).toBe('tab');
        expect(resolveTableTarget('reader')).toBe('reader');
    });

    it('falls back to the preference when no target is given', () => {
        getPref.mockReturnValue('reader');
        expect(resolveTableTarget()).toBe('reader');
        getPref.mockReturnValue('tab');
        expect(resolveTableTarget()).toBe('tab');
    });

    it('reads an unrecognised or unreadable preference as the tab', () => {
        getPref.mockReturnValue('window');
        expect(resolveTableTarget()).toBe('tab');
        getPref.mockReturnValue(undefined);
        expect(resolveTableTarget()).toBe('tab');
        getPref.mockImplementation(() => {
            throw new Error('prefs unavailable');
        });
        expect(resolveTableTarget()).toBe('tab');
    });
});

describe('canOpenTable', () => {
    it('is true while either surface exists', () => {
        expect(canOpenTable(win)).toBe(true);

        canOpenTableTab.mockReturnValue(false);
        expect(canOpenTable(win)).toBe(true);

        (Zotero as any).Reader = {};
        expect(canOpenTable(win)).toBe(false);
    });
});

describe('openTable', () => {
    it('renders the stored spec into a tab, reading it through the store', async () => {
        const result = await openTable(REF, { where: 'tab', win });

        expect(result).toEqual({ opened: 'tab' });
        expect(readTable).toHaveBeenCalledWith(REF);
        expect(openTableTab).toHaveBeenCalledWith(SPEC, expect.objectContaining({ win }));
        expect(readerOpen).not.toHaveBeenCalled();
    });

    it('opens the item in the reader when that is the target', async () => {
        const result = await openTable(REF, { where: 'reader', win });

        expect(result).toEqual({ opened: 'reader' });
        expect(readerOpen).toHaveBeenCalledWith(42);
        expect(openTableTab).not.toHaveBeenCalled();
    });

    it('follows the preference when no target is given', async () => {
        getPref.mockReturnValue('reader');

        await expect(openTable(REF, { win })).resolves.toEqual({ opened: 'reader' });
    });

    it('falls back to the reader when the tab API is missing, and says so', async () => {
        canOpenTableTab.mockReturnValue(false);

        const result = await openTable(REF, { where: 'tab', win });

        expect(result).toEqual({ opened: 'reader' });
        expect(readerOpen).toHaveBeenCalledWith(42);
    });

    it('falls back to the tab when the table has no file on disk', async () => {
        resolveTableItem.mockResolvedValue(fileItem(null));

        const result = await openTable(REF, { where: 'reader', win });

        expect(result).toEqual({ opened: 'tab' });
        expect(openTableTab).toHaveBeenCalled();
    });

    it('returns an error naming both refusals when neither surface works', async () => {
        canOpenTableTab.mockReturnValue(false);
        resolveTableItem.mockResolvedValue(fileItem(null));

        const result = await openTable(REF, { where: 'tab', win });

        expect(result).toHaveProperty('error');
        const { error } = result as { error: string };
        expect(error).toContain('tab:');
        expect(error).toContain('reader:');
        expect(error).toContain(REF.key);
    });

    it('never throws: a store read that rejects becomes a returned error', async () => {
        readTable.mockRejectedValue(new Error('no spec in file'));
        resolveTableItem.mockRejectedValue(new Error('not a table'));

        const result = await openTable(REF, { where: 'tab', win });

        expect(result).toEqual({
            error: expect.stringContaining('no spec in file'),
        });
        expect(result).toEqual({ error: expect.stringContaining('not a table') });
    });

    it('reports the tab as unavailable when the tab could not be added', async () => {
        openTableTab.mockReturnValue(null);

        await expect(openTable(REF, { where: 'tab', win })).resolves.toEqual({
            opened: 'reader',
        });
    });
});
