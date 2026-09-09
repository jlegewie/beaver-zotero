import { useCallback, useEffect, useState } from 'react';

const HANDOFF_TIMEOUT_MS = 5000;

interface FocusHandoff {
    host: HTMLElement;
    navigationKey: string;
    expiresAt: number;
    restore: () => void;
}

/** A short, window-local handoff from the composer to the run it just sent. */
export function useRunFocusHandoff({
    navigationKey, enabled, sidebarVisible, isPending, runId,
}: {
    navigationKey: string;
    enabled: boolean;
    sidebarVisible: boolean;
    isPending: boolean;
    runId: string | null;
}) {
    const [request, setRequest] = useState<FocusHandoff | null>(null);
    const start = useCallback((host: HTMLElement, restore: () => void) => {
        setRequest({ host, restore, navigationKey, expiresAt: Date.now() + HANDOFF_TIMEOUT_MS });
    }, [navigationKey]);

    useEffect(() => {
        if (!request) return;
        const { host, restore } = request;
        const doc = host.ownerDocument;
        const win = doc.defaultView;
        if (!win || request.navigationKey !== navigationKey || sidebarVisible) {
            setRequest(null);
            return;
        }
        let finished = false;
        const finish = (target?: HTMLElement) => {
            if (finished) return;
            finished = true;
            setRequest(null);
            // Never take focus back from something the user chose meanwhile.
            if (doc.activeElement && doc.activeElement !== doc.body && doc.activeElement !== doc.documentElement) return;
            if (target) target.focus();
            else restore();
        };
        const attempt = () => {
            if (!enabled || Date.now() >= request.expiresAt) {
                finish();
                return;
            }
            const card = host.querySelector<HTMLElement>('.beaver-run-status-popup__card');
            if (card && runId) {
                finish(card.querySelector<HTMLElement>('[data-run-status-approve]:not(:disabled)') ?? card);
            } else if (!isPending && !runId) {
                finish();
            }
        };
        const cancel = () => { finished = true; setRequest(null); };
        // Focus movement and fresh input end the handoff even if focus later
        // returns to the document body before a card arrives.
        win.addEventListener('blur', cancel);
        doc.addEventListener('focusin', cancel);
        doc.addEventListener('pointerdown', cancel);
        doc.addEventListener('keydown', cancel);
        const observer = new win.MutationObserver(attempt);
        observer.observe(host, { childList: true, subtree: true });
        const timer = win.setTimeout(() => finish(), Math.max(0, request.expiresAt - Date.now()));
        attempt();
        return () => {
            observer.disconnect();
            win.clearTimeout(timer);
            win.removeEventListener('blur', cancel);
            doc.removeEventListener('focusin', cancel);
            doc.removeEventListener('pointerdown', cancel);
            doc.removeEventListener('keydown', cancel);
        };
    }, [request, navigationKey, enabled, sidebarVisible, isPending, runId]);

    return start;
}
