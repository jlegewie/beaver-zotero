import { beforeEach, expect, it, vi } from 'vitest';
import { openReader, openNote, viewAttachment } from '../../../react/runtime/navigation';
let a: any, b: any;
beforeEach(() => {
    const main = () => ({ closed: false, focus: vi.fn(), ZoteroPane: {}, Zotero_Tabs: { _tabs: [], select: vi.fn(), isOwnTabEvent: vi.fn() } });
    a = main(); b = main();
    let active = b;
    a.focus.mockImplementation(() => { active = a; });
    vi.stubGlobal('Zotero', {
        getMainWindow: vi.fn(() => active),
        Reader: { open: vi.fn(async (itemID, _location, options) => ({ itemID, _window: options.window })), getByTabID: vi.fn() },
        Notes: { open: vi.fn(async () => undefined), _editorInstances: [] },
    });
});
it('passes A to native reader and note opening while B is active', async () => {
    await openReader(42, { pageIndex: 3 }, {}, a);
    await openNote(17, a);
    expect(Zotero.Reader.open).toHaveBeenCalledWith(42, { pageIndex: 3 }, { window: a });
    expect((Zotero as any).Notes.open).toHaveBeenCalledWith(17, undefined, { window: a });
    expect(b.focus).not.toHaveBeenCalled();
});
it('uses the local copy of a PDF under legacy global duplicate detection', async () => {
    delete a.Zotero_Tabs.isOwnTabEvent;
    a.Zotero_Tabs._tabs = [{ id: 'local', data: { itemID: 42 } }];
    const reader = { itemID: 42, _window: a, navigate: vi.fn(async () => {}) };
    vi.mocked(Zotero.Reader.getByTabID).mockReturnValue(reader as any);
    expect(await openReader(42, { pageIndex: 8 }, {}, a)).toBe(reader);
    expect(a.Zotero_Tabs.select).toHaveBeenCalledWith('local');
    expect(reader.navigate).toHaveBeenCalledWith({ pageIndex: 8 });
    expect(Zotero.Reader.open).not.toHaveBeenCalled();
});
it('allows a new local copy on legacy Zotero instead of selecting another window’s PDF', async () => {
    delete a.Zotero_Tabs.isOwnTabEvent;
    await openReader(42, undefined, {}, a);
    expect(Zotero.Reader.open).toHaveBeenCalledWith(42, undefined, { window: a, allowDuplicate: true });
    expect(a.focus).toHaveBeenCalledOnce();
});
it('rejects a native result from the wrong window and a target closed during opening', async () => {
    vi.mocked(Zotero.Reader.open).mockResolvedValue({ itemID: 42, _window: b } as any);
    await expect(openReader(42, undefined, {}, a)).rejects.toMatchObject({ code: 'window_unavailable' });
    vi.mocked(Zotero.Reader.open).mockImplementation(async () => { a.closed = true; return undefined; });
    await expect(openReader(42, undefined, {}, a)).rejects.toMatchObject({ code: 'window_unavailable' });
});

it('does not open in B when legacy Zotero cannot activate A', async () => {
    delete a.Zotero_Tabs.isOwnTabEvent;
    a.focus.mockImplementation(() => {});
    await expect(openReader(42, undefined, {}, a)).rejects.toMatchObject({ code: 'window_unavailable' });
    await expect(openNote(17, a)).rejects.toMatchObject({ code: 'window_unavailable' });
    expect(Zotero.Reader.open).not.toHaveBeenCalled();
    expect((Zotero as any).Notes.open).not.toHaveBeenCalled();
});

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));
it('contains unavailable-window failures in fire-and-forget attachment opening', async () => {
    a.closed = true;
    await expect(viewAttachment(42, a)).resolves.toBeUndefined();
    await expect(viewAttachment(42)).resolves.toBeUndefined();
});
