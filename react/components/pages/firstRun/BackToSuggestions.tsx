import React, { useEffect, useRef } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { firstRunReturnRequestedAtom } from '../../../atoms/firstRun';
import { currentMessageContentAtom } from '../../../atoms/messageComposition';
import { Icon, IdeaIcon, PlusSignIcon } from '../../icons/icons';
import ArrowLeftIcon from '../../icons/ArrowLeftIcon';
import Button from '../../ui/Button';


interface BackToSuggestionsProps {
    onDismiss: () => void;
}

/**
 * Rendered once below the first agent run that originated from a
 * first-run suggestion card (matched by run id). "Back to suggestions"
 * re-renders the FirstRunPage from the persisted
 * `profile.library_suggestions` (no regeneration, no second `complete`
 * call).
 *
 * Auto-dismisses when:
 *   - the back link is clicked
 *   - the user types in the input (follow-up path)
 *   - parent stops rendering it (origin run id changes / new run starts)
 */
const BackToSuggestions: React.FC<BackToSuggestionsProps> = ({ onDismiss }) => {
    const setReturnRequested = useSetAtom(firstRunReturnRequestedAtom);
    const messageContent = useAtomValue(currentMessageContentAtom);

    // Auto-dismiss when the user types a follow-up. Capture the initial value
    // so we don't dismiss on the first render if the input is already non-empty
    // (rare but possible if state leaks across re-mounts).
    const initialContentRef = useRef<string>(messageContent);
    useEffect(() => {
        if (messageContent && messageContent !== initialContentRef.current) {
            onDismiss();
        }
    }, [messageContent, onDismiss]);

    const newChatShortcut = Zotero.isMac ? '⌘N' : 'Ctrl+N';

    const handleTryAnother = () => {
        setReturnRequested(true);
        onDismiss();
    };

    return (
        <div className="display-flex flex-col gap-1 items-start mt-3">
            <Button
                variant="ghost"
                icon={ArrowLeftIcon}
                className="-mr-1"
                iconClassName="-mr-1"
                style={{fontSize: '1rem', paddingLeft: '0px'}}
                onClick={handleTryAnother}
            >
                Back to suggestions
            </Button>
            <div
                className="display-flex flex-row items-center gap-1 ml-1 text-start font-color-secondary"
                style={{fontSize: '0.875rem'}}
            >
                <Icon icon={IdeaIcon} size={10}/>
                <span>
                    Start a new chat anytime with
                </span>
                <Icon icon={PlusSignIcon} size={10}/>
                <span>
                    (top left) or with
                </span>
                <span
                    style={{
                        background: 'var(--fill-quinary)',
                        padding: '1px 3px',
                        borderRadius: '3px',
                        fontSize: '0.8em',
                    }}
                >
                    {newChatShortcut}
                </span>
            </div>
        </div>
    );
};

export default BackToSuggestions;
