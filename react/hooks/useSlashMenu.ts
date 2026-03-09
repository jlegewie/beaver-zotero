import { useState, useRef, useCallback, useMemo } from 'react';
import { useAtom, useSetAtom, useAtomValue } from 'jotai';
import { PlusSignIcon } from '../components/icons/icons';
import { currentMessageContentAtom, currentMessageItemsAtom } from '../atoms/messageComposition';
import { isWSChatPendingAtom } from '../atoms/agentRunAtoms';
import { actionsAtom, actionsForContextAtom, markActionUsedAtom, sendResolvedActionAtom } from '../atoms/actions';
import { resolvePromptVariables, EMPTY_VARIABLE_HINTS } from '../utils/promptVariables';
import { addPopupMessageAtom } from '../utils/popupMessageUtils';
import { openPreferencesWindow } from '../../src/ui/openPreferencesWindow';
import { Action } from '../types/actions';
import { MenuPosition, SearchMenuItem } from '../components/ui/menus/SearchMenu';

export function useSlashMenu(inputRef: React.RefObject<HTMLTextAreaElement | null>) {
    const [messageContent, setMessageContent] = useAtom(currentMessageContentAtom);
    const [, setCurrentMessageItems] = useAtom(currentMessageItemsAtom);
    const isPending = useAtomValue(isWSChatPendingAtom);
    const allActions = useAtomValue(actionsAtom);
    const contextActions = useAtomValue(actionsForContextAtom);
    const markActionUsed = useSetAtom(markActionUsedAtom);
    const sendResolvedAction = useSetAtom(sendResolvedActionAtom);
    const addPopupMessage = useSetAtom(addPopupMessageAtom);

    const [isSlashMenuOpen, setIsSlashMenuOpen] = useState(false);
    const [slashMenuPosition, setSlashMenuPosition] = useState<MenuPosition>({ x: 0, y: 0 });
    const [slashSearchQuery, setSlashSearchQuery] = useState('');
    const preSlashTextRef = useRef('');

    // Set of action IDs visible for current context (used for enabled/disabled split)
    const contextActionIds = useMemo(() => new Set(contextActions.map(a => a.id)), [contextActions]);

    const handleSlashSelect = useCallback(async (action: Action) => {
        const pre = preSlashTextRef.current;
        const fullPromptText = pre.length > 0
            ? `${pre}\n\n${action.text}`.trim()
            : action.text.trim();
        setIsSlashMenuOpen(false);
        setSlashSearchQuery('');

        if (isPending) {
            const { text: resolvedText, items, emptyItemVariables } = await resolvePromptVariables(fullPromptText, action.targetType);
            if (emptyItemVariables.length > 0) {
                addPopupMessage({ type: 'warning', title: 'Action skipped', text: EMPTY_VARIABLE_HINTS[emptyItemVariables[0]] ?? 'No items found for this prompt.', expire: true, duration: 4000 });
                setTimeout(() => inputRef.current?.focus(), 0);
                return;
            }
            setMessageContent(resolvedText);
            if (items.length > 0) {
                setCurrentMessageItems(prev => {
                    const existingKeys = new Set(prev.map(item => `${item.libraryID}-${item.key}`));
                    const newItems = items.filter(item => !existingKeys.has(`${item.libraryID}-${item.key}`));
                    return newItems.length > 0 ? [...prev, ...newItems] : prev;
                });
            }
            markActionUsed(action.id);
        } else {
            setMessageContent('');
            markActionUsed(action.id);
            sendResolvedAction({ text: fullPromptText, targetType: action.targetType });
        }
        setTimeout(() => inputRef.current?.focus(), 0);
    }, [isPending, sendResolvedAction, markActionUsed]);

    const handleSlashDismiss = useCallback(() => {
        setIsSlashMenuOpen(false);
        setSlashSearchQuery('');
    }, []);

    const slashMenuItems = useMemo<SearchMenuItem[]>(() => {
        const query = slashSearchQuery.toLowerCase();
        const items: SearchMenuItem[] = [];

        const filtered = allActions.filter(action =>
            !query || action.title.toLowerCase().includes(query)
        );

        // "Create Action" footer (visually at bottom)
        const createActionItem: SearchMenuItem[] = !query || filtered.length === 0
            ? [{
                label: 'Create Action',
                icon: PlusSignIcon,
                onClick: () => {
                    setIsSlashMenuOpen(false);
                    setSlashSearchQuery('');
                    openPreferencesWindow('prompts');
                },
            }] : [];

        const enabled = filtered.filter(a => contextActionIds.has(a.id));
        const disabled = filtered.filter(a => !contextActionIds.has(a.id));

        const sortByRelevance = (a: Action, b: Action): number => {
            if (query) {
                const posA = a.title.toLowerCase().indexOf(query);
                const posB = b.title.toLowerCase().indexOf(query);
                if (posA !== posB) return posA - posB;
            }
            if (a.lastUsed && !b.lastUsed) return -1;
            if (!a.lastUsed && b.lastUsed) return 1;
            if (a.lastUsed && b.lastUsed) {
                const diff = new Date(b.lastUsed).getTime() - new Date(a.lastUsed).getTime();
                if (diff !== 0) return diff;
            }
            return (a.sortOrder ?? 999) - (b.sortOrder ?? 999);
        };
        enabled.sort(sortByRelevance);
        disabled.sort(sortByRelevance);

        // Disabled items go first in array (visually at bottom after reverse)
        for (let i = disabled.length - 1; i >= 0; i--) {
            items.push({
                label: disabled[i].title,
                onClick: () => handleSlashSelect(disabled[i]),
                disabled: true,
            });
        }
        // Enabled items go after (visually above disabled after reverse)
        for (let i = enabled.length - 1; i >= 0; i--) {
            items.push({
                label: enabled[i].title,
                onClick: () => handleSlashSelect(enabled[i]),
            });
        }

        return [...items.reverse(), ...createActionItem];
    }, [allActions, contextActionIds, slashSearchQuery, handleSlashSelect]);

    /** Handle onChange for the textarea when the slash menu is open. Returns true if handled. */
    const handleSlashMenuChange = useCallback((value: string): boolean => {
        if (isSlashMenuOpen) {
            const prefix = preSlashTextRef.current + '/';
            if (value.startsWith(prefix)) {
                setSlashSearchQuery(value.slice(prefix.length));
                setMessageContent(value);
            } else {
                setIsSlashMenuOpen(false);
                setSlashSearchQuery('');
                setMessageContent(value);
            }
            return true;
        }
        return false;
    }, [isSlashMenuOpen, setMessageContent]);

    /** Detect `/` trigger in onChange. Returns true if the slash menu was opened. */
    const handleSlashTrigger = useCallback((value: string, rect: DOMRect): boolean => {
        if (value.endsWith('/')) {
            const charBefore = value.length > 1 ? value[value.length - 2] : null;
            if (charBefore === null || charBefore === ' ' || charBefore === '\n') {
                preSlashTextRef.current = value.slice(0, -1);
                setSlashMenuPosition({ x: rect.left, y: rect.top - 5 });
                setIsSlashMenuOpen(true);
                setSlashSearchQuery('');
                setMessageContent(value);
                return true;
            }
        }
        return false;
    }, [setMessageContent]);

    /** Handle keydown when the slash menu is open. Returns true if the event was consumed. */
    const handleSlashMenuKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
        if (!isSlashMenuOpen) return false;
        if (e.key === 'Enter' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            return true;
        }
        if (e.key === 'Escape' || e.key === ' ') {
            e.preventDefault();
            setIsSlashMenuOpen(false);
            setSlashSearchQuery('');
            return true;
        }
        return false;
    }, [isSlashMenuOpen]);

    return {
        isSlashMenuOpen,
        slashMenuPosition,
        slashSearchQuery,
        setSlashSearchQuery,
        slashMenuItems,
        handleSlashSelect,
        handleSlashDismiss,
        handleSlashMenuChange,
        handleSlashTrigger,
        handleSlashMenuKeyDown,
    };
}
