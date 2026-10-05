import { describe, expect, it, vi } from 'vitest';
import { exportWithFeedback, fileExportMenuItem } from '../../../react/utils/fileExportFeedback';
import type { FileExportResult } from '@beaver/agent-ui/host/types';

function saved(overrides: Partial<Extract<FileExportResult, { status: 'saved' }>> = {}): FileExportResult {
    return {
        status: 'saved',
        path: '/tmp/out/a.docx',
        fileName: 'a.docx',
        folderName: 'out',
        companionFileNames: [],
        warnings: [],
        ...overrides,
    };
}

describe('exportWithFeedback', () => {
    it('confirms a saved file with its folder, warnings and file actions', async () => {
        const notify = vi.fn();
        const reveal = vi.fn(async () => {});
        const open = vi.fn(async () => {});
        await exportWithFeedback(
            'docx',
            async () => saved({ warnings: ['1 equation exported as LaTeX text.'] }),
            notify,
            { reveal, open },
        );
        const message = notify.mock.calls[0][0];
        expect(message).toMatchObject({
            type: 'file_export',
            title: 'Exported to Word',
            fileExport: {
                format: 'docx',
                fileName: 'a.docx',
                folderName: 'out',
                warnings: ['1 equation exported as LaTeX text.'],
            },
        });
        await message.fileExport.onReveal();
        expect(reveal).toHaveBeenCalledWith('/tmp/out/a.docx');
        await message.fileExport.onOpen();
        expect(open).toHaveBeenCalledWith('/tmp/out/a.docx');
    });

    it('names the format and the files written beside the document', async () => {
        const notify = vi.fn();
        await exportWithFeedback('latex', async () => saved({ path: '/tmp/a.tex', fileName: 'a.tex', companionFileNames: ['a.bib'] }), notify);
        expect(notify).toHaveBeenCalledWith(expect.objectContaining({
            title: 'Exported to LaTeX',
            fileExport: expect.objectContaining({ fileName: 'a.tex', companionFileNames: ['a.bib'] }),
        }));
        // No host file actions, no buttons.
        expect(notify.mock.calls[0][0].fileExport.onReveal).toBeUndefined();
        expect(notify.mock.calls[0][0].fileExport.onOpen).toBeUndefined();
    });

    it('reports a file action that fails because the file is gone', async () => {
        const notify = vi.fn();
        const open = vi.fn(async () => { throw new Error('The exported file could not be found.'); });
        await exportWithFeedback('pdf', async () => saved({ path: '/tmp/a.pdf', fileName: 'a.pdf' }), notify, { open });
        await notify.mock.calls[0][0].fileExport.onOpen();
        expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({
            type: 'error',
            title: 'Could not open file',
            text: 'The exported file could not be found.',
        }));
    });

    it('says nothing when the save dialog is canceled and reports failures', async () => {
        const notify = vi.fn();
        await exportWithFeedback('pdf', async () => ({ status: 'canceled' }), notify);
        expect(notify).not.toHaveBeenCalled();
        await exportWithFeedback('pdf', async () => { throw new Error('Disk full'); }, notify);
        expect(notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', text: 'Disk full' }));
    });
});

describe('fileExportMenuItem', () => {
    it('lists every format in a submenu and passes the chosen one on', () => {
        const onSelect = vi.fn();
        const item = fileExportMenuItem(onSelect);
        expect(item.label).toBe('Export');
        expect(item.submenu?.map(entry => entry.label)).toEqual(['Word…', 'PDF…', 'Markdown…', 'LaTeX…']);
        expect(item.submenu?.every(entry => entry.icon)).toBe(true);
        item.submenu?.[2].onClick();
        expect(onSelect).toHaveBeenCalledWith('markdown');
    });

    it('disables the item and its formats together', () => {
        const item = fileExportMenuItem(vi.fn(), true);
        expect(item.disabled).toBe(true);
        expect(item.submenu?.every(entry => entry.disabled)).toBe(true);
    });
});
