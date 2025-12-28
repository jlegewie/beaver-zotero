import React, { useRef, useCallback } from 'react';
import { CancelIcon, PlusSignIcon, SettingsIcon, Share05Icon } from './icons/icons';
import SearchIcon from './icons/SearchIcon';
import DatabaseStatusButton from './ui/buttons/DatabaseStatusButton';
import { triggerToggleChat } from '../../src/ui/toggleChat';
import { openBeaverWindow } from '../../src/ui/openBeaverWindow';
import { newThreadAtom } from '../atoms/threads';
import { runsCountAtom } from '../agents/atoms';
import { useAtomValue, useSetAtom } from 'jotai';
import IconButton from './ui/IconButton';
import Tooltip from './ui/Tooltip';
import { isAuthenticatedAtom } from '../atoms/auth';
import ThreadsMenu from './ui/menus/ThreadsMenu';
import UserAccountMenuButton from './ui/buttons/UserAccountMenuButton';
import PdfTestMenuButton from './ui/buttons/PdfTestMenuButton';
import { isPreferencePageVisibleAtom } from '../atoms/ui';
import { planFeaturesAtom, hasCompletedOnboardingAtom } from '../atoms/profile';
import Button from './ui/Button';
import { getWindowFromElement } from '../utils/windowContext';
import { currentMessageContentAtom } from '../atoms/messageComposition';
import { semanticSearchService } from '../../src/services/semanticSearchService';
import { BeaverDB } from 'src/services/database';

interface HeaderProps {
    onClose?: () => void;
    settingsPage?: boolean;
    isWindow?: boolean;
}

const Header: React.FC<HeaderProps> = ({ onClose, settingsPage, isWindow = false }) => {
    const runsCount = useAtomValue(runsCountAtom);
    const newThread = useSetAtom(newThreadAtom);
    const isAuthenticated = useAtomValue(isAuthenticatedAtom);
    const isPreferencePageVisible = useAtomValue(isPreferencePageVisibleAtom);
    const planFeatures = useAtomValue(planFeaturesAtom);
    const setPreferencePageVisible = useSetAtom(isPreferencePageVisibleAtom);
    const hasCompletedOnboarding = useAtomValue(hasCompletedOnboardingAtom);
    const currentMessageContent = useAtomValue(currentMessageContentAtom);
    const closeButtonRef = useRef<HTMLButtonElement>(null);

    const handleNewThread = async () => {
        await newThread();
    }

    // TEMPORARY: Test semantic search
    const handleTestSearch = async () => {
        try {
            const query = currentMessageContent;
            if (!query || query.trim().length === 0) {
                console.log('No query text in currentMessageContentAtom');
                return;
            }

            console.log('Testing semantic search with query:', query);
            
            // Get database instance from global addon
            const db = Zotero.Beaver?.db as BeaverDB | null;
            if (!db) {
                console.error('Database not available');
                return;
            }

            // Create search service instance
            const searchService = new semanticSearchService(db, 512);
            
            // Run search
            const results = await searchService.search(query, {
                topK: 20,
                minSimilarity: 0.3
            });

            console.log('Semantic search results:', results);
            console.log(`Found ${results.length} results`);
            
            // Log top 5 results with item details
            for (let i = 0; i < Math.min(20, results.length); i++) {
                const result = results[i];
                const item = await Zotero.Items.getAsync(result.itemId);
                console.log(`${i + 1}. [${result.similarity.toFixed(3)}] ${item?.getField('title') || 'Unknown'}`);
            }
        } catch (error) {
            console.error('Semantic search test failed:', error);
        }
    };

    const handleClose = useCallback(() => {
        if (isWindow) {
            // Get the actual window where the button is rendered, not the main window
            const currentWindow = getWindowFromElement(closeButtonRef.current);
            currentWindow.close();
        } else {
            triggerToggleChat(Zotero.getMainWindow());
        }
    }, [isWindow]);

    // Get platform-specific shortcut text
    const newChatShortcut = Zotero.isMac ? '⌘N' : 'Ctrl+N';
    const closeChatShortcut = Zotero.isMac ? '⌘L' : 'Ctrl+L';

    return (
        <div id="beaver-header" className="display-flex flex-row px-3 py-2">
            <div className="flex-1 display-flex gap-4">

                {/* Close chat / Close window */}
                {!isWindow && (
                    <Tooltip 
                        content={isWindow ? "Close window" : "Close chat"} 
                        secondaryContent={isWindow ? undefined : closeChatShortcut} 
                        showArrow 
                        singleLine
                    >
                        <IconButton
                            ref={closeButtonRef}
                            icon={CancelIcon}
                            onClick={handleClose}
                            className="scale-14"
                            ariaLabel={isWindow ? "Close window" : "Close chat"}
                        />
                    </Tooltip>
                )}
                
                {/* New chat and chat history */}
                {isAuthenticated && hasCompletedOnboarding && (
                    <>
                    <Tooltip content="New Chat" secondaryContent={newChatShortcut} showArrow singleLine>
                        <IconButton
                            icon={PlusSignIcon}
                            onClick={handleNewThread}
                            className="scale-14"
                            ariaLabel="New thread"
                            disabled={runsCount === 0 && !isPreferencePageVisible}
                        />
                    </Tooltip>
                    </>
                )}

                {/* Only show "Open in Separate Window" button when not already in a separate window and user is authenticated and has completed onboarding */}
                {!isWindow && isAuthenticated && hasCompletedOnboarding && (
                    <Tooltip content="Open in Separate Window" showArrow singleLine>
                        <IconButton
                            icon={Share05Icon}
                            onClick={openBeaverWindow}
                            className="scale-13"
                            ariaLabel="Open in Separate Window"
                        />
                    </Tooltip>
                )}

                {/* TEMPORARY: PDF testing tools - REMOVE BEFORE RELEASE */}
                <PdfTestMenuButton
                    className="scale-14"
                    ariaLabel="PDF testing tools"
                />

                {/* TEMPORARY: Semantic search testing - REMOVE BEFORE RELEASE */}
                <Tooltip content="Test Semantic Search" showArrow singleLine>
                    <IconButton
                        icon={SearchIcon}
                        onClick={handleTestSearch}
                        className="scale-14"
                        ariaLabel="Test semantic search"
                    />
                </Tooltip>
            </div>

            {/* Database status and user account menu */}
            {isAuthenticated && !settingsPage && (
                <div className="display-flex gap-4">
                    {planFeatures.databaseSync && hasCompletedOnboarding &&
                        <DatabaseStatusButton />
                    }
                    {isAuthenticated && hasCompletedOnboarding && (
                        <ThreadsMenu
                            className="scale-14"
                            ariaLabel="Show chat history"
                        />
                    )}
                    <UserAccountMenuButton
                        className="scale-14"
                        ariaLabel="User settings"
                    />
                </div>
            )}

            {/* Close settings page */}
            {isAuthenticated && settingsPage && (
                <Button
                    variant="outline"
                    rightIcon={SettingsIcon}
                    onClick={() => setPreferencePageVisible((prev) => !prev)}
                    iconClassName="scale-12"
                >
                    <span className="text-base">Close</span>
                </Button>
            )}
        </div>
    );
};

export default Header;