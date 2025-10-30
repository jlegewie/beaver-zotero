import React from 'react';
import { useAtomValue } from 'jotai';
import PopupMessageContainer from './ui/popup/PopupMessageContainer';
import PreviewContainer from './previews/PreviewContainer';
import { popupMessagesAtom } from '../atoms/ui';

// Preview and popup container component
const PreviewAndPopupContainer: React.FC = () => {
    const popupMessages = useAtomValue(popupMessagesAtom);
    const hasPopupMessages = popupMessages.length > 0;
    
    return (
        <div className="absolute -top-4 inset-x-0 -translate-y-full px-3 flex flex-col pointer-events-none items-stretch">
            <PopupMessageContainer className="pointer-events-auto" />
            <PreviewContainer className="pointer-events-auto" hasAboveOverlay={hasPopupMessages} />
        </div>
    );
};

export default PreviewAndPopupContainer; 
