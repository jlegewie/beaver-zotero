import React from 'react'
import { SourceButton } from './SourceButton';
import { useAtomValue } from 'jotai';
import { currentSourcesAtom, readerTextSelectionAtom } from '../atoms/input';
import { TextSelectionButton } from './TextSelectionButton';
import { ZoteroIcon, ZOTERO_ICONS } from './icons/ZoteroIcon';
import AddSourcesMenu from './AddSourcesMenu';
import { threadSourceCountAtom } from '../atoms/threads';

const MessageAttachmentDisplay = ({
    isAddAttachmentMenuOpen,
    setIsAddAttachmentMenuOpen,
    menuPosition,
    setMenuPosition,
    inputRef
}: {
    isAddAttachmentMenuOpen: boolean;
    setIsAddAttachmentMenuOpen: (isAddAttachmentMenuOpen: boolean) => void;
    menuPosition: { x: number; y: number };
    setMenuPosition: (menuPosition: { x: number; y: number }) => void;
    inputRef: React.RefObject<HTMLTextAreaElement>;
}) => {
    const currentSources = useAtomValue(currentSourcesAtom);
    const readerTextSelection = useAtomValue(readerTextSelectionAtom);
    const threadSourceCount = useAtomValue(threadSourceCountAtom);

    return (
        <div className="display-flex flex-wrap gap-3 mb-2">
            <AddSourcesMenu
                showText={currentSources.length == 0 && threadSourceCount == 0}
                onClose={() => {
                    inputRef.current?.focus();
                    setIsAddAttachmentMenuOpen(false);
                }}
                isMenuOpen={isAddAttachmentMenuOpen}
                onOpen={() => setIsAddAttachmentMenuOpen(true)}
                menuPosition={menuPosition}
                setMenuPosition={setMenuPosition}
            />
            {threadSourceCount > 0 && (
                <button
                    className="sources-info"
                    disabled={true}
                    title={`This thread has ${threadSourceCount} sources.`}
                >
                    <ZoteroIcon 
                        icon={ZOTERO_ICONS.ATTACHMENTS} 
                        size={14} 
                        color="--accent-green"
                        className="mr-1"
                    />
                    {threadSourceCount}
                </button>
            )}

            {currentSources.map((source, index) => (
                <SourceButton
                    key={index}
                    source={source}
                />
            ))}
            {readerTextSelection && readerTextSelection.hasSelection && (
                <TextSelectionButton selection={readerTextSelection} />
            )}
            
        </div>
    )
}

export default MessageAttachmentDisplay;