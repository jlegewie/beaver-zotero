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
import { currentThreadIdAtom, recentThreadsAtom, ThreadData } from '../../../atoms/threads';
import { citationDataMapAtom } from '../../../atoms/citations';
import { externalReferenceItemMappingAtom, externalReferenceMappingAtom } from '../../../atoms/externalReferences';
import { getZoteroTargetContextSync } from '../../../../src/utils/zoteroUtils';
import { selectItem } from '../../../../src/utils/selectItem';
import { store } from '../../../store';

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
    const citationDataMap = useAtomValue(citationDataMapAtom);
    const externalReferenceMapping = useAtomValue(externalReferenceItemMappingAtom);
    const externalReferencesMap = useAtomValue(externalReferenceMappingAtom);

    const getThreadMeta = () => {
        const threadId = store.get(currentThreadIdAtom);
        const threads = store.get(recentThreadsAtom);
        const threadName = (threads as ThreadData[]).find(t => t.id === threadId)?.name || null;
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
        const content = getThreadContent();
        let htmlContent = renderToHTML(preprocessNoteContent(content), "markdown", {
            citationDataMap,
            externalMapping: externalReferenceMapping,
            externalReferencesMap
        });
        const context = getZoteroTargetContextSync();
        const threadId = store.get(currentThreadIdAtom);
        if (threadId) {
            htmlContent += getBeaverNoteFooterHTML(threadId);
        }

        const newNote = new Zotero.Item('note');
        if (context.targetLibraryId !== undefined) {
            newNote.libraryID = context.targetLibraryId;
        }
        newNote.setNote(htmlContent);
        await newNote.saveTx();

        if (context.collectionToAddTo) {
            await context.collectionToAddTo.addItem(newNote.id);
        }

        const win = Zotero.getMainWindow();
        const isInReader = win.Zotero_Tabs?.selectedType === 'reader';
        if (!isInReader) {
            selectItem(newNote);
        }
    };

    const handleSaveAsChildNote = async () => {
        const content = getThreadContent();
        let htmlContent = renderToHTML(preprocessNoteContent(content), "markdown", {
            citationDataMap,
            externalMapping: externalReferenceMapping,
            externalReferencesMap
        });
        const context = getZoteroTargetContextSync();
        if (!context.parentReference) return;

        const threadId = store.get(currentThreadIdAtom);
        if (threadId) {
            htmlContent += getBeaverNoteFooterHTML(threadId);
        }

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

    const getMenuItems = (): MenuItem[] => {
        const threadId = store.get(currentThreadIdAtom);
        const hasRuns = runs.length > 0;
        const context = getZoteroTargetContextSync();
        const hasParent = context.parentReference !== null;

        return [
            {
                label: 'Copy chat',
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
        ];
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
