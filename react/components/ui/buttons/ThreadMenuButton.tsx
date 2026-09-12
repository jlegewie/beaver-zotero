import { getWindowRuntime } from '../../../runtime/windowRuntime';
import { getCredentialGeneration } from '@beaver/agent-core/transport/credentials';
import { citationMapAtom } from '@beaver/agent-core/citations/atoms';
import { externalReferenceItemMappingAtom, externalReferenceMappingAtom } from '@beaver/agent-core/citations/externalReferences';
import { allRunsAtom, runsCountAtom, toolResultsMapAtom } from '@beaver/agent-core/run-state/atoms';
import Spinner from '@beaver/agent-ui/icons/Spinner';
import { MenuItem } from '@beaver/agent-ui/primitives/ContextMenu';
import MenuButton from '@beaver/agent-ui/primitives/MenuButton';
import { useAtomValue, useSetAtom } from 'jotai';
import React, { useCallback, useState } from 'react';
import { getSelectedCollection } from '../../../../src/utils/zoteroSelection';
import { currentZoteroInstanceRef } from '../../../../src/utils/zoteroUtils';
import { userAtom } from '../../../atoms/auth';
import {
    currentThreadPinnedAtom,
    isPinPending,
    pinsPendingAtom,
    setThreadPinnedAtom,
    threadViewKey,
} from '../../../atoms/threadList';
import { recentThreadsAtom, currentThreadIdAtom, currentThreadNameAtom, newThreadAtom, ThreadData } from '../../../atoms/threads';
import { showAllThreadInstancesAtom } from '../../../atoms/ui';
import { useFindInChatControls } from '../../../hooks/useFindInChat';
import { useSurfaceWindow } from '../../../runtime/SurfaceWindowContext';
import { getContextWindow } from '../../../runtime/windowRuntime';
import { store } from '../../../store';
import { prepareCitationRenderContext } from '../../../utils/citationRenderContext';
import { preprocessNoteContent, renderToHTML, renderToMarkdown } from '../../../utils/citationRenderers';
import { copyToClipboard } from '../../../utils/clipboard';
import { getBeaverNoteFooterHTML } from '../../../utils/noteActions';
import { selectItem, selectItemById } from '../../../utils/selectItem';
import { flushPendingPartEvents } from '../../../utils/streamingPartQueue';
import { extractThreadContent, ExtractThreadContentOptions } from '../../../utils/threadContent';
import { resolveToolCallLabelEnrichMap } from '../../../utils/toolCallLabelEnrich';
import { getZoteroTargetContextSync } from '../../../utils/zoteroTargetContext';
import { MoreHorizontalIcon } from '../../icons/icons';

interface ThreadMenuButtonProps {
    className?: string;
    ariaLabel?: string;
}

const ThreadMenuButton: React.FC<ThreadMenuButtonProps> = ({
    className = '',
    ariaLabel = 'Chat actions',
}) => {
    const surfaceWindow = useSurfaceWindow();
    const [, forceUpdate] = useState({});
    const threadId = useAtomValue(currentThreadIdAtom);
    // Derived from the thread store, so this entry cannot disagree with the
    // chat lists. `null` means the open chat is not in the store yet — a
    // zotero://beaver deep link, or a chat created in this session — which is
    // resolved below rather than assumed to be unpinned.
    const isPinned = useAtomValue(currentThreadPinnedAtom);
    const setThreadPinned = useSetAtom(setThreadPinnedAtom);
    // Shared with the list's pin buttons, so the two surfaces cannot fire
    // concurrent toggles for the same chat.
    const pinsPending = useAtomValue(pinsPendingAtom);

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
        try {
            await Zotero.Beaver.threads.getThread(openThreadId);
        } catch (error) {
            console.error('Error resolving pinned state:', error);
        }
    }, []);

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
    // Its own context, not the find query: this button must not re-render while
    // the reader types in the find bar.
    const findControls = useFindInChatControls();
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
        const win = getContextWindow();
        const context = getZoteroTargetContextSync(win);
        if (context.targetLibraryId === undefined) return;
        const selectedCollection = getSelectedCollection(win?.ZoteroPane);
        const isInReader = win?.Zotero_Tabs?.selectedType === 'reader';
        const content = await getThreadContent({ includeRunLinks: false, userMessageAsBlockquote: true });
        const renderContent = preprocessNoteContent(content);
        const renderContextData = await prepareCitationRenderContext(renderContent, {
            citationDataMap,
            externalMapping: externalReferenceMapping,
            externalReferencesMap,
        });
        let htmlContent = renderToHTML(renderContent, "markdown", renderContextData);
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
        if (selectedCollection) {
            await Zotero.DB.executeTransaction(async () => {
                selectedCollection.addItem(newNote.id);
            });
        }

        if (!isInReader) {
            await selectItemById(newNote.id, true, selectedCollection?.id, win);
        }
    };

    const handleSaveAsChildNote = async () => {
        const win = getContextWindow();
        const context = getZoteroTargetContextSync(win);
        if (context.targetLibraryId === undefined) return;
        const isInReader = win?.Zotero_Tabs?.selectedType === 'reader';
        const content = await getThreadContent({ includeRunLinks: false, userMessageAsBlockquote: true });
        const renderContent = preprocessNoteContent(content);
        const renderContextData = await prepareCitationRenderContext(renderContent, {
            citationDataMap,
            externalMapping: externalReferenceMapping,
            externalReferencesMap,
        });
        let htmlContent = renderToHTML(renderContent, "markdown", renderContextData);
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

        if (!isInReader) {
            selectItem(newNote, true, win);
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
            surfaceWindow as any,
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
            await Zotero.Beaver.threads.renameThread(threadId, newName);
        } catch (error) {
            console.error('Error renaming thread:', error);
        }
    };

    /**
     * Pins or unpins the open chat, moving it into or out of the pinned group
     * at the top of the chat history.
     */
    const handleTogglePin = () => {
        const currentId = store.get(currentThreadIdAtom);
        if (!currentId || isPinned === null) return;

        // The plain list's view key, so an unpin here retains the row in the
        // window exactly as the row-level unpin does. Without it the two paths
        // to one action behave differently: this one would drop a chat the
        // paginated window never held.
        const currentUser = store.get(userAtom);
        const viewKey = currentUser
            ? threadViewKey({
                userId: currentUser.id,
                showAll: store.get(showAllThreadInstancesAtom),
                scope: currentZoteroInstanceRef(),
            })
            : undefined;
        // The store owns confirmation/reconciliation and the shared
        // one-toggle-at-a-time guard.
        void setThreadPinned({ threadId: currentId, pinned: !isPinned, viewKey });
    };

    const handleDeleteChat = async () => {
        const threadId = store.get(currentThreadIdAtom);
        if (!threadId) return;

        const buttonIndex = Zotero.Prompt.confirm({
            window: surfaceWindow,
            title: 'Delete chat?',
            text: 'Are you sure you want to delete this chat? This action cannot be undone.',
            button0: Zotero.Prompt.BUTTON_TITLE_YES,
            button1: Zotero.Prompt.BUTTON_TITLE_NO,
            defaultButton: 1,
        });
        if (buttonIndex !== 0) return;

        try {
            await Zotero.Beaver.threads.deleteThread(threadId, getWindowRuntime().id, getCredentialGeneration());
            // The delete was confirmed; leave only if this is still the open chat.
            if (store.get(currentThreadIdAtom) === threadId) await store.set(newThreadAtom, { skipActiveRunConfirm: true });
        } catch (error) {
            console.error('Error deleting thread:', error);
        }
    };

    const getMenuItems = (): MenuItem[] => {
        const hasRuns = runsCount > 0;
        const context = getZoteroTargetContextSync();
        const hasParent = context.parentReference !== null;
        const pinPending = !!threadId && isPinPending(pinsPending, threadId);

        const items: MenuItem[] = [
            {
                // MenuItem carries no shortcut field, so the ⌘F / Ctrl+F chord
                // that also opens the bar is not shown here.
                label: 'Find in chat',
                onClick: findControls.open,
                disabled: !hasRuns || !findControls.isAvailable,
            },
            {
                label: 'find-in-chat-divider',
                onClick: () => {},
                isDivider: true,
            },
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
                disabled: !threadId || isPinned === null || pinPending,
                customContent: pinPending ? (
                    <span className="display-flex items-center gap-2">
                        <Spinner size={14} />
                        <span>{isPinned ? 'Unpinning chat' : 'Pinning chat'}</span>
                    </span>
                ) : undefined,
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
