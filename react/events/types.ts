import type { ActionTargetType } from '@beaver/agent-core/types/actions';

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
        /** Action title at dispatch time; fallback for the /command token when
         *  the action can't be found in the store (e.g. deleted mid-flight). */
        actionTitle: string;
        targetType: ActionTargetType;
        itemIds: number[];
        /** Every collection the action targets. Empty for non-collection
         *  dispatches and whenever the selection is not purely collections.
         *  Carries each collection's library so the receiver can apply
         *  library-exclusion filtering before looking the collection up. */
        collections: { libraryId: number; collectionId: number }[];
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
            | 'items'
            | 'sentences'
            | 'columns-graphics'
            | 'items-graphics'
            | 'sentences-graphics'
            | 'clear'
            | 'copy-extract-fixture-command'
            | 'copy-ocr-fixture-command';
    };
    focusInput: Record<string, never>;
    'background-worker:status': {
        running: boolean;
    };
}

export type BeaverEventName = keyof BeaverEvents;
export type BeaverEventDetail<T extends BeaverEventName> = BeaverEvents[T]; 
