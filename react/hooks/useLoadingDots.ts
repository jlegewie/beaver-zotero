import { useState, useEffect } from 'react';

export const useLoadingDots = (isLoading: boolean): number => {
    const [loadingDots, setLoadingDots] = useState(1);

    useEffect(() => {
        let interval: NodeJS.Timeout | undefined;
        if (isLoading) {
            setLoadingDots(1);
            interval = setInterval(() => {
                setLoadingDots((dots) => (dots < 3 ? dots + 1 : 1));
            }, 250);
        } else {
            setLoadingDots(1);
        }
        return () => {
            if (interval) {
                clearInterval(interval);
            }
        };
    }, [isLoading]);

    return loadingDots;
};
