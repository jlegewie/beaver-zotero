// @ts-ignore useEffect is defined in React
import { useEffect } from 'react';
import { eventManager } from '../events/eventManager';
import { BeaverEventName, BeaverEventDetail } from '../events/types';

export function useEventSubscription<T extends BeaverEventName>(
    eventName: T,
    callback: (detail: BeaverEventDetail<T>) => void,
    deps: any[] = []
) {
    useEffect(() => {
        const unsubscribe = eventManager.subscribe(eventName, callback);
        return unsubscribe;
    }, [eventName, ...deps]);
} 