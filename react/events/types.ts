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
    readerVisualizerAction: {
        action:
            | 'columns'
            | 'lines'
            | 'paragraphs'
            | 'sentences'
            | 'clear'
            | 'create-or-update-sentence-fixture'
            | 'copy-fixture-capture-command';
    };
    focusInput: Record<string, never>;
}

export type BeaverEventName = keyof BeaverEvents;
export type BeaverEventDetail<T extends BeaverEventName> = BeaverEvents[T]; 