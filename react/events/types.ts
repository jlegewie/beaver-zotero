import type { ActionTargetType } from '../types/actions';

export interface BeaverEvents {
    toggleChat: {
        location?: 'library' | 'reader';
        forceOpen?: boolean;
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
}

export type BeaverEventName = keyof BeaverEvents;
export type BeaverEventDetail<T extends BeaverEventName> = BeaverEvents[T]; 