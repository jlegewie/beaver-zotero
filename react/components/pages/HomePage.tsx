import React from "react";
import Button from "../ui/Button";
import FileStatusButton from "../ui/buttons/FileStatusButton";
import { ArrowDownIcon, ArrowRightIcon } from '../icons/icons';
import { useFileStatus } from '../../hooks/useFileStatus';
import { showFileStatusDetailsAtom } from '../../atoms/ui';
import { useAtomValue, useAtom } from 'jotai';
import { useIndexingCompleteMessage } from "../../hooks/useIndexingCompleteMessage";
import FileStatusDisplay from "../status/FileStatusDisplay";
import { isDatabaseSyncSupportedAtom } from "../../atoms/profile";
import RecentChats from "../RecentChats";
import ActionSuggestions from "../ActionSuggestions";
import { actionsForContextAtom } from "../../atoms/actions";
import InputArea from "../input/InputArea";
import DragDropWrapper from "../input/DragDropWrapper";
import PreviewAndPopupContainer from "../PreviewAndPopupContainer";

interface HomePageProps {
    isWindow?: boolean;
    inputRef: React.RefObject<HTMLTextAreaElement | null>;
}

const HomePage: React.FC<HomePageProps> = ({ isWindow = false, inputRef }) => {
    const [showFileStatusDetails, setShowFileStatusDetails] = useAtom(showFileStatusDetailsAtom);
    const isDatabaseSyncSupported = useAtomValue(isDatabaseSyncSupportedAtom);
    const actions = useAtomValue(actionsForContextAtom);

    // Realtime listening for file status updates (only in sidebar, not in separate windows)
    const { connectionStatus } = useFileStatus(!isWindow);
    useIndexingCompleteMessage();

    return (
        <div
            id="welcome-page"
            className="display-flex flex-col flex-1 min-h-0"
        >
            {/* Scrollable top section */}
            <div className="display-flex flex-col flex-1 overflow-y-auto scrollbar px-4 pt-4 gap-4">
                {/* Top spacer */}
                <div className="flex-1" style={{ minHeight: '2vh', maxHeight: '4vh' }} />

                {/* Greeting */}
                <div className="text-2xl font-semibold text-center p-2">How can I help you?</div>

                {/* Input area */}
                <DragDropWrapper>
                    <InputArea inputRef={inputRef} />
                </DragDropWrapper>

                {/* Action suggestions */}
                {actions.length > 0 && (
                    <ActionSuggestions showGlobal={false} />
                )}

                {/* Bottom spacer */}
                <div className="flex-1" />
            </div>

            {/* Fixed bottom section */}
            <div id="beaver-home-footer" className="flex-none px-4 pb-4 relative">
                <PreviewAndPopupContainer />

                {/* File Processing Status */}
                {/* {isDatabaseSyncSupported && !isWindow && (
                    <>
                        <div className="display-flex flex-row justify-between items-center">
                            <Button
                                variant="ghost-secondary"
                                onClick={() => setShowFileStatusDetails(!showFileStatusDetails)}
                                rightIcon={showFileStatusDetails ? ArrowDownIcon : ArrowRightIcon}
                                iconClassName="mr-0"
                            >
                                <span className="font-semibold text-sm mb-1" style={{ marginLeft: '-3px' }}>
                                    File Status
                                </span>
                            </Button>
                            {!showFileStatusDetails && (
                                <FileStatusButton showFileStatus={showFileStatusDetails} setShowFileStatus={setShowFileStatusDetails}/>
                            )}
                        </div>

                        {showFileStatusDetails && (
                            <div className="display-flex flex-col gap-4 min-w-0 w-full">
                                <FileStatusDisplay connectionStatus={connectionStatus}/>
                            </div>
                        )}
                    </>
                )} */}

                <RecentChats />
            </div>
        </div>
    );
};

export default HomePage;
