import React from "react";
import Button from "../ui/Button";
import FileStatusButton from "../ui/buttons/FileStatusButton";
import { ArrowDownIcon, ArrowRightIcon } from '../icons/icons';
import { useFileStatus } from '../../hooks/useFileStatus';
import { showFileStatusDetailsAtom } from '../../atoms/ui';
import { useAtomValue, useAtom } from 'jotai';
import { openPreferencesWindow } from '../../../src/ui/openPreferencesWindow';
import { useIndexingCompleteMessage } from "../../hooks/useIndexingCompleteMessage";
import FileStatusDisplay from "../status/FileStatusDisplay";
import { isDatabaseSyncSupportedAtom } from "../../atoms/profile";
import RecentChats from "../RecentChats";
import ActionSuggestions from "../ActionSuggestions";
import { actionsForContextAtom } from "../../atoms/actions";

interface HomePageProps {
    isWindow?: boolean;
}

const HomePage: React.FC<HomePageProps> = ({ isWindow = false }) => {
    const [showFileStatusDetails, setShowFileStatusDetails] = useAtom(showFileStatusDetailsAtom);
    const isDatabaseSyncSupported = useAtomValue(isDatabaseSyncSupportedAtom);
    const actions = useAtomValue(actionsForContextAtom);

    // Realtime listening for file status updates (only in sidebar, not in separate windows)
    const { connectionStatus } = useFileStatus(!isWindow);
    useIndexingCompleteMessage();

    return (
        <div
            id="welcome-page"
            className="display-flex flex-col flex-1 min-h-0 overflow-y-auto gap-4 scrollbar min-w-0 p-4"
        >
            {/* Top spacing */}
            <div style={{ height: actions.length > 0 ? '5vh' : '0vh' }}></div>

            {/* Actions */}
            {actions.length > 0 && (
                <>
                    <div className="display-flex flex-row justify-between items-center mb-2">
                        <div className="text-2xl font-semibold">How can I help you?</div>
                        <Button variant="outline" className="scale-85 fit-content" onClick={() => openPreferencesWindow('prompts')}> Edit </Button>
                    </div>
                    <ActionSuggestions showGlobal={false} className="display-flex flex-col gap-05" />
                </>
            )}

            {/* File Processing Status */}
            {isDatabaseSyncSupported && !isWindow && (
                <div className="display-flex flex-row justify-between items-center mt-5">
                    <Button
                        variant="ghost-secondary"
                        onClick={() => setShowFileStatusDetails(!showFileStatusDetails)}
                        rightIcon={showFileStatusDetails ? ArrowDownIcon : ArrowRightIcon}
                        iconClassName="mr-0 scale-14"
                    >
                        <span className="font-semibold text-lg mb-1" style={{ marginLeft: '-3px' }}>
                            File Status
                        </span>
                    </Button>
                    {!showFileStatusDetails && (
                        <FileStatusButton showFileStatus={showFileStatusDetails} setShowFileStatus={setShowFileStatusDetails}/>
                    )}
                </div>
            )}

            <RecentChats />

            {isDatabaseSyncSupportedAtom && !isWindow && showFileStatusDetails && (
                <div className="display-flex flex-col gap-4 min-w-0 w-full">
                    <FileStatusDisplay connectionStatus={connectionStatus}/>
                </div>
            )}
        </div>
    );
};

export default HomePage;
