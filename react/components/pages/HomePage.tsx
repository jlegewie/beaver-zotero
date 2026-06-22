import React from "react";
import { useAtomValue } from 'jotai';
import { isDatabaseSyncSupportedAtom } from "../../atoms/profile";
import RecentChats from "../RecentChats";
import ActionSuggestions from "../ActionSuggestions";
import { actionsForContextAtom } from "../../atoms/actions";
import InputArea from "../input/InputArea";
import DragDropWrapper from "../input/DragDropWrapper";
import PopupOverlayContainer from "../PopupOverlayContainer";
import FileStatusBar from "../status/FileStatusBar";
import { threadWarningsAtom } from "../../atoms/warnings";
import { libraryHasItemsAtom } from "../../atoms/zoteroContext";

interface HomePageProps {
    isWindow?: boolean;
    inputRef: React.RefObject<HTMLElement | null>;
}

const HomePage: React.FC<HomePageProps> = ({ isWindow = false, inputRef }) => {
    const isDatabaseSyncSupported = useAtomValue(isDatabaseSyncSupportedAtom);
    const actions = useAtomValue(actionsForContextAtom);
    const allWarnings = useAtomValue(threadWarningsAtom);
    const hasCreditInfoWarning = allWarnings.some((w) => w.type === 'credit_info');
    // All current global/context actions assume the library has items, so they
    // are hidden when the probe has confirmed an empty library. `null` (probe
    // still pending) keeps actions visible to avoid a brief flicker on launch.
    const libraryHasItems = useAtomValue(libraryHasItemsAtom);
    const showActions = libraryHasItems !== false && actions.length > 0;

    // Beta versions use a pre-release tag (e.g. "0.20.0-beta.1")
    const isBeta = /-beta\.\d+$/.test(Zotero.Beaver?.pluginVersion ?? "");

    return (
        <div
            id="welcome-page"
            className="display-flex flex-col flex-1 min-h-0"
        >
            {/* Scrollable top section */}
            <div className="display-flex flex-col flex-1 overflow-y-auto scrollbar px-3 pt-4 gap-4">
                {/* Top spacer */}
                <div className="flex-1" style={{ minHeight: '2vh', maxHeight: '4vh' }} />

                {/* Greeting */}
                <div className="text-2xl font-semibold text-center p-2">How can I help you?</div>

                {/* Input area */}
                <DragDropWrapper>
                    <InputArea inputRef={inputRef} verticalPosition="below" />
                </DragDropWrapper>

                {/* Action suggestions */}
                {showActions && (
                    <ActionSuggestions showGlobal={false} />
                )}

                {/* Bottom spacer */}
                <div className="flex-1" />
            </div>

            {/* Fixed bottom section */}
            <div
                id="beaver-home-footer"
                className="flex-none px-25"
            >
                <RecentChats />

                {isDatabaseSyncSupported && !isWindow && !hasCreditInfoWarning && (
                    <FileStatusBar />
                )}

                <div className="relative -mx-4 px-4 mb-3">
                    <PopupOverlayContainer />
                </div>

                {isBeta && (
                    <div className="text-sm font-color-secondary mb-2 bg-quinary p-2 rounded-md">
                        You're using a beta version. Please report any issues to{" "}
                        <a href="mailto:contact@beaverapp.ai">contact@beaverapp.ai</a>.
                    </div>
                )}
            </div>
        </div>
    );
};

export default HomePage;
