import React, { useRef, useCallback } from 'react';
import { CancelIcon, PlusSignIcon, SettingsIcon, Share05Icon } from './icons/icons';
import PdfIcon from './icons/PdfIcon';
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
import { isPreferencePageVisibleAtom } from '../atoms/ui';
import { planFeaturesAtom, hasCompletedOnboardingAtom } from '../atoms/profile';
import Button from './ui/Button';
import { getWindowFromElement } from '../utils/windowContext';
import { PDFExtractor, ExtractionError, ExtractionErrorCode } from '../../src/services/pdf';

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
    const closeButtonRef = useRef<HTMLButtonElement>(null);

    const handleNewThread = async () => {
        await newThread();
    }

    const handleClose = useCallback(() => {
        if (isWindow) {
            // Get the actual window where the button is rendered, not the main window
            const currentWindow = getWindowFromElement(closeButtonRef.current);
            currentWindow.close();
        } else {
            triggerToggleChat(Zotero.getMainWindow());
        }
    }, [isWindow]);

    // TEMPORARY: Test PDF extraction
    const handleTestPdfExtraction = useCallback(async () => {
        const selectedItems: Zotero.Item[] = Zotero.getActiveZoteroPane().getSelectedItems() || [];
        
        if (selectedItems.length === 0) {
            console.log("[PDF Test] No item selected");
            return;
        }

        let pdfItem = selectedItems[0];

        // If it's a parent item, try to get the first PDF attachment
        if (!pdfItem.isPDFAttachment()) {
            const attachmentIDs = pdfItem.getAttachments();
            const pdfAttachment = attachmentIDs
                .map(id => Zotero.Items.get(id))
                .find(item => item.isPDFAttachment());
            
            if (!pdfAttachment) {
                console.log("[PDF Test] Selected item is not a PDF and has no PDF attachments");
                return;
            }
            pdfItem = pdfAttachment;
        }

        console.log("[PDF Test] Starting extraction for:", pdfItem.getField("title") || pdfItem.getDisplayTitle());

        try {
            const filePath = await pdfItem.getFilePathAsync();
            if (!filePath) {
                console.log("[PDF Test] File path not found");
                return;
            }

            const pdfData = await IOUtils.read(filePath);
            const extractor = new PDFExtractor();
            const result = await extractor.extract(pdfData, { checkTextLayer: true });

            console.log("[PDF Test] Extraction complete!");
            console.log("[PDF Test] Page count:", result.analysis.pageCount);
            console.log("[PDF Test] Has text layer:", result.analysis.hasTextLayer);
            console.log("[PDF Test] Full text (first 2000 chars):", result.fullText.slice(0, 2000));
            console.log("[PDF Test] Full result:", result);
        } catch (error) {
            // Handle specific extraction errors
            if (error instanceof ExtractionError) {
                switch (error.code) {
                    case ExtractionErrorCode.ENCRYPTED:
                        console.warn("[PDF Test] Document is encrypted:", error.message);
                        break;
                    case ExtractionErrorCode.NO_TEXT_LAYER:
                        console.warn("[PDF Test] Document has no text layer (needs OCR):", error.message);
                        break;
                    case ExtractionErrorCode.INVALID_PDF:
                        console.error("[PDF Test] Invalid PDF:", error.message);
                        break;
                    default:
                        console.error("[PDF Test] Extraction error:", error.code, error.message);
                }
            } else {
                console.error("[PDF Test] Extraction failed:", error);
            }
        }
    }, []);

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

                {/* TEMPORARY: Test PDF extraction button - REMOVE BEFORE RELEASE */}
                <Tooltip content="[DEV] Test PDF Extraction" showArrow singleLine>
                    <IconButton
                        icon={PdfIcon}
                        onClick={handleTestPdfExtraction}
                        className="scale-14"
                        ariaLabel="Test PDF extraction"
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