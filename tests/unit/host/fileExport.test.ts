import { beforeEach, describe, expect, it, vi } from 'vitest';

const runs: unknown[] = [];

vi.mock('../../../react/store', () => ({ store: { get: vi.fn(() => runs) } }));
vi.mock('../../../react/runtime/windowRuntime', () => ({ getWindowRuntime: () => ({ id: 'win-1' }) }));
vi.mock('../../../react/utils/exportSource', () => ({
    buildNoteExportSource: vi.fn(async () => ({ kind: 'note', title: 'As written' })),
    buildResponseExportSource: vi.fn(),
    buildThreadExportSource: vi.fn(),
}));

import { exportNoteToFile } from '../../../react/host/zotero/fileExport';
import { buildNoteExportSource } from '../../../react/utils/exportSource';

const saved = (warnings: string[] = []) => ({
    status: 'saved',
    path: '/out/Review.docx',
    files: ['/out/Review.docx'],
    warnings: warnings.map(message => ({ code: 'x', message })),
    stats: {},
});

describe('exportNoteToFile', () => {
    const exporter = { run: vi.fn(), exportNote: vi.fn() };

    beforeEach(() => {
        vi.clearAllMocks();
        runs.length = 0;
        runs.push({ id: 'run-1' });
        (globalThis as any).Zotero = { Beaver: { exporter } };
        (globalThis as any).PathUtils = {
            parent: (path: string) => path.slice(0, path.lastIndexOf('/')),
            filename: (path: string) => path.slice(path.lastIndexOf('/') + 1),
        };
    });

    it('exports the note as it is now in Zotero', async () => {
        exporter.exportNote.mockResolvedValue(saved(['1 image left out.']));

        const result = await exportNoteToFile({
            runId: 'run-1', toolCallId: 'tc-1', format: 'docx',
            note: { library_ref: 'u', library_id: 1, zotero_key: 'NOTEKEY1' },
        });

        expect(exporter.exportNote).toHaveBeenCalledWith(
            { note: { key: 'NOTEKEY1', libraryRef: 'u', libraryID: 1 }, format: 'docx' },
            { windowId: 'win-1' },
        );
        expect(exporter.run).not.toHaveBeenCalled();
        expect(result).toMatchObject({ status: 'saved', fileName: 'Review.docx', warnings: ['1 image left out.'] });
    });

    it('exports the version the agent wrote when the note was deleted, and says so', async () => {
        exporter.exportNote.mockRejectedValue(Object.assign(new Error('The note could not be found.'), { code: 'note_not_found' }));
        exporter.run.mockResolvedValue(saved());

        const result = await exportNoteToFile({
            runId: 'run-1', toolCallId: 'tc-1', format: 'pdf', note: { zotero_key: 'NOTEKEY1' },
        });

        expect(buildNoteExportSource).toHaveBeenCalledWith({ id: 'run-1' }, 'tc-1');
        expect(exporter.run).toHaveBeenCalledWith({ source: { kind: 'note', title: 'As written' }, format: 'pdf' }, { windowId: 'win-1' });
        expect(result).toMatchObject({ status: 'saved', warnings: ['The note is no longer in your library. Exported the version Beaver wrote.'] });
    });

    it('exports the version the agent wrote when the note was never created', async () => {
        exporter.run.mockResolvedValue(saved());

        const result = await exportNoteToFile({ runId: 'run-1', toolCallId: 'tc-1', format: 'markdown', note: null });

        expect(exporter.exportNote).not.toHaveBeenCalled();
        expect(result).toMatchObject({ warnings: ['The note is not in your library. Exported the version Beaver wrote.'] });
    });

    it('reports other export failures instead of falling back', async () => {
        exporter.exportNote.mockRejectedValue(new Error('disk full'));

        await expect(exportNoteToFile({
            runId: 'run-1', toolCallId: 'tc-1', format: 'docx', note: { zotero_key: 'NOTEKEY1' },
        })).rejects.toThrow('disk full');
        expect(exporter.run).not.toHaveBeenCalled();
    });

    it('reports a canceled save dialog as canceled', async () => {
        exporter.exportNote.mockResolvedValue({ status: 'canceled' });

        const result = await exportNoteToFile({
            runId: 'run-1', toolCallId: 'tc-1', format: 'docx', note: { zotero_key: 'NOTEKEY1' },
        });

        expect(result).toEqual({ status: 'canceled' });
    });
});
