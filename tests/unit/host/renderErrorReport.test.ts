import { beforeEach, describe, expect, it, vi } from 'vitest';

const { set } = vi.hoisted(() => ({ set: vi.fn() }));
vi.mock('../../../react/store', () => ({ store: { set } }));
vi.mock('../../../react/runtime/windowRuntime', () => ({ getHostWindow: vi.fn() }));
vi.mock('../../../react/atoms/ui', () => ({
    errorReportTextAtom: 'errorReportTextAtom',
    isErrorReportDialogVisibleAtom: 'isErrorReportDialogVisibleAtom',
}));

import { zoteroDialogs } from '../../../react/host/zotero/dialogs';

describe('Zotero render error report', () => {
    beforeEach(() => vi.clearAllMocks());

    it('opens the report form with the notice text filled in', () => {
        zoteroDialogs.reportRenderError!('Something went wrong.\nChat ID: thread-1');
        expect(set).toHaveBeenNthCalledWith(1, 'errorReportTextAtom', 'Something went wrong.\nChat ID: thread-1');
        expect(set).toHaveBeenNthCalledWith(2, 'isErrorReportDialogVisibleAtom', true);
    });
});
