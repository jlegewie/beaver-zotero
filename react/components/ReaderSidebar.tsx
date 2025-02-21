import React from 'react';
import { useAtom } from "jotai";
import AiSidebar from "../AiSidebar";
import { isReaderSidebarVisibleAtom } from "../atoms/ui";
import { useVisibility } from '../hooks/useVisibility';

const ReaderSidebar = () => {
    const [isVisible] = useAtom(isReaderSidebarVisibleAtom);
    
    useVisibility('reader');

    return isVisible ? <AiSidebar location="reader" /> : null;
}

export default ReaderSidebar; 