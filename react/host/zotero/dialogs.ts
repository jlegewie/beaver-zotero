import type { DialogsHost } from '@beaver/agent-ui/host/types';

/**
 * Zotero implementation of the dialogs host slice: native blocking prompts via
 * `Zotero.Prompt.confirm` on the main window. Cancel is always the default
 * button so Enter never confirms a destructive/irreversible choice.
 */
export const zoteroDialogs: DialogsHost = {
    confirm({ title, text, confirmLabel }): boolean {
        const buttonIndex = Zotero.Prompt.confirm({
            window: Zotero.getMainWindow(),
            title,
            text,
            button0: confirmLabel,
            button1: Zotero.Prompt.BUTTON_TITLE_CANCEL,
            defaultButton: 1,
        });
        return buttonIndex === 0;
    },
};
