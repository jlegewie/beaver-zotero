export interface BeaverEvents {
    toggleChat: {
        location?: 'library' | 'reader';
    };
    getAttachmentStatus: {
        library_id: number;
        zotero_key: string;
    };
}

export type BeaverEventName = keyof BeaverEvents;
export type BeaverEventDetail<T extends BeaverEventName> = BeaverEvents[T]; 