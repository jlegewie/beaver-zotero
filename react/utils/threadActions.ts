import { currentThreadIdAtom } from '@beaver/agent-core/run-state/atoms';
import { getCredentialGeneration } from '@beaver/agent-core/transport/credentials';
import { store } from '../store';
import { newThreadAtom } from '../atoms/threads';
import { getWindowRuntime } from '../runtime/windowRuntime';

/**
 * Asks the user to confirm, then deletes the chat. If it was the open chat,
 * a new one is started in `win`. Resolves to whether the chat was deleted.
 */
export async function confirmAndDeleteThread(threadId: string, win: Window): Promise<boolean> {
    const buttonIndex = Zotero.Prompt.confirm({
        window: win,
        title: 'Delete chat?',
        text: 'Are you sure you want to delete this chat? This action cannot be undone.',
        button0: Zotero.Prompt.BUTTON_TITLE_YES,
        button1: Zotero.Prompt.BUTTON_TITLE_NO,
        defaultButton: 1,
    });
    if (buttonIndex !== 0) return false;
    try {
        await Zotero.Beaver.threads.deleteThread(threadId, getWindowRuntime().id, getCredentialGeneration());
        // The delete was confirmed; leave only if this is still the open chat.
        if (threadId === store.get(currentThreadIdAtom)) {
            await store.set(newThreadAtom, { skipActiveRunConfirm: true, window: win });
        }
        return true;
    } catch (error) {
        console.error('Error deleting thread:', error);
        return false;
    }
}

/** Renames the chat. Blank names are ignored; failures are logged, not thrown. */
export async function renameThread(threadId: string, name: string): Promise<void> {
    const trimmed = name.trim();
    if (!threadId || !trimmed) return;
    try {
        await Zotero.Beaver.threads.renameThread(threadId, trimmed);
    } catch (error) {
        console.error('Error renaming thread:', error);
    }
}
