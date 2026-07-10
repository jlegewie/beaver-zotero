import React, { useCallback, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAtomValue } from 'jotai';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
    LexicalTypeaheadMenuPlugin,
    MenuOption,
    useBasicTypeaheadTriggerMatch,
} from '@lexical/react/LexicalTypeaheadMenuPlugin';
import {
    $createTextNode,
    $getSelection,
    $isRangeSelection,
    TextNode,
} from 'lexical';
import { actionsAtom } from '../../../atoms/actions';
import { Action } from '../../../types/actions';
import { $createSlashCommandNode } from './SlashCommandNode';
import { truncateText } from '../../../utils/stringUtils';

const MAX_RESULTS = 8;

class SlashOption extends MenuOption {
    action: Action;
    constructor(action: Action) {
        super(action.id);
        this.action = action;
    }
}

// Normalize a title into a stable slash-command token (e.g. "Summarize Paper" -> "summarize-paper")
const toSlug = (s: string) =>
    s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');

/**
 * /-trigger plugin.
 *
 * Reads the available actions from `actionsAtom` (source of truth for the
 * existing slash menu), filters by the typed query, and on select inserts
 * a SlashCommandNode pill rendered with a background color. Pill data is
 * intentionally limited to the command's visual token - it does NOT resolve
 * prompt variables or trigger the action yet.
 */
export const SlashCommandsPlugin: React.FC<{
    anchorElement?: HTMLElement | null;
}> = ({ anchorElement }) => {
    const [editor] = useLexicalComposerContext();
    const actions = useAtomValue(actionsAtom);
    const [queryString, setQueryString] = useState<string | null>(null);

    const triggerFn = useBasicTypeaheadTriggerMatch('/', {
        minLength: 0,
        allowWhitespace: false,
    });

    const options = useMemo(() => {
        const q = (queryString ?? '').toLowerCase();
        const filtered = q
            ? actions.filter((a) => a.title.toLowerCase().includes(q))
            : actions;
        return filtered
            .slice(0, MAX_RESULTS)
            .map((a) => new SlashOption(a));
    }, [actions, queryString]);

    const onSelectOption = useCallback(
        (
            selectedOption: SlashOption,
            nodeToReplace: TextNode | null,
            closeMenu: () => void,
        ) => {
            editor.update(() => {
                const name = toSlug(selectedOption.action.title) || 'action';
                const slashNode = $createSlashCommandNode(name);
                if (nodeToReplace) {
                    nodeToReplace.replace(slashNode);
                } else {
                    const sel = $getSelection();
                    if ($isRangeSelection(sel)) sel.insertNodes([slashNode]);
                }
                const spaceNode = $createTextNode(' ');
                slashNode.insertAfter(spaceNode);
                spaceNode.selectEnd();
                closeMenu();
            });
        },
        [editor],
    );

    return (
        <LexicalTypeaheadMenuPlugin<SlashOption>
            onQueryChange={setQueryString}
            onSelectOption={onSelectOption}
            triggerFn={triggerFn}
            options={options}
            parent={anchorElement ?? undefined}
            menuRenderFn={(anchorRef, { selectedIndex, selectOptionAndCleanUp, setHighlightedIndex }) => {
                if (anchorRef.current == null || options.length === 0) return null;
                return createPortal(
                    <div
                        className="bg-quaternary border-popup rounded-md outline-none z-1000 shadow-md display-flex flex-col"
                        style={{ width: '260px', maxHeight: '40vh', overflow: 'hidden' }}
                        role="listbox"
                    >
                        <div className="overflow-y-auto overflow-x-hidden scrollbar flex-1">
                            {options.map((option, i) => (
                                <div
                                    key={option.key}
                                    role="option"
                                    aria-selected={selectedIndex === i}
                                    tabIndex={-1}
                                    ref={(el) => option.setRefElement(el)}
                                    className={`display-flex items-center gap-2 px-2 py-15 cursor-pointer user-select-none ${
                                        selectedIndex === i ? 'bg-quinary' : ''
                                    }`}
                                    onMouseEnter={() => setHighlightedIndex(i)}
                                    onMouseDown={(e) => {
                                        e.preventDefault();
                                        selectOptionAndCleanUp(option);
                                    }}
                                >
                                    <span className="flex-1 text-sm font-color-secondary truncate">
                                        {truncateText(option.action.title, 40)}
                                    </span>
                                </div>
                            ))}
                        </div>
                    </div>,
                    anchorRef.current,
                );
            }}
        />
    );
};
