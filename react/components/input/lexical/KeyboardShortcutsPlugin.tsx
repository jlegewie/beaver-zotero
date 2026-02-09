import { useEffect } from 'react';
import {
    KEY_DOWN_COMMAND,
    COMMAND_PRIORITY_HIGH,
} from 'lexical';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';

interface KeyboardShortcutsPluginProps {
    onSubmit: () => void;
    onNewThread: () => void;
    onCustomPrompt: (i: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9) => void;
    onAtTrigger: () => void;
    disabled?: boolean;
    isAwaitingApproval?: boolean;
}

export default function KeyboardShortcutsPlugin({
    onSubmit,
    onNewThread,
    onCustomPrompt,
    onAtTrigger,
    disabled = false,
    isAwaitingApproval = false,
}: KeyboardShortcutsPluginProps): null {
    const [editor] = useLexicalComposerContext();

    useEffect(() => {
        const removeKeyDown = editor.registerCommand(
            KEY_DOWN_COMMAND,
            (event: KeyboardEvent) => {
                const isMac = Zotero.isMac;
                const modKey = isMac ? event.metaKey : event.ctrlKey;

                // Enter to submit (no Shift, not disabled, not awaiting approval)
                if (event.key === 'Enter' && !event.shiftKey && !disabled && !isAwaitingApproval) {
                    event.preventDefault();
                    onSubmit();
                    return true;
                }

                // Cmd+N / Ctrl+N for new thread
                if ((event.key === 'n' || event.key === 'N') && modKey) {
                    event.preventDefault();
                    onNewThread();
                    return true;
                }

                // Cmd+Ctrl+1-6 for custom prompts
                for (let i = 1; i <= 6; i++) {
                    if (
                        event.key === i.toString() &&
                        ((isMac && event.metaKey && event.ctrlKey) ||
                            (!isMac && event.ctrlKey && event.metaKey))
                    ) {
                        event.preventDefault();
                        onCustomPrompt(i as 1 | 2 | 3 | 4 | 5 | 6);
                        return true;
                    }
                }

                // @ trigger: detect Shift+2 (US) or any key that produces '@'
                // We check event.key === '@' which works for all keyboard layouts
                if (event.key === '@' && !isAwaitingApproval) {
                    event.preventDefault();
                    onAtTrigger();
                    return true;
                }

                return false;
            },
            COMMAND_PRIORITY_HIGH,
        );

        return () => {
            removeKeyDown();
        };
    }, [editor, onSubmit, onNewThread, onCustomPrompt, onAtTrigger, disabled, isAwaitingApproval]);

    return null;
}
