import React from "react";
import Button from "../ui/Button";
import FileStatusButton from "../ui/buttons/FileStatusButton";
import { ArrowDownIcon, ArrowRightIcon } from '../icons/icons';
import { useFileStatus } from '../../hooks/useFileStatus';
import { showFileStatusDetailsAtom } from '../../atoms/ui';
import { useSetAtom, useAtomValue, useAtom } from 'jotai';
import { openPreferencesWindow } from '../../../src/ui/openPreferencesWindow';
import { isStreamingAtom } from '../../agents/atoms';
import { sendWSMessageAtom, isWSChatPendingAtom } from '../../atoms/agentRunAtoms';
import { currentMessageItemsAtom, currentReaderAttachmentAtom } from "../../atoms/messageComposition";
import { CustomPrompt } from "../../types/settings";
import { customPromptsForContextAtom } from "../../atoms/customPrompts";
import { useIndexingCompleteMessage } from "../../hooks/useIndexingCompleteMessage";
import FileStatusDisplay from "../status/FileStatusDisplay";
import { isDatabaseSyncSupportedAtom } from "../../atoms/profile";

interface HomePageProps {
    isWindow?: boolean;
}

const HomePage: React.FC<HomePageProps> = ({ isWindow = false }) => {
    const isStreaming = useAtomValue(isStreamingAtom);
    const isPending = useAtomValue(isWSChatPendingAtom);
    const [showFileStatusDetails, setShowFileStatusDetails] = useAtom(showFileStatusDetailsAtom);
    const currentMessageItems = useAtomValue(currentMessageItemsAtom);
    const sendWSMessage = useSetAtom(sendWSMessageAtom);
    const currentReaderAttachment = useAtomValue(currentReaderAttachmentAtom);
    const isDatabaseSyncSupported = useAtomValue(isDatabaseSyncSupportedAtom);
    const prompts = useAtomValue(customPromptsForContextAtom);

    // Realtime listening for file status updates (only in sidebar, not in separate windows)
    const { connectionStatus } = useFileStatus(!isWindow);
    useIndexingCompleteMessage();

    const handleCustomPrompt = async (
        prompt: CustomPrompt
    ) => {
        if (isPending || isStreaming || prompt.text.length === 0) return;
        if (prompt.requiresAttachment && currentMessageItems.length === 0 && !currentReaderAttachment) return;

        // Send message via WebSocket
        await sendWSMessage(prompt.text);
    };
    const shortcutKey = Zotero.isMac ? '⌘^' : 'Ctrl+Win+';

    return (
        <div 
            id="welcome-page"
            className="display-flex flex-col flex-1 min-h-0 overflow-y-auto gap-4 scrollbar min-w-0 p-4"
        >
            {/* Top spacing */}
            <div style={{ height: prompts.length > 0 ? '5vh' : '0vh' }}></div>

            {/* Custom Prompt */}
            {prompts.length > 0 && (
                <>
                <div className="display-flex flex-row justify-between items-center mb-2">
                    {/* <div className="font-semibold text-lg mb-1">Custom Prompts</div> */}
                    <div className="text-xl font-semibold">How can I help you?</div>
                    <Button variant="outline" className="scale-85 fit-content" onClick={() => openPreferencesWindow('prompts')}> Edit </Button>
                </div>
                {/* <div className="display-flex flex-col items-start mb-4">
                    <p className="text-base font-color-secondary -mt-2">Beaver will sync your library, upload your PDFs, and index your files for search. This process can take 20-60 min.</p>
                </div> */}
                {prompts.map((prompt) => (
                    <Button
                        key={prompt.id || prompt.index}
                        variant="ghost"
                        onClick={() => handleCustomPrompt(prompt)}
                        disabled={isPending || (prompt.requiresAttachment && currentMessageItems.length === 0 && !currentReaderAttachment && !currentReaderAttachment)}
                        className="w-full justify-between"
                        style={{ padding: '6px 8px' }}
                    >
                        <span className="text-base truncate">
                            {prompt.title}
                        </span>
                        {prompt.shortcut != null && (
                            <span className={`text-sm ml-2 flex-shrink-0 ${prompt.requiresAttachment && currentMessageItems.length === 0 && !currentReaderAttachment ? 'font-color-quarternary' : 'font-color-tertiary'}`}>
                                {`${shortcutKey}${prompt.shortcut}`}
                            </span>
                        )}
                    </Button>
                ))}
                </>
            )}
            
            {/* File Processing Status */}
            {isDatabaseSyncSupported && !isWindow && (
                <div className="display-flex flex-row justify-between items-center mt-4">
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
            
            {isDatabaseSyncSupportedAtom && !isWindow && showFileStatusDetails && (
                <div className="display-flex flex-col gap-4 min-w-0 w-full">
                    <FileStatusDisplay connectionStatus={connectionStatus}/>
                </div>
            )}
        </div>
    );
};

export default HomePage;
