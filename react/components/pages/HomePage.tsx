import React from "react";
import Button from "../ui/Button";
import { useSetAtom, useAtomValue } from 'jotai';
import { openPreferencesWindow } from '../../../src/ui/openPreferencesWindow';
import { isStreamingAtom } from '../../agents/atoms';
import { isWSChatPendingAtom } from '../../atoms/agentRunAtoms';
import { currentMessageItemsAtom, currentReaderAttachmentAtom } from "../../atoms/messageComposition";
import { CustomPrompt } from "../../types/settings";
import { customPromptsForContextAtom, markPromptUsedAtom, sendResolvedPromptAtom } from "../../atoms/customPrompts";
import { useIndexingCompleteMessage } from "../../hooks/useIndexingCompleteMessage";


const HomePage: React.FC = () => {
    const isStreaming = useAtomValue(isStreamingAtom);
    const isPending = useAtomValue(isWSChatPendingAtom);
    const currentMessageItems = useAtomValue(currentMessageItemsAtom);
    const sendResolvedPrompt = useSetAtom(sendResolvedPromptAtom);
    const currentReaderAttachment = useAtomValue(currentReaderAttachmentAtom);
    const prompts = useAtomValue(customPromptsForContextAtom);
    const markPromptUsed = useSetAtom(markPromptUsedAtom);

    // Indexing complete message
    useIndexingCompleteMessage();

    const handleCustomPrompt = async (prompt: CustomPrompt) => {
        if (isPending || isStreaming || prompt.text.length === 0) return;
        if (prompt.requiresAttachment && currentMessageItems.length === 0 && !currentReaderAttachment) return;
        if (prompt.id) markPromptUsed(prompt.id);
        await sendResolvedPrompt(prompt.text);
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
                    <div className="text-2xl font-semibold">How can I help you?</div>
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
                        title={(prompt.requiresAttachment && currentMessageItems.length === 0 && !currentReaderAttachment && !currentReaderAttachment) ? 'Requires attachments' : 'Run action'}
                    >
                        <span className="text-lg truncate">
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
            
        </div>
    );
};

export default HomePage;
