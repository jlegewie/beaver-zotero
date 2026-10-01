import { useEffect, useState } from "react";

/** Whether `doc` is visible (not minimized or fully occluded). */
export function useDocumentVisible(doc: Document): boolean {
    const [visible, setVisible] = useState(() => !doc.hidden);
    useEffect(() => {
        // Gecko repeats `visibilitychange` without a state change; the
        // boolean state makes those repeats no-ops.
        const update = () => setVisible(!doc.hidden);
        update();
        doc.addEventListener("visibilitychange", update);
        return () => doc.removeEventListener("visibilitychange", update);
    }, [doc]);
    return visible;
}
