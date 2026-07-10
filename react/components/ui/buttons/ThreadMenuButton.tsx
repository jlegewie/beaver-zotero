import React, { useState, useCallback } from 'react';
import { useAtomValue } from 'jotai';
import MenuButton from '../MenuButton';
import { MenuItem } from '../menu/ContextMenu';
import { MoreHorizontalIcon } from '../../icons/icons';
import { copyToClipboard } from '../../../utils/clipboard';
import { renderToMarkdown, renderToHTML, preprocessNoteContent } from '../../../utils/citationRenderers';
import { getBeaverNoteFooterHTML } from '../../../utils/noteActions';
import { extractThreadContent, ExtractThreadContentOptions } from '../../../utils/threadContent';
import { allRunsAtom, toolResultsMapAtom } from '../../../agents/atoms';
import { currentThreadIdAtom, currentThreadNameAtom, newThreadAtom, recentThreadsAtom, ThreadData } from '../../../atoms/threads';
import { citationMapAtom } from '../../../atoms/citations';
import { externalReferenceItemMappingAtom, externalReferenceMappingAtom } from '../../../atoms/externalReferences';
import { getZoteroTargetContextSync } from '../../../../src/utils/zoteroUtils';
import { selectItem, selectItemById } from '../../../../src/utils/selectItem';
import { store } from '../../../store';
import { prepareCitationRenderContext } from '../../../utils/citationRenderContext';
import { threadService } from '../../../../src/services/threadService';
import { clearRecentChatsCache } from '../../RecentChats';
import { clearThreadListCache } from '../../ThreadListView';

interface ThreadMenuButtonProps {
    className?: string;
    ariaLabel?: string;
}

const ThreadMenuButton: React.FC<ThreadMenuButtonProps> = ({
    className = '',
    ariaLabel = 'Chat actions',
}) => {
    const [, forceUpdate] = useState({});

    const handleMenuToggle = useCallback((isOpen: boolean) => {
        if (isOpen) forceUpdate({});
    }, []);

    const runs = useAtomValue(allRunsAtom);
    const toolResultsMap = useAtomValue(toolResultsMapAtom);
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

    const getThreadContent = (overrides?: Partial<ExtractThreadContentOptions>) => {
        const { threadId, threadName } = getThreadMeta();
        return extractThreadContent(runs, toolResultsMap, {
            threadId,
            threadName,
            includeRunLinks: true,
            ...overrides,
        });
    };

    const handleCopyThread = async () => {
        const content = getThreadContent();
        const formatted = renderToMarkdown(content);
        await copyToClipboard(formatted);
    };

    const handleSaveAsNote = async () => {
        const content = getThreadContent({ includeRunLinks: false, userMessageAsBlockquote: true });
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
        const selectedCollection = zp?.getSelectedCollection() || null;
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
        const content = getThreadContent({ includeRunLinks: false, userMessageAsBlockquote: true });
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
            // Invalidate caches so chat lists refetch fresh names
            clearThreadListCache();
            clearRecentChatsCache();
        } catch (error) {
            console.error('Error renaming thread:', error);
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
            // Drop it from the recent-thread list and invalidate caches
            store.set(recentThreadsAtom, (prev: ThreadData[]) => prev.filter(t => t.id !== threadId));
            clearThreadListCache();
            clearRecentChatsCache(threadId);
            // This menu always targets the current thread, so switch to a new chat.
            // The delete was already confirmed above, so skip the active-run confirmation.
            await store.set(newThreadAtom, { skipActiveRunConfirm: true });
        } catch (error) {
            console.error('Error deleting thread:', error);
        }
    };

    const getMenuItems = (): MenuItem[] => {
        const threadId = store.get(currentThreadIdAtom);
        const hasRuns = runs.length > 0;
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
