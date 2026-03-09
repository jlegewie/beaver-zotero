import { useState, useRef, useCallback, useMemo } from 'react';
import { useAtom, useSetAtom, useAtomValue } from 'jotai';
import { PlusSignIcon } from '../components/icons/icons';
import { currentMessageContentAtom, currentMessageItemsAtom } from '../atoms/messageComposition';
import { isWSChatPendingAtom } from '../atoms/agentRunAtoms';
import { actionsAtom, actionContextAtom, markActionUsedAtom, sendResolvedActionAtom } from '../atoms/actions';
import { resolvePromptVariables, EMPTY_VARIABLE_HINTS } from '../utils/promptVariables';
import { computeActionGroups } from '../utils/actionVisibility';
import { addPopupMessageAtom } from '../utils/popupMessageUtils';
import { openPreferencesWindow } from '../../src/ui/openPreferencesWindow';
import { Action, ActionTargetType } from '../types/actions';
import { MenuPosition, SearchMenuItem } from '../components/ui/menus/SearchMenu';

export function useSlashMenu(inputRef: React.RefObject<HTMLTextAreaElement | null>) {
    const [messageContent, setMessageContent] = useAtom(currentMessageContentAtom);
    const [, setCurrentMessageItems] = useAtom(currentMessageItemsAtom);
    const isPending = useAtomValue(isWSChatPendingAtom);
    const allActions = useAtomValue(actionsAtom);
    const ctx = useAtomValue(actionContextAtom);
    const markActionUsed = useSetAtom(markActionUsedAtom);
    const sendResolvedAction = useSetAtom(sendResolvedActionAtom);
    const addPopupMessage = useSetAtom(addPopupMessageAtom);

    const [isSlashMenuOpen, setIsSlashMenuOpen] = useState(false);
    const [slashMenuPosition, setSlashMenuPosition] = useState<MenuPosition>({ x: 0, y: 0 });
    const [slashSearchQuery, setSlashSearchQuery] = useState('');
    const preSlashTextRef = useRef('');

    const handleSlashSelect = useCallback(async (action: Action, groupTargetType?: ActionTargetType) => {
        const pre = preSlashTextRef.current;
        const fullPromptText = pre.length > 0
            ? `${pre}\n\n${action.text}`.trim()
            : action.text.trim();
        setIsSlashMenuOpen(false);
        setSlashSearchQuery('');

        if (isPending) {
            const { text: resolvedText, items, emptyItemVariables } = await resolvePromptVariables(fullPromptText, groupTargetType);
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
            sendResolvedAction({ text: fullPromptText, targetType: groupTargetType });
        }
        setTimeout(() => inputRef.current?.focus(), 0);
    }, [isPending, sendResolvedAction, markActionUsed]);

    const handleSlashDismiss = useCallback(() => {
        setIsSlashMenuOpen(false);
        setSlashSearchQuery('');
    }, []);

    const slashMenuItems = useMemo<SearchMenuItem[]>(() => {
        const query = slashSearchQuery.toLowerCase();
        const groups = computeActionGroups(allActions, ctx);

        // "Create Action" footer
        const createActionItem: SearchMenuItem = {
            label: 'Create Action',
            icon: PlusSignIcon,
            onClick: () => {
                setIsSlashMenuOpen(false);
                setSlashSearchQuery('');
                openPreferencesWindow('prompts');
            },
        };

        const sortByRelevance = (actions: Action[]): Action[] => {
            return [...actions].sort((a, b) => {
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
            });
        };

        // Filter each group's actions by query, sort, and drop empty groups
        const visibleGroups = groups
            .map(g => ({
                ...g,
                filtered: sortByRelevance(
                    query
                        ? g.actions.filter(a => a.title.toLowerCase().includes(query))
                        : g.actions
                ),
            }))
            .filter(g => g.filtered.length > 0);

        // Always show headers when there are context-specific groups (non-global)
        const hasContextGroup = visibleGroups.some(g => g.id !== 'global');
        const showHeaders = hasContextGroup;

        // The slash menu uses verticalPosition="above", so SearchMenu reverses
        // the array for display. We build in reverse visual order:
        //   - Groups: most relevant first (ends up at bottom after reverse)
        //   - Within each group: sorted actions first, then header
        //     (after reverse: header above its actions)
        //   - Create Action last (ends up at top after reverse)
        const items: SearchMenuItem[] = [];

        let lastHeader: string | null = null;
        for (const group of visibleGroups) {
            // Actions first (sorted best-first; after reverse they appear
            // below header with best at bottom, closest to cursor)
            for (const action of group.filtered) {
                items.push({
                    label: action.title,
                    onClick: () => handleSlashSelect(action, group.targetType),
                });
            }
            // Header after actions (after reverse, header appears above actions)
            if (showHeaders && group.label !== lastHeader) {
                items.push({ label: group.label, onClick: () => {}, isGroupHeader: true });
                lastHeader = group.label;
            }
        }

        // Create Action at end of array → top of visual menu after reverse
        if (!query || items.length === 0) {
            items.push(createActionItem);
        }

        return items;
    }, [allActions, ctx, slashSearchQuery, handleSlashSelect]);

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
