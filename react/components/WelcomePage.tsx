import React, { useState } from "react";
import Button from "./button";
import FileStatusStats from "./FileStatusStats";
import FileStatusDisplay from "./FileStatusDisplay";
import { ArrowDownIcon, ArrowRightIcon } from './icons';
import { useFileStatus } from '../hooks/useFileStatus';
import { isPreferencePageVisibleAtom } from '../atoms/ui';
import { useSetAtom, useAtomValue } from 'jotai';
import { getPref } from '../../src/utils/prefs';
import { QuickPrompt } from "./PreferencePage";
import { isStreamingAtom } from '../atoms/threads';
import { generateResponseAtom } from '../atoms/generateMessages';
import { currentReaderAttachmentAtom, currentSourcesAtom } from "../atoms/input";
import { planFeaturesAtom } from "../atoms/profile";

const getQuickPromptPreferences = (): QuickPrompt[] => {
    const quickPrompts: QuickPrompt[] = [];
    const prompt1 = getPref(`quickPrompt1_text`);
    if (prompt1) {
        quickPrompts.push({
            index: 1,
            title: getPref(`quickPrompt1_title`) || '',
            text: prompt1,
            librarySearch: getPref(`quickPrompt1_librarySearch`) || false,
            requiresAttachment: getPref(`quickPrompt1_requiresAttachment`) || false
        });
    }
    const prompt2 = getPref(`quickPrompt2_text`);
    if (prompt2) {
        quickPrompts.push({
            index: 2,
            title: getPref(`quickPrompt2_title`) || '',
            text: prompt2,
            librarySearch: getPref(`quickPrompt2_librarySearch`) || false,
            requiresAttachment: getPref(`quickPrompt2_requiresAttachment`) || false
        });
    }
    const prompt3 = getPref(`quickPrompt3_text`);
    if (prompt3) {
        quickPrompts.push({
            index: 3,
            title: getPref(`quickPrompt3_title`) || '',
            text: prompt3,
            librarySearch: getPref(`quickPrompt3_librarySearch`) || false,
            requiresAttachment: getPref(`quickPrompt3_requiresAttachment`) || false
        });
    }
    const prompt4 = getPref(`quickPrompt4_text`);
    if (prompt4) {
        quickPrompts.push({
            index: 4,
            title: getPref(`quickPrompt4_title`) || '',
            text: prompt4,
            librarySearch: getPref(`quickPrompt4_librarySearch`) || false,
            requiresAttachment: getPref(`quickPrompt4_requiresAttachment`) || false
        });
    }
    const prompt5 = getPref(`quickPrompt5_text`);
    if (prompt5) {
        quickPrompts.push({
            index: 5,
            title: getPref(`quickPrompt5_title`) || '',
            text: prompt5,
            librarySearch: getPref(`quickPrompt5_librarySearch`) || false,
            requiresAttachment: getPref(`quickPrompt5_requiresAttachment`) || false
        });
    }
    const prompt6 = getPref(`quickPrompt6_text`);
    if (prompt6) {
        quickPrompts.push({
            index: 6,
            title: getPref(`quickPrompt6_title`) || '',
            text: prompt6,
            librarySearch: getPref(`quickPrompt6_librarySearch`) || false,
            requiresAttachment: getPref(`quickPrompt6_requiresAttachment`) || false
        });
    }
    return quickPrompts;
}

type Prompt = {
    title: string;
    prompt: string;
    shortcut: string;
}

const WelcomePage: React.FC = () => {
    const [showFileStatus, setShowFileStatus] = useState(true);
    const togglePreferencePage = useSetAtom(isPreferencePageVisibleAtom);
    const isStreaming = useAtomValue(isStreamingAtom);
    const currentSources = useAtomValue(currentSourcesAtom);
    const generateResponse = useSetAtom(generateResponseAtom);
    const currentReaderAttachment = useAtomValue(currentReaderAttachmentAtom);
    const planFeatures = useAtomValue(planFeaturesAtom);

    // Realtime listening for file status updates
    useFileStatus();

    const handleQuickPrompt = async (
        prompt: QuickPrompt
    ) => {
        if (isStreaming || prompt.text.length === 0) return;
        if (prompt.requiresAttachment && currentSources.length === 0) return;

        // Generate response
        generateResponse({
            content: prompt.text,
            sources: currentSources,
            isLibrarySearch: prompt.librarySearch
        });

        console.log('Chat completion:', prompt.text);
    };

    const prompts: QuickPrompt[] = getQuickPromptPreferences();
    const shortcutKey = Zotero.isMac ? '⌘^' : 'Ctrl+Win+';

    return (
        <div 
            id="beaver-welcome"
            className="display-flex flex-col flex-1 min-h-0 overflow-y-auto gap-4 scrollbar min-w-0 p-4"
        >
            {/* <div className="flex-1"/> */}
            {/* <div style={{height: "10%"}}/> */}
            {prompts.length > 0 && (
                <>
                <div className="display-flex flex-row justify-between items-center">
                    <div className="font-semibold text-lg mb-1">Quick Prompts</div>
                    <Button variant="outline" className="scale-85 fit-content" onClick={() => togglePreferencePage((prev) => !prev)}> Edit </Button>
                </div>
                {prompts.map((prompt, index) => (
                    <Button
                        key={index}
                        variant="surface-light"
                        onClick={() => handleQuickPrompt(prompt)}
                        disabled={prompt.requiresAttachment && currentSources.length === 0 && !currentReaderAttachment && !currentReaderAttachment}
                    >
                        <span className={`text-base ${prompt.requiresAttachment && currentSources.length === 0 && !currentReaderAttachment ? 'font-color-quarternary' : 'font-color-tertiary'}`}>
                            {`${shortcutKey}${prompt.index}`}
                        </span>
                        <span className={`text-base truncate ${prompt.requiresAttachment && currentSources.length === 0 && !currentReaderAttachment ? 'font-color-tertiary' : 'font-color-secondary'}`}>
                            {prompt.title}
                        </span>
                    </Button>
                ))}
                </>
            )}
            {planFeatures.fileProcessing && (
                <>
                <div className="display-flex flex-row justify-between items-center mt-4">
                    <Button
                        variant="ghost"
                        onClick={() => setShowFileStatus(!showFileStatus)}
                        rightIcon={showFileStatus ? ArrowDownIcon : ArrowRightIcon}
                        iconClassName="mr-0 scale-14"
                    >
                        <span className="font-semibold text-lg mb-1 font-color-primary" style={{ marginLeft: '-3px' }}>
                            File Status
                        </span>
                    </Button>
                    {!showFileStatus && (
                        <FileStatusDisplay showFileStatus={showFileStatus} setShowFileStatus={setShowFileStatus}/>
                    )}
                </div>
                
                {showFileStatus && (
                    <FileStatusStats />
                )}
                </>
            )}
        </div>
    );
};

export default WelcomePage;