import React, { useState, useCallback } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import MenuButton from '@beaver/agent-ui/primitives/MenuButton';
import { MenuItem } from '@beaver/agent-ui/primitives/ContextMenu';
import { MoreHorizontalIcon } from '../../icons/icons';
import { copyToClipboard } from '../../../utils/clipboard';
import { renderToMarkdown, renderToHTML, preprocessNoteContent } from '../../../utils/citationRenderers';
import { getBeaverNoteFooterHTML } from '../../../utils/noteActions';
import { extractThreadContent, ExtractThreadContentOptions } from '../../../utils/threadContent';
import { resolveToolCallLabelEnrichMap } from '../../../utils/toolCallLabelEnrich';
import { allRunsAtom, runsCountAtom, toolResultsMapAtom } from '@beaver/agent-core/run-state/atoms';
import { flushPendingPartEvents } from '../../../utils/streamingPartQueue';
import { currentThreadIdAtom, currentThreadNameAtom, newThreadAtom, recentThreadsAtom, ThreadData } from '../../../atoms/threads';
import {
    currentThreadPinnedAtom,
    setThreadPinnedAtom,
    upsertThreadsAtom,
    threadWriteStampAtom,
    threadViewKey,
    updateThreadAtom,
    removeThreadAtom,
} from '../../../atoms/threadList';
import { citationMapAtom } from '@beaver/agent-core/citations/atoms';
import { externalReferenceItemMappingAtom, externalReferenceMappingAtom } from '@beaver/agent-core/citations/externalReferences';
import { getZoteroTargetContextSync } from '../../../../src/utils/zoteroUtils';
import { getSelectedCollection } from '../../../../src/utils/zoteroSelection';
import { selectItem, selectItemById } from '../../../../src/utils/selectItem';
import { store } from '../../../store';
import { prepareCitationRenderContext } from '../../../utils/citationRenderContext';
import { threadService } from '@beaver/agent-core/transport/threadService';
import { threadModelToThreadData } from '../../../utils/threadMatches';
import { userAtom } from '../../../atoms/auth';
import { showAllThreadInstancesAtom } from '../../../atoms/ui';
import { currentZoteroInstanceRef } from '../../../../src/utils/zoteroUtils';
import { clearRecentChatsCache } from '../../RecentChats';


interface ThreadMenuButtonProps {
    className?: string;
    ariaLabel?: string;
}

const ThreadMenuButton: React.FC<ThreadMenuButtonProps> = ({
    className = '',
    ariaLabel = 'Chat actions',
}) => {
    const [, forceUpdate] = useState({});
    const threadId = useAtomValue(currentThreadIdAtom);
    // Derived from the thread store, so this entry cannot disagree with the
    // chat lists. `null` means the open chat is not in the store yet — a
    // zotero://beaver deep link, or a chat created in this session — which is
    // resolved below rather than assumed to be unpinned.
    const isPinned = useAtomValue(currentThreadPinnedAtom);
    const setThreadPinned = useSetAtom(setThreadPinnedAtom);
    const upsertThreads = useSetAtom(upsertThreadsAtom);
    const updateThread = useSetAtom(updateThreadAtom);
    const removeThread = useSetAtom(removeThreadAtom);
    const [isPinning, setIsPinning] = useState(false);

    /**
     * Loads the open chat into the thread store when it is not there yet — a
     * deep link, or a chat created in this session. Runs on menu open rather
     * than on mount: it retries on the next open if it fails, where an effect
     * keyed on an unchanged `null` would leave the entry disabled forever, and
     * it costs nothing for a chat whose menu is never opened.
     */
    const resolvePinnedState = useCallback(async () => {
        const openThreadId = store.get(currentThreadIdAtom);
        if (!openThreadId || store.get(currentThreadPinnedAtom) !== null) return;
        const stamp = store.get(threadWriteStampAtom);
        try {
            const thread = await threadService.getThread(openThreadId);
            // Into the store, not into local state — the lists want it too.
            // Re-checked because the user can switch chats mid-request; the
            // stamp additionally drops it if the store was reset or a pin moved.
            if (store.get(currentThreadIdAtom) === openThreadId) {
                upsertThreads({ threads: [threadModelToThreadData(thread)], stamp });
            }
        } catch (error) {
            console.error('Error resolving pinned state:', error);
        }
    }, [upsertThreads]);

    const handleMenuToggle = useCallback((isOpen: boolean) => {
        if (!isOpen) return;
        forceUpdate({});
        void resolvePinnedState();
    }, [resolvePinnedState]);

    // The menu's content is built when it is opened, so the runs and their tool
    // results are read then rather than subscribed to — subscribing would
    // re-render the header on every frame of a streaming response. Only the
    // count, which decides whether the entries are enabled, is subscribed.
    const runsCount = useAtomValue(runsCountAtom);
    const citationDataMap = useAtomValue(citationMapAtom);
    const externalReferenceMapping = useAtomValue(externalReferenceItemMappingAtom);
    const externalReferencesMap = useAtomValue(externalReferenceMappingAtom);

    const getThreadMeta = () => {
        const threadId = store.get(currentThreadIdAtom);
        const currentName = store.get(currentThreadNameAtom);
        const threads = store.get(recentThreadsAtom);
        const threadName = currentName
            || (threads as ThreadData[]).find(t => t.id === threadId)?.name
            || null;
        return { threadId, threadName };
    };

    /**
     * Tool-call labels need host-resolved library/collection names, which are
     * resolved asynchronously — without them a list_* label falls back to the
     * raw library ref ("u") instead of the library name.
     */
    const getThreadContent = async (overrides?: Partial<ExtractThreadContentOptions>) => {
        // Streamed parts are applied a frame after they arrive, so a thread
        // copied or saved mid-response would otherwise stop a frame short of
        // what is on screen.
        flushPendingPartEvents();
        const { threadId, threadName } = getThreadMeta();
        const runs = store.get(allRunsAtom);
        const toolResultsMap = store.get(toolResultsMapAtom);
        const enrichMap = await resolveToolCallLabelEnrichMap(runs, toolResultsMap);
        return extractThreadContent(runs, toolResultsMap, {
            threadId,
            threadName,
            includeRunLinks: true,
            enrichMap,
            ...overrides,
        });
    };

    const handleCopyThread = async () => {
        const content = await getThreadContent();
        const formatted = renderToMarkdown(content);
        await copyToClipboard(formatted);
    };

    const handleSaveAsNote = async () => {
        const content = await getThreadContent({ includeRunLinks: false, userMessageAsBlockquote: true });
        const renderContent = preprocessNoteContent(content);
        const renderContextData = await prepareCitationRenderContext(renderContent, {
            citationDataMap,
            externalMapping: externalReferenceMapping,
            externalReferencesMap,
        });
        let htmlContent = renderToHTML(renderContent, "markdown", renderContextData);
        const context = getZoteroTargetContextSync();
        const threadId = store.get(currentThreadIdAtom);

        // Insert header after <h1> title, append footer
        const brandingHtml = threadId ? getBeaverNoteFooterHTML(threadId) : '';
        const h1End = htmlContent.indexOf('</h1>');
        if (h1End !== -1) {
            const insertPos = h1End + '</h1>'.length;
            htmlContent = htmlContent.slice(0, insertPos) + brandingHtml + '<hr>' + htmlContent.slice(insertPos);
        }
        htmlContent += '<hr>' + brandingHtml;

        const newNote = new Zotero.Item('note');
        if (context.targetLibraryId !== undefined) {
            newNote.libraryID = context.targetLibraryId;
        }
        newNote.setNote(htmlContent);
        await newNote.saveTx();

        // Always add to the current collection (even when items are selected)
        const zp = Zotero.getActiveZoteroPane();
        const selectedCollection = getSelectedCollection(zp);
        if (selectedCollection) {
            await Zotero.DB.executeTransaction(async () => {
                selectedCollection.addItem(newNote.id);
            });
        }

        const win = Zotero.getMainWindow();
        const isInReader = win.Zotero_Tabs?.selectedType === 'reader';
        if (!isInReader) {
            await selectItemById(newNote.id, true, selectedCollection?.id);
        }
    };

    const handleSaveAsChildNote = async () => {
        const content = await getThreadContent({ includeRunLinks: false, userMessageAsBlockquote: true });
        const renderContent = preprocessNoteContent(content);
        const renderContextData = await prepareCitationRenderContext(renderContent, {
            citationDataMap,
            externalMapping: externalReferenceMapping,
            externalReferencesMap,
        });
        let htmlContent = renderToHTML(renderContent, "markdown", renderContextData);
        const context = getZoteroTargetContextSync();
        if (!context.parentReference) return;

        const threadId = store.get(currentThreadIdAtom);

        // Insert header after <h1> title, append footer
        const brandingHtml = threadId ? getBeaverNoteFooterHTML(threadId) : '';
        const h1End = htmlContent.indexOf('</h1>');
        if (h1End !== -1) {
            const insertPos = h1End + '</h1>'.length;
            htmlContent = htmlContent.slice(0, insertPos) + brandingHtml + '<hr>' + htmlContent.slice(insertPos);
        }
        htmlContent += '<hr>' + brandingHtml;

        const newNote = new Zotero.Item('note');
        newNote.libraryID = context.parentReference.library_id;
        newNote.parentKey = context.parentReference.zotero_key;
        newNote.setNote(htmlContent);
        await newNote.saveTx();

        const win = Zotero.getMainWindow();
        const isInReader = win.Zotero_Tabs?.selectedType === 'reader';
        if (!isInReader) {
            selectItem(newNote);
        }
    };

    const handleCopyThreadUrl = async () => {
        const threadId = store.get(currentThreadIdAtom);
        if (!threadId) return;
        await copyToClipboard(`zotero://beaver/thread/${threadId}`);
    };

    const handleRenameChat = async () => {
        const { threadId, threadName } = getThreadMeta();
        if (!threadId) return;

        // Native text-input dialog for renaming (no in-panel edit UI needed here).
        const input = { value: threadName || 'Unnamed conversation' };
        const confirmed = Services.prompt.prompt(
            Zotero.getMainWindow() as any,
            'Rename chat',
            'Enter a new name for this chat:',
            input,
            null as unknown as string,
            { value: false },
        );
        if (!confirmed) return;

        const newName = input.value.trim();
        if (!newName || newName === threadName) return;

        try {
            await threadService.renameThread(threadId, newName);
            // Reflect the new name immediately in the current-thread and recent-thread state
            store.set(currentThreadNameAtom, newName);
            store.set(recentThreadsAtom, (prev: ThreadData[]) =>
                prev.map(t => (t.id === threadId ? { ...t, name: newName } : t)),
            );
            // One entity write reaches every chat list; no cache to invalidate.
            updateThread({ id: threadId, update: t => ({ ...t, name: newName }) });
            clearRecentChatsCache();
        } catch (error) {
            console.error('Error renaming thread:', error);
        }
    };

    /**
     * Pins or unpins the open chat, moving it into or out of the pinned group
     * at the top of the chat history.
     */
    const handleTogglePin = async () => {
        const currentId = store.get(currentThreadIdAtom);
        if (!currentId || isPinned === null || isPinning) return;

        setIsPinning(true);
        try {
            // The plain list's view key, so an unpin here retains the row in the
            // window exactly as the row-level unpin does. Without it the two
            // paths to one action behave differently: this one would drop a
            // chat the paginated window never held.
            const currentUser = store.get(userAtom);
            const viewKey = currentUser
                ? threadViewKey({
                    userId: currentUser.id,
                    showAll: store.get(showAllThreadInstancesAtom),
                    scope: currentZoteroInstanceRef(),
                })
                : undefined;
            // The store owns the optimistic write and its rollback, and every
            // surface renders from it — so a list open behind this menu (the
            // overlay leaves the header reachable) updates without being told.
            const ok = await setThreadPinned({ threadId: currentId, pinned: !isPinned, viewKey });
            if (ok) clearRecentChatsCache();
        } finally {
            setIsPinning(false);
        }
    };

    const handleDeleteChat = async () => {
        const threadId = store.get(currentThreadIdAtom);
        if (!threadId) return;

        const buttonIndex = Zotero.Prompt.confirm({
            window: Zotero.getMainWindow(),
            title: 'Delete chat?',
            text: 'Are you sure you want to delete this chat? This action cannot be undone.',
            button0: Zotero.Prompt.BUTTON_TITLE_YES,
            button1: Zotero.Prompt.BUTTON_TITLE_NO,
            defaultButton: 1,
        });
        if (buttonIndex !== 0) return;

        try {
            await threadService.deleteThread(threadId);
            store.set(recentThreadsAtom, (prev: ThreadData[]) => prev.filter(t => t.id !== threadId));
            clearRecentChatsCache(threadId);
            // This menu always targets the current thread, so switch to a new chat
            // BEFORE forgetting the entity: while the deleted id is still
            // `currentThreadId`, its pin state reads "unknown" and anything
            // watching for that would fetch a chat that no longer exists.
            // The delete was already confirmed above, so skip the run confirm.
            await store.set(newThreadAtom, { skipActiveRunConfirm: true });
            // Every chat list resolves ids through the store and drops what is
            // gone, so one entity removal is the whole job.
            removeThread(threadId);
        } catch (error) {
            console.error('Error deleting thread:', error);
        }
    };

    const getMenuItems = (): MenuItem[] => {
        const hasRuns = runsCount > 0;
        const context = getZoteroTargetContextSync();
        const hasParent = context.parentReference !== null;

        const items: MenuItem[] = [
            {
                label: 'Copy entire chat',
                onClick: handleCopyThread,
                disabled: !hasRuns,
            },
            {
                label: 'Save chat as note',
                onClick: handleSaveAsNote,
                disabled: !hasRuns,
            },
            {
                label: 'Save chat as child note',
                onClick: handleSaveAsChildNote,
                disabled: !hasParent || !hasRuns,
            },
            {
                label: 'Copy link to chat',
                onClick: handleCopyThreadUrl,
                disabled: !threadId,
            },
            {
                label: 'thread-actions-divider',
                onClick: () => {},
                isDivider: true,
            },
            {
                label: isPinned ? 'Unpin chat' : 'Pin chat',
                onClick: handleTogglePin,
                disabled: !threadId || isPinned === null || isPinning,
            },
            {
                label: 'Rename chat',
                onClick: handleRenameChat,
                disabled: !threadId,
            },
            {
                label: 'Delete chat',
                onClick: handleDeleteChat,
                disabled: !threadId,
            },
        ];
        return items;
    };

    return (
        <MenuButton
            icon={MoreHorizontalIcon}
            menuItems={getMenuItems()}
            className={className}
            ariaLabel={ariaLabel}
            variant="ghost"
            toggleCallback={handleMenuToggle}
            tooltipContent="Chat actions"
            showArrow={true}
        />
    );
};

export default ThreadMenuButton;
