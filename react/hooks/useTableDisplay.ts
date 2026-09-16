import { useEffect, useState } from "react";
import { getHost } from "@beaver/agent-ui/host";
import type { TableDisplay } from "@beaver/agent-ui/host/types";

/** Refresh local display metadata without changing the historical reference. */
export function useTableDisplay(key: string): TableDisplay | undefined {
    const [current, setCurrent] = useState<TableDisplay>();
    useEffect(() => {
        let active = true;
        let generation = 0;
        setCurrent(undefined);
        const refresh = async () => {
            const request = ++generation;
            const next = await getHost()
                .itemData?.resolveTableDisplay?.(key)
                .catch(() => ({
                    status: "unavailable" as const,
                    reason: "Table provider unavailable.",
                }));
            if (active && generation === request)
                setCurrent(
                    next ?? {
                        status: "unavailable",
                        reason: "Table provider unavailable.",
                    },
                );
        };
        const unsubscribe = getHost().itemData?.subscribeTableChanges?.(
            key,
            refresh,
        );
        void refresh();
        return () => {
            active = false;
            unsubscribe?.();
        };
    }, [key]);
    return current;
}
