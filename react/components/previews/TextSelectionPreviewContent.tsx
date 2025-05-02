import React from 'react';
import { CancelIcon, TextAlignLeftIcon, Icon } from '../icons';
import { useSetAtom, useAtom } from 'jotai';
import { activePreviewAtom } from '../../atoms/ui';
import { readerTextSelectionAtom } from '../../atoms/input';
import { ZoteroIcon, ZOTERO_ICONS } from '../icons/ZoteroIcon';
import Button from '../button';
import IconButton from '../IconButton';
import { TextSelection } from '../../types/attachments/apiTypes';
import { navigateToPage } from '../../utils/readerUtils';

interface TextSelectionPreviewContentProps {
    selection: TextSelection;
    maxContentHeight: number;
}

const TextSelectionPreviewContent: React.FC<TextSelectionPreviewContentProps> = ({ selection, maxContentHeight }) => {
    const setActivePreview = useSetAtom(activePreviewAtom);
    const setReaderTextSelection = useSetAtom(readerTextSelectionAtom);

    const handleRemove = () => {
        // Remove selection state and close preview
        setReaderTextSelection(null);
        setActivePreview(null);
    };

    const handleOpen = async () => {
        // TODO: Implement "Go to Page" functionality
        Zotero.getMainWindow().console.log("TODO: Implement Go to Page for Text Selection Preview");
    };

    return (
        <>
            {/* Content Area */}
            <div 
                className="source-content p-3"
                style={{ maxHeight: `${maxContentHeight}px` }}
            >
                <div className="display-flex flex-row items-center gap-1">
                    <Icon icon={TextAlignLeftIcon} className="scale-90 font-color-primary"/>
                    <div className="font-color-primary">Text Selection</div>
                    <div className="flex-1"/>
                    <div className="font-color-secondary">Page {selection.page}</div>
                </div>
                <p className="text-base my-2">{selection.text}</p>
            </div>

            {/* buttons */}
            <div className="p-2 pt-1 display-flex flex-row items-center border-top-quinary">
                <div className="flex-1 gap-3 display-flex">
                    <Button
                        variant="ghost"
                        onClick={handleOpen}
                    >
                        <ZoteroIcon 
                            icon={ZOTERO_ICONS.OPEN} 
                            size={12}
                        />
                        Go to Page
                    </Button>
                    <Button 
                        variant="ghost"
                        onClick={handleRemove}
                    >
                        <ZoteroIcon 
                            icon={ZOTERO_ICONS.TRASH} 
                            size={12}
                        />
                        Remove
                    </Button>
                </div>
                <div className="display-flex">
                    <IconButton
                        icon={CancelIcon}
                        variant="ghost"
                        onClick={() => setActivePreview(null)}
                    />
                </div>
            </div>
        </>
    );
};

export default TextSelectionPreviewContent; 