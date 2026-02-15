import React, { useEffect } from 'react';
import { useSetAtom } from 'jotai';
import { isPreferencePageVisibleAtom, activePreferencePageTabAtom, PreferencePageTab } from '../atoms/ui';
import PreferencePage from './pages/PreferencePage';
import DialogContainer from './dialog/DialogContainer';

interface PreferencesWindowProps {
    initialTab?: PreferencePageTab | null;
}

const PreferencesWindow: React.FC<PreferencesWindowProps> = ({ initialTab }) => {
    const setPreferencePageVisible = useSetAtom(isPreferencePageVisibleAtom);
    const setActiveTab = useSetAtom(activePreferencePageTabAtom);

    useEffect(() => {
        // Signal that preferences are visible (used by useProfileSync)
        setPreferencePageVisible(true);

        // Set the initial tab if provided
        if (initialTab) {
            setActiveTab(initialTab);
        }

        // Register global function so BeaverUIFactory can switch tabs on already-open window
        (Zotero as any).__beaverOpenPreferencesTab = (tab: PreferencePageTab) => {
            setActiveTab(tab);
        };

        return () => {
            setPreferencePageVisible(false);
            delete (Zotero as any).__beaverOpenPreferencesTab;
        };
    }, []);

    return (
        <div className="bg-sidepane h-full w-full display-flex flex-col min-w-0 relative">
            <PreferencePage />
            <DialogContainer />
        </div>
    );
};

export default PreferencesWindow;
