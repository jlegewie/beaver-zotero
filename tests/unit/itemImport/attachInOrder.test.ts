import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

const mocks = vi.hoisted(() => ({
    downloadAttachmentFile: vi.fn(),
    saveDownloadedAttachment: vi.fn(),
    discardDownloadedFile: vi.fn(async () => {}),
    scheduleBackgroundTask: vi.fn(),
}));

vi.mock('../../../src/services/pdfAttachmentFetch', () => ({
    downloadAttachmentFile: mocks.downloadAttachmentFile,
    saveDownloadedAttachment: mocks.saveDownloadedAttachment,
    discardDownloadedFile: mocks.discardDownloadedFile,
}));
vi.mock('../../../src/services/libraryMutations', () => ({
    coordinateLibraryMutation: vi.fn(async (work: () => Promise<unknown>) => work()),
}));
vi.mock('../../../src/services/committedTransaction', () => ({
    runCommittedTransaction: vi.fn(async (work: () => Promise<unknown>) => work()),
}));
vi.mock('../../../src/utils/backgroundTasks', () => ({
    generateTaskId: vi.fn(() => 'task'),
    scheduleBackgroundTask: mocks.scheduleBackgroundTask,
}));

import { attachInOrder, scheduleAttachInOrderTask } from '../../../src/services/itemImport/attachInOrder';

const Z = Zotero as any;
const files = [
    { url: 'https://cdn.example/Prot_002.pdf', title: 'Study Protocol (2019-03-29)', content_type: 'application/pdf' },
    { url: 'https://cdn.example/SAP_003.pdf', title: 'Statistical Analysis Plan (2020-07-03)', content_type: 'application/pdf' },
];
const parent = { id: 1, libraryID: 1, key: 'PARENTAA' } as any;

function attachment(key: string, dateAdded: string) {
    const item: any = {
        key,
        dateAdded,
        setField: vi.fn((name: string, value: string) => { if (name === 'dateAdded') item.dateAdded = value; }),
        save: vi.fn(async () => {}),
    };
    return item;
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.downloadAttachmentFile.mockImplementation(async (resolvers: any[]) => ({ directory: `/tmp/${resolvers[0].url}`, url: resolvers[0].url }));
    Z.Date.sqlToDate = (value: string) => new Date(`${value.replace(' ', 'T')}Z`);
    Z.Date.dateToSQL = (date: Date) => date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
    Z.getString = () => 'Full Text';
});

describe('attachInOrder', () => {
    it('saves the files in list order with their titles; the first is the primary', async () => {
        const protocol = attachment('PROT0001', '2026-11-02 12:00:00');
        const sap = attachment('SAP00001', '2026-11-02 12:00:05');
        mocks.saveDownloadedAttachment.mockResolvedValueOnce({ attachment: protocol, created: true })
            .mockResolvedValueOnce({ attachment: sap, created: true });
        const result = await attachInOrder(parent, files, new AbortController().signal, () => {});
        expect(mocks.downloadAttachmentFile).toHaveBeenCalledWith(
            [{ url: files[0].url, accessMethod: 'record' }], expect.anything(), expect.anything());
        expect(mocks.saveDownloadedAttachment.mock.calls.map((call) => call[2].title)).toEqual([files[0].title, files[1].title]);
        expect(result.primary).toBe(protocol);
        expect(result.attached).toEqual([protocol, sap]);
        expect(sap.setField).not.toHaveBeenCalled();
    });

    it('moves a file saved in the same second one second after the previous one', async () => {
        const protocol = attachment('PROT0001', '2026-11-02 12:00:00');
        const sap = attachment('SAP00001', '2026-11-02 12:00:00');
        mocks.saveDownloadedAttachment.mockResolvedValueOnce({ attachment: protocol, created: true })
            .mockResolvedValueOnce({ attachment: sap, created: true });
        await attachInOrder(parent, files, new AbortController().signal, () => {});
        expect(sap.setField).toHaveBeenCalledWith('dateAdded', '2026-11-02 12:00:01');
        expect(sap.save).toHaveBeenCalled();
        expect(protocol.setField).not.toHaveBeenCalled();
    });

    it('keeps a saved file as attached when only its ordering fails', async () => {
        const protocol = attachment('PROT0001', '2026-11-02 12:00:00');
        const sap = attachment('SAP00001', '2026-11-02 12:00:00');
        sap.save.mockRejectedValueOnce(new Error('Library is excluded or unavailable'));
        mocks.saveDownloadedAttachment.mockResolvedValueOnce({ attachment: protocol, created: true })
            .mockResolvedValueOnce({ attachment: sap, created: true });
        const result = await attachInOrder(parent, files, new AbortController().signal, () => {});
        expect(result.attached).toEqual([protocol, sap]);
        expect(result.primary).toBe(protocol);
    });

    it('promotes the next file when the primary fails to download', async () => {
        const sap = attachment('SAP00001', '2026-11-02 12:00:00');
        mocks.downloadAttachmentFile.mockRejectedValueOnce(new Error('HTTP 404'))
            .mockImplementationOnce(async (resolvers: any[]) => ({ directory: '/tmp/sap', url: resolvers[0].url }));
        mocks.saveDownloadedAttachment.mockResolvedValueOnce({ attachment: sap, created: true });
        const result = await attachInOrder(parent, files, new AbortController().signal, () => {});
        expect(mocks.saveDownloadedAttachment).toHaveBeenCalledTimes(1);
        expect(result.primary).toBe(sap);
    });

    it('discards every download when access is revoked before the first save', async () => {
        let revoked = false;
        mocks.downloadAttachmentFile.mockImplementation(async (resolvers: any[]) => {
            const file = { directory: `/tmp/${resolvers[0].url}`, url: resolvers[0].url };
            revoked = true;
            return file;
        });
        const assertAccess = () => { if (revoked) throw new Error('Library is excluded or unavailable'); };
        await expect(attachInOrder(parent, files, new AbortController().signal, assertAccess)).rejects.toThrow('excluded');
        expect(mocks.saveDownloadedAttachment).not.toHaveBeenCalled();
        expect(mocks.discardDownloadedFile.mock.calls.map((call) => call[0]?.url).filter(Boolean)).toEqual(files.map((f) => f.url));
    });

    it('discards downloads it never saved when cancelled', async () => {
        const controller = new AbortController();
        mocks.saveDownloadedAttachment.mockImplementationOnce(async () => {
            controller.abort();
            throw new Error('cancelled');
        });
        await expect(attachInOrder(parent, files, controller.signal, () => {})).rejects.toThrow();
        expect(mocks.discardDownloadedFile).toHaveBeenCalledWith(expect.objectContaining({ url: files[1].url }));
    });
});

describe('scheduleAttachInOrderTask', () => {
    it('reports the primary file as the attachment', async () => {
        Z.Beaver = { libraryScopeInitialized: true, searchableLibraryIds: [1], account: { getGeneration: () => 1 } };
        Z.Libraries.get = vi.fn(() => ({ editable: true, filesEditable: true }));
        Z.Items = { ...(Z.Items ?? {}), getByLibraryAndKeyAsync: vi.fn(async () => parent) };
        const protocol = attachment('PROT0001', '2026-11-02 12:00:00');
        mocks.saveDownloadedAttachment.mockResolvedValue({ attachment: protocol, created: true });
        const onAttachmentResolved = vi.fn();
        scheduleAttachInOrderTask(1, 'PARENTAA', [files[0]], { actionId: 'a1', onAttachmentResolved });
        const task = mocks.scheduleBackgroundTask.mock.calls[0][2];
        await task(new AbortController().signal);
        expect(onAttachmentResolved).toHaveBeenCalledWith(expect.objectContaining({
            actionId: 'a1',
            attachmentStatus: 'available',
            attachmentKey: '1-PROT0001',
            accessMethod: 'record',
        }));
    });
});
