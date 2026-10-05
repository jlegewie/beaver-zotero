import { describe, expect, it, vi } from 'vitest';
import { exportWithFeedback } from '../../../react/utils/fileExportFeedback';

describe('exportWithFeedback', () => {
    it('confirms a saved file with its warnings and a way to reveal it', async () => {
        const notify = vi.fn();
        const reveal = vi.fn();
        await exportWithFeedback(
            'docx',
            async () => ({ status: 'saved', path: '/tmp/a.docx', fileName: 'a.docx', warnings: ['1 equation exported as LaTeX text.'] }),
            notify,
            reveal,
        );
        expect(notify).toHaveBeenCalledWith(expect.objectContaining({
            type: 'info',
            title: 'Exported to Word',
            text: 'a.docx — 1 equation exported as LaTeX text.',
        }));
        notify.mock.calls[0][0].button.onClick();
        expect(reveal).toHaveBeenCalledWith('/tmp/a.docx');
    });

    it('names the format the file was exported to', async () => {
        const notify = vi.fn();
        await exportWithFeedback('pdf', async () => ({ status: 'saved', path: '/tmp/a.pdf', fileName: 'a.pdf', warnings: [] }), notify);
        expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: 'Exported to PDF', text: 'a.pdf' }));
    });

    it('says nothing when the save dialog is canceled and reports failures', async () => {
        const notify = vi.fn();
        await exportWithFeedback('pdf', async () => ({ status: 'canceled' }), notify);
        expect(notify).not.toHaveBeenCalled();
        await exportWithFeedback('pdf', async () => { throw new Error('Disk full'); }, notify);
        expect(notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', text: 'Disk full' }));
    });
});
