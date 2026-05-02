import React, { useState, useRef, useCallback, useMemo } from 'react';
import { useAtom, useSetAtom, useAtomValue } from 'jotai';
import { PlusSignIcon } from '../components/icons/icons';
import { CSSIcon, CSSItemTypeIcon } from '../components/icons/zotero';
import { currentMessageContentAtom, currentMessageItemsAtom } from '../atoms/messageComposition';
import { isWSChatPendingAtom } from '../atoms/agentRunAtoms';
import { actionsAtom, actionContextAtom, markActionUsedAtom, sendResolvedActionAtom, stageActionInInputAtom } from '../atoms/actions';
import { resolvePromptVariables, EMPTY_VARIABLE_HINTS } from '../utils/promptVariables';
import { hasUserInputVariables } from '../utils/userInputVariables';
import { computeActionGroups, GroupIconInfo } from '../utils/actionVisibility';
import { addPopupMessageAtom } from '../utils/popupMessageUtils';
import { openPreferencesWindow } from '../../src/ui/openPreferencesWindow';
import { Action, ActionTargetType } from '../types/actions';
import { MenuPosition, SearchMenuItem } from '../components/ui/menus/SearchMenu';

export function useSlashMenu(inputRef: React.RefObject<HTMLTextAreaElement | null>, verticalPosition: 'above' | 'below' = 'above') {
    const [messageContent, setMessageContent] = useAtom(currentMessageContentAtom);
    const [, setCurrentMessageItems] = useAtom(currentMessageItemsAtom);
    const isPending = useAtomValue(isWSChatPendingAtom);
    const allActions = useAtomValue(actionsAtom);
    const ctx = useAtomValue(actionContextAtom);
    const markActionUsed = useSetAtom(markActionUsedAtom);
    const sendResolvedAction = useSetAtom(sendResolvedActionAtom);
    const stageActionInInput = useSetAtom(stageActionInInputAtom);
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

        if (hasUserInputVariables(action.text)) {
            await stageActionInInput({
                actionId: action.id,
                text: action.text,
                targetType: groupTargetType,
                pretext: pre,
            });
            setTimeout(() => inputRef.current?.focus(), 0);
            return;
        }

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
    }, [isPending, sendResolvedAction, stageActionInInput, markActionUsed]);

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
                openPreferencesWindow('actions');
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

        const items: SearchMenuItem[] = [];
        let lastHeader: string | null = null;

        const buildHeaderItem = (group: typeof visibleGroups[0]): SearchMenuItem => {
            const headerItem: SearchMenuItem = {
                label: group.label,
                onClick: () => {},
                isGroupHeader: true,
            };
            if (group.iconInfo) {
                headerItem.customContent = (
                    <span className="display-flex items-center gap-1 truncate">
                        <span className="scale-80 flex-shrink-0 opacity-50" style={{ filter: 'grayscale(1)' }}>
                            {group.iconInfo.type === 'item-type'
                                ? <CSSItemTypeIcon itemType={group.iconInfo.name} className="icon-16" />
                                : <CSSIcon name={group.iconInfo.name} className="icon-16" />}
                        </span>
                        <span className="truncate">{group.label}</span>
                    </span>
                );
            }
            return headerItem;
        };

        if (verticalPosition === 'above') {
            // For "above" mode, SearchMenu reverses the array for display.
            // Build in reverse visual order:
            //   - Groups: most relevant first (ends up at bottom after reverse)
            //   - Within each group: actions first, then header
            //     (after reverse: header above its actions)
            //   - Create Action last (ends up at top after reverse)
            for (const group of visibleGroups) {
                for (const action of group.filtered) {
                    items.push({
                        label: action.title,
                        onClick: () => handleSlashSelect(action, group.targetType),
                    });
                }
                if (showHeaders && group.label !== lastHeader) {
                    items.push(buildHeaderItem(group));
                    lastHeader = group.label;
                }
            }
        } else {
            // For "below" mode, SearchMenu does NOT reverse.
            // Build in normal visual order (top-to-bottom):
            //   - Groups: most relevant first (at top, closest to cursor)
            //   - Within each group: header first, then actions
            //   - Create Action last (at bottom)
            for (const group of visibleGroups) {
                if (showHeaders && group.label !== lastHeader) {
                    items.push(buildHeaderItem(group));
                    lastHeader = group.label;
                }
                for (const action of group.filtered) {
                    items.push({
                        label: action.title,
                        onClick: () => handleSlashSelect(action, group.targetType),
                    });
                }
            }
        }

        // Create Action at end of array (top after reverse for "above", bottom for "below")
        if (!query || items.length === 0) {
            items.push(createActionItem);
        }

        return items;
    }, [allActions, ctx, slashSearchQuery, handleSlashSelect, verticalPosition]);

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
                const y = verticalPosition === 'above' ? rect.top - 5 : rect.bottom - 10;
                setSlashMenuPosition({ x: rect.left, y });
                setIsSlashMenuOpen(true);
                setSlashSearchQuery('');
                setMessageContent(value);
                return true;
            }
        }
        return false;
    }, [setMessageContent, verticalPosition]);

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
