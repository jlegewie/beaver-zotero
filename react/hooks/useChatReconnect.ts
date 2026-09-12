import { useEffect } from 'react';

/** Retry a failed chat lookup once the application's network returns. */
export function useChatReconnect(retry: () => void, failed: boolean): void {
    useEffect(() => {
        if (!failed) return;
        const observer = {
            observe: (_subject: unknown, _topic: string, state: string) => {
                if (state === 'online') retry();
            },
        };
        Services.obs.addObserver(observer, 'network:offline-status-changed');
        return () => Services.obs.removeObserver(observer, 'network:offline-status-changed');
    }, [retry, failed]);
}
