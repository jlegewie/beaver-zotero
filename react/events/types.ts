export interface BeaverEvents {
    toggleChat: {
        location?: 'library' | 'reader';
        forceOpen?: boolean;
    };
}

export type BeaverEventName = keyof BeaverEvents;
export type BeaverEventDetail<T extends BeaverEventName> = BeaverEvents[T]; 