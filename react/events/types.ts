import type { ActionTargetType } from '../types/actions';

export interface BeaverEvents {
    toggleChat: {
        location?: 'library' | 'reader';
        forceOpen?: boolean;
        skipAutoPopulate?: boolean;
    };
    loadThread: {
        threadId: string;
        runId?: string;
    };
    contextMenuAction: {
        actionId: string;
        actionText: string;
        targetType: ActionTargetType;
        itemIds: number[];
        collectionId: number | null;
    };
    readerSelectionAction: {
        action: 'explain' | 'ask';
        text: string;
        page: number;
        readerItemID: number;
    };
    readerAnnotationAction: {
        action: 'explain' | 'ask';
        annotationIds: string[];
        readerItemID: number;
    };
    focusInput: {};
    /**
     * Fired when the Beaver sidebar visibility changes. Used by the src/ esbuild
     * bundle (e.g. updateController) to react to sidebar open/close without
     * importing Jotai across the bundle boundary.
     */
    sidebarVisibilityChange: {
        isVisible: boolean;
    };
}

export type BeaverEventName = keyof BeaverEvents;
export type BeaverEventDetail<T extends BeaverEventName> = BeaverEvents[T]; 