import { BeaverEventName, BeaverEventDetail } from './types';

class EventManager {
    private static instance: EventManager;
    
    private constructor() {}
    
    static getInstance(): EventManager {
        if (!this.instance) {
            this.instance = new EventManager();
        }
        return this.instance;
    }
    
    getEventBus(win: Window): EventTarget {
        if (!win.__beaverEventBus) {
            win.__beaverEventBus = new EventTarget();
        }
        return win.__beaverEventBus;
    }
    
    dispatch<T extends BeaverEventName>(
        eventName: T,
        detail: BeaverEventDetail<T>
    ) {
        const win = Zotero.getMainWindow();
        const event = new win.CustomEvent(eventName, { detail });
        this.getEventBus(win).dispatchEvent(event);
    }
    
    subscribe<T extends BeaverEventName>(
        eventName: T,
        callback: (detail: BeaverEventDetail<T>) => void
    ): () => void {
        const win = Zotero.getMainWindow();
        const eventBus = this.getEventBus(win);
        
        const handler = (e: CustomEvent) => callback(e.detail);
        eventBus.addEventListener(eventName, handler as EventListener);
        
        return () => {
            eventBus.removeEventListener(eventName, handler as EventListener);
        };
    }
}

export const eventManager = EventManager.getInstance(); 