import React, { useRef } from 'react';
import FloatingPopupContainer from './ui/popup/FloatingPopupContainer';
import QuickPromptPopup from './quickPrompt/QuickPromptPopup';
import RunStatusPopup from './runStatusPopup/RunStatusPopup';

const FloatingPopupRoot: React.FC = () => {
    const containerRef = useRef<HTMLDivElement>(null);

    return (
        <div ref={containerRef} className="display-flex flex-col">
            <FloatingPopupContainer />
            <QuickPromptPopup />
            <RunStatusPopup />
        </div>
    );
};

export default FloatingPopupRoot;
