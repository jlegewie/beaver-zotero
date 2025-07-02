import React, { useState } from "react";
import Button from "../ui/Button";
import FileStatusButton from "../ui/buttons/FileStatusButton";
import { ArrowDownIcon, ArrowRightIcon } from '../icons/icons';
import { useFileStatus } from '../../hooks/useFileStatus';
import { isPreferencePageVisibleAtom, showFileStatusDetailsAtom } from '../../atoms/ui';
import { useSetAtom, useAtomValue, useAtom } from 'jotai';
import { isStreamingAtom } from '../../atoms/threads';
import { generateResponseAtom } from '../../atoms/generateMessages';
import { currentReaderAttachmentAtom, currentSourcesAtom } from "../../atoms/input";
import { getCustomPromptsFromPreferences, CustomPrompt } from "../../types/settings";
import FileProcessingStatus from "../status/FileProcessingStatus";
import FileUploadStatus from "../status/FileUploadStatus";
import { useIndexingCompleteMessage } from "../../hooks/useIndexingCompleteMessage";


const HomePage: React.FC = () => {
    const togglePreferencePage = useSetAtom(isPreferencePageVisibleAtom);
    const isStreaming = useAtomValue(isStreamingAtom);
    const [showFileStatusDetails, setShowFileStatusDetails] = useAtom(showFileStatusDetailsAtom);
    const currentSources = useAtomValue(currentSourcesAtom);
    const generateResponse = useSetAtom(generateResponseAtom);
    const currentReaderAttachment = useAtomValue(currentReaderAttachmentAtom);

    // Realtime listening for file status updates
    const { connectionStatus } = useFileStatus();
    useIndexingCompleteMessage();

    const handleCustomPrompt = async (
        prompt: CustomPrompt
    ) => {
        if (isStreaming || prompt.text.length === 0) return;
        if (prompt.requiresAttachment && currentSources.length === 0) return;

        // Generate response
        generateResponse({
            content: prompt.text,
            sources: currentSources,
            isLibrarySearch: prompt.librarySearch
        });

        // console.log('Chat completion:', prompt.text);
    };

    const prompts: CustomPrompt[] = getCustomPromptsFromPreferences();
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
                <div className="display-flex flex-row justify-between items-center">
                    {/* <div className="font-semibold text-lg mb-1">Custom Prompts</div> */}
                    <div className="text-xl font-semibold">Custom Prompts</div>
                    <Button variant="outline" className="scale-85 fit-content" onClick={() => togglePreferencePage((prev) => !prev)}> Edit </Button>
                </div>
                {/* <div className="display-flex flex-col items-start mb-4">
                    <p className="text-base font-color-secondary -mt-2">Beaver will sync your library, upload your PDFs, and index your files for search. This process can take 20-60 min.</p>
                </div> */}
                {prompts.map((prompt, index) => (
                    <Button
                        key={index}
                        variant="ghost-secondary"
                        onClick={() => handleCustomPrompt(prompt)}
                        disabled={prompt.requiresAttachment && currentSources.length === 0 && !currentReaderAttachment && !currentReaderAttachment}
                    >
                        <span className={`text-sm mr-2 ${prompt.requiresAttachment && currentSources.length === 0 && !currentReaderAttachment ? 'font-color-quarternary' : 'font-color-tertiary'}`}>
                            {`${shortcutKey}${prompt.index}`}
                        </span>
                        <span
                            className={`text-base truncate
                                `}>
                            {prompt.title}
                        </span>
                    </Button>
                ))}
                </>
            )}
            
            {/* File Processing Status */}
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
            
            {showFileStatusDetails && (
                <div className="display-flex flex-col gap-4 min-w-0 w-full">
                    <FileUploadStatus connectionStatus={connectionStatus}/>
                    <FileProcessingStatus connectionStatus={connectionStatus} />
                </div>
            )}
        </div>
    );
};

export default HomePage;