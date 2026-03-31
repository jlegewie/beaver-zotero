import React, { useRef } from 'react';
import FloatingPopupContainer from './ui/popup/FloatingPopupContainer';

const FloatingPopupRoot: React.FC = () => {
    const containerRef = useRef<HTMLDivElement>(null);

    return (
        <div ref={containerRef}>
            <FloatingPopupContainer />
        </div>
    );
};

export default FloatingPopupRoot;
