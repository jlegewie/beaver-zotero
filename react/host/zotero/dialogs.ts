import { getHostWindow } from '../../runtime/windowRuntime';
import type { DialogsHost } from '@beaver/agent-ui/host/types';
import { store } from '../../store';
import { errorReportTextAtom, isErrorReportDialogVisibleAtom } from '../../atoms/ui';

/**
 * Zotero implementation of the dialogs host slice: native blocking prompts via
 * `Zotero.Prompt.confirm` on the main window, and the in-app error report form.
 * Cancel is always the default button so Enter never confirms a
 * destructive/irreversible choice.
 */
export const zoteroDialogs: DialogsHost = {
    confirm({ title, text, confirmLabel, window: hostWindow }): boolean {
        const buttonIndex = Zotero.Prompt.confirm({
            window: hostWindow ?? getHostWindow(),
            title,
            text,
            button0: confirmLabel,
            button1: Zotero.Prompt.BUTTON_TITLE_CANCEL,
            defaultButton: 1,
        });
        return buttonIndex === 0;
    },
    // The click comes from this renderer, whose surfaces share its store and
    // each render the report form's dialog container.
    reportRenderError(text) {
        store.set(errorReportTextAtom, text);
        store.set(isErrorReportDialogVisibleAtom, true);
    },
};
