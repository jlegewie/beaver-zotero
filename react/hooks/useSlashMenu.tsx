import React, { useState, useRef, useCallback, useMemo } from 'react';
import { useAtom, useSetAtom, useAtomValue } from 'jotai';
import { PlusSignIcon, BookSearchIcon, LayersIcon, HighlighterIcon, ZapIcon } from '../components/icons/icons';
import { CSSIcon, CSSItemTypeIcon } from '../components/icons/zotero';
import { currentMessageContentAtom } from '../atoms/messageComposition';
import { actionsAtom, actionContextAtom, markActionUsedAtom } from '../atoms/actions';
import { computeActionGroups } from '../utils/actionVisibility';
import { openPreferencesWindow } from '../../src/ui/openPreferencesWindow';
import { Action, ActionCategory, ActionTargetType } from '../types/actions';
import { SlashCommandDescriptor, getActionCommand } from '../utils/slashCommands';
import { MenuPosition, SearchMenuItem } from '../components/ui/menus/SearchMenu';

// Category icons mirror the homepage launcher and Actions preferences so the
// slash menu matches what users see elsewhere. Uncategorized actions fall
// back to the general "Actions" icon (Zap).
const CATEGORY_ICONS: Record<ActionCategory, React.ComponentType<React.SVGProps<SVGSVGElement>>> = {
    research: BookSearchIcon,
    organize: LayersIcon,
    annotate: HighlighterIcon,
};
const categoryIcon = (cat: ActionCategory | undefined): React.ComponentType<React.SVGProps<SVGSVGElement>> =>
    cat ? CATEGORY_ICONS[cat] : ZapIcon;

export function useSlashMenu(
    inputRef: React.RefObject<HTMLElement | null>,
    verticalPosition: 'above' | 'below' = 'above',
    focusInput?: () => void,
    insertSlashCommand?: (descriptor: SlashCommandDescriptor, queryLength: number) => void,
    /** Where to write the editor content the menu logic consumed. Defaults to
     *  the shared compose atom; pass a local setter when the menu drives an
     *  editor that is not the main chat input (e.g. the message edit overlay). */
    setContent?: (value: string) => void,
) {
    const [, setComposeMessageContent] = useAtom(currentMessageContentAtom);
    const setMessageContent = setContent ?? setComposeMessageContent;
    const allActions = useAtomValue(actionsAtom);
    const ctx = useAtomValue(actionContextAtom);
    const markActionUsed = useSetAtom(markActionUsedAtom);

    const [isSlashMenuOpen, setIsSlashMenuOpen] = useState(false);
    const [slashMenuPosition, setSlashMenuPosition] = useState<MenuPosition>({ x: 0, y: 0 });
    const [slashSearchQuery, setSlashSearchQuery] = useState('');
    const preSlashTextRef = useRef('');
    // Live mirror of the typed query so handleSlashSelect can compute how much
    // trailing "/query" text to replace, even when the editor lost DOM focus to
    // the menu (e.g. selecting with the mouse).
    const slashQueryRef = useRef('');

    // Selecting an action completes the typed "/query" into a styled command pill
    const handleSlashSelect = useCallback((action: Action, groupTargetType?: ActionTargetType) => {
        const queryLength = slashQueryRef.current.length;
        setIsSlashMenuOpen(false);
        setSlashSearchQuery('');
        slashQueryRef.current = '';

        insertSlashCommand?.(
            {
                commandName: getActionCommand(action),
                actionId: action.id,
                targetType: groupTargetType,
                title: action.title,
                argumentHint: action.argumentHint,
            },
            queryLength,
        );
        markActionUsed(action.id);
        setTimeout(() => focusInput ? focusInput() : inputRef.current?.focus(), 0);
    }, [focusInput, inputRef, insertSlashCommand, markActionUsed]);

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

        // The typed query matches against both the action title and its
        // /command name (what the pill will actually insert).
        const queryPosition = (a: Action): number => {
            const inTitle = a.title.toLowerCase().indexOf(query);
            const inCommand = getActionCommand(a).toLowerCase().indexOf(query);
            if (inTitle === -1) return inCommand;
            if (inCommand === -1) return inTitle;
            return Math.min(inTitle, inCommand);
        };

        const sortByRelevance = (actions: Action[]): Action[] => {
            return [...actions].sort((a, b) => {
                if (query) {
                    const posA = queryPosition(a);
                    const posB = queryPosition(b);
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
                        ? g.actions.filter(a => queryPosition(a) !== -1)
                        : g.actions
                ),
            }))
            .filter(g => g.filtered.length > 0);

        const globalFirstGroups = [...visibleGroups].sort((a, b) => {
            if (a.id === 'global' && b.id !== 'global') return -1;
            if (a.id !== 'global' && b.id === 'global') return 1;
            return 0;
        });

        // Always show headers when there are context-specific groups (non-global).
        // General actions are intentionally unheaded so they sit directly at the
        // top of the slash menu before any context-specific sections.
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
                        <span className="scale-80 flex-shrink-0">
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
            //   - Groups: general actions first visually, context groups after
            //   - Within each group: actions first, then header
            //     (after reverse: header above its actions)
            //   - Create Action last (ends up at top after reverse)
            for (const group of [...globalFirstGroups].reverse()) {
                for (const action of group.filtered) {
                    items.push({
                        label: action.title,
                        icon: categoryIcon(action.category),
                        onClick: () => handleSlashSelect(action, group.targetType),
                    });
                }
                if (showHeaders && group.id !== 'global' && group.label !== lastHeader) {
                    items.push(buildHeaderItem(group));
                    lastHeader = group.label;
                }
            }
        } else {
            // For "below" mode, SearchMenu does NOT reverse.
            // Build in normal visual order (top-to-bottom):
            //   - Groups: general actions first, context groups after
            //   - Within each group: header first, then actions
            //   - Create Action last (at bottom)
            for (const group of globalFirstGroups) {
                if (showHeaders && group.id !== 'global' && group.label !== lastHeader) {
                    items.push(buildHeaderItem(group));
                    lastHeader = group.label;
                }
                for (const action of group.filtered) {
                    items.push({
                        label: action.title,
                        icon: categoryIcon(action.category),
                        onClick: () => handleSlashSelect(action, group.targetType),
                    });
                }
            }
        }

        // Create Action at end of array (top after reverse for "above", bottom for "below")
        if (!query || items.length === 0) {
            if (items.length > 0) {
                items.push({ label: '', isDivider: true, onClick: () => {} });
            }
            items.push(createActionItem);
        }

        return items;
    }, [allActions, ctx, slashSearchQuery, handleSlashSelect, verticalPosition]);

    /** Handle onChange for the textarea when the slash menu is open. Returns true if handled. */
    const handleSlashMenuChange = useCallback((value: string): boolean => {
        if (isSlashMenuOpen) {
            const prefix = preSlashTextRef.current + '/';
            if (value.startsWith(prefix)) {
                const query = value.slice(prefix.length);
                slashQueryRef.current = query;
                setSlashSearchQuery(query);
                setMessageContent(value);
            } else {
                slashQueryRef.current = '';
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
                slashQueryRef.current = '';
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

    /** Handle keydown when the slash menu is open. Returns true if the event was consumed.
     *  preventDefault (never stopPropagation!) - the event must keep bubbling to
     *  SearchMenu's document-level listener, which performs the actual
     *  navigation/selection. Tab selects like Enter (see SearchMenu selectOnTab). */
    const handleSlashMenuKeyDown = useCallback((e: React.KeyboardEvent<HTMLElement>): boolean => {
        if (!isSlashMenuOpen) return false;
        if (e.key === 'Enter' || e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Tab') {
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
