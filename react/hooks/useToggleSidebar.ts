import { useSetAtom } from 'jotai';
import { isSidebarVisibleAtom } from '../atoms/ui';
import { useEventSubscription } from './useEventSubscription';

export function useToggleSidebar() {
    const setSidebarVisible = useSetAtom(isSidebarVisibleAtom);
    
    useEventSubscription('toggleChat', (detail) => {
        setSidebarVisible((prev) => !prev);
    });
} 