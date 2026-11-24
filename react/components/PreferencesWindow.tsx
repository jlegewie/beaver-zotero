import React, { useEffect, useRef } from 'react';
import { useSetAtom } from 'jotai';
import { isPreferencePageVisibleAtom, activePreferencePageTabAtom, pendingActionsFilterAtom, pendingActionEditRequestAtom, PreferencePageTab } from '../atoms/ui';
import { prefWindowFocusRefreshAtom } from '../atoms/profile';
import type { ActionsListFilter } from '@beaver/agent-core/types/actions';
import PreferencePage from './preferences/PreferencePage';
import DialogContainer from './dialog/DialogContainer';

interface PreferencesWindowProps {
    initialTab?: PreferencePageTab | null;
    initialActionsFilter?: ActionsListFilter | null;
    initialActionId?: string | null;
}

const PreferencesWindow: React.FC<PreferencesWindowProps> = ({ initialTab, initialActionsFilter, initialActionId }) => {
    const setPreferencePageVisible = useSetAtom(isPreferencePageVisibleAtom);
    const setActiveTab = useSetAtom(activePreferencePageTabAtom);
    const setPendingActionsFilter = useSetAtom(pendingActionsFilterAtom);
    const setPendingActionEditRequest = useSetAtom(pendingActionEditRequestAtom);
    const setPrefWindowFocusRefresh = useSetAtom(prefWindowFocusRefreshAtom);
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        // Signal that preferences are visible (used by useProfileSync)
        setPreferencePageVisible(true);

        // Set the initial tab, defaulting to 'general' for generic opens
        setActiveTab(initialTab || 'general');
        if (initialActionsFilter) {
            setPendingActionsFilter({ filter: initialActionsFilter, requestId: Date.now() });
        }
        if (initialActionId) {
            setPendingActionEditRequest({ actionId: initialActionId, requestId: Date.now() });
        }

        // Register global function so BeaverUIFactory can switch tabs (and request
        // actions list filters or an action-edit reveal) on an already-open window
        (Zotero as any).__beaverOpenPreferencesTab = (tab: PreferencePageTab, actionsFilter?: ActionsListFilter, actionId?: string) => {
            setActiveTab(tab);
            if (tab === 'actions') {
                if (actionId) {
                    setPendingActionEditRequest({ actionId, requestId: Date.now() });
                } else {
                    setPendingActionsFilter({ filter: actionsFilter ?? null, requestId: Date.now() });
                }
            }
        };

        return () => {
            setPreferencePageVisible(false);
            delete (Zotero as any).__beaverOpenPreferencesTab;
        };
    }, []);

    // Refresh profile when preferences window regains focus (e.g., returning from Stripe checkout)
    useEffect(() => {
        const win = containerRef.current?.ownerDocument?.defaultView;
        if (!win) return;

        const handleFocus = () => {
            setPrefWindowFocusRefresh(true);
        };

        win.addEventListener('focus', handleFocus);
        return () => win.removeEventListener('focus', handleFocus);
    }, [setPrefWindowFocusRefresh]);

    return (
        <div ref={containerRef} className="bg-sidepane h-full w-full display-flex flex-col min-w-0 relative">
            <PreferencePage />
            <DialogContainer />
        </div>
    );
};

export default PreferencesWindow;
