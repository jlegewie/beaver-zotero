export interface BeaverEvents {
    toggleChat: {
        location?: 'library' | 'reader';
    };
    openThread: {
        threadId: string;
    };
}

export type BeaverEventName = keyof BeaverEvents;
export type BeaverEventDetail<T extends BeaverEventName> = BeaverEvents[T]; 