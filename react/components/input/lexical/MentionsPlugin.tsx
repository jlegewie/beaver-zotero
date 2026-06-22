import React, {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import { createPortal } from 'react-dom';
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
import { $createMentionNode } from './MentionNode';
import { searchTitleCreatorYear } from '../../../utils/search';
import { getDisplayNameFromItem } from '../../../utils/sourceUtils';
import { truncateText } from '../../../utils/stringUtils';
import { CSSItemTypeIcon } from '../../icons/icons';

const MAX_RESULTS = 8;

class MentionOption extends MenuOption {
    item: Zotero.Item;
    constructor(item: Zotero.Item) {
        super(`${item.libraryID}-${item.key}`);
        this.item = item;
    }
}

/**
 * @-trigger plugin.
 *
 * Debounced Zotero search (title / creator / year) populates a floating menu
 * styled to match the rest of the app. On select, a MentionNode (decorator)
 * is inserted in place of the `@query` text match.
 *
 * Deliberately NOT connected to the existing atom-based attachment flow -
 * the item reference lives only in the editor state for now.
 */
export const MentionsPlugin: React.FC<{
    anchorElement?: HTMLElement | null;
}> = ({ anchorElement }) => {
    const [editor] = useLexicalComposerContext();
    const [queryString, setQueryString] = useState<string | null>(null);
    const [results, setResults] = useState<Zotero.Item[]>([]);
    const searchSeq = useRef(0);

    const triggerFn = useBasicTypeaheadTriggerMatch('@', {
        minLength: 0,
        allowWhitespace: true,
    });

    // Debounced async search
    useEffect(() => {
        if (queryString == null) {
            setResults([]);
            return;
        }
        const q = queryString.trim();
        if (q.length < 1) {
            setResults([]);
            return;
        }
        const seq = ++searchSeq.current;
        const t = setTimeout(async () => {
            try {
                const items = await searchTitleCreatorYear(q);
                if (seq !== searchSeq.current) return;
                setResults(items.slice(0, MAX_RESULTS));
            } catch {
                if (seq !== searchSeq.current) return;
                setResults([]);
            }
        }, 120);
        return () => clearTimeout(t);
    }, [queryString]);

    const options = useMemo(
        () => results.map((item) => new MentionOption(item)),
        [results],
    );

    const onSelectOption = useCallback(
        (
            selectedOption: MentionOption,
            nodeToReplace: TextNode | null,
            closeMenu: () => void,
        ) => {
            editor.update(() => {
                const mentionNode = $createMentionNode(
                    selectedOption.item.libraryID,
                    selectedOption.item.key,
                );
                if (nodeToReplace) {
                    nodeToReplace.replace(mentionNode);
                } else {
                    const sel = $getSelection();
                    if ($isRangeSelection(sel)) sel.insertNodes([mentionNode]);
                }
                // Insert a trailing space and place the cursor after it so
                // the user can keep typing.
                const spaceNode = $createTextNode(' ');
                mentionNode.insertAfter(spaceNode);
                spaceNode.selectEnd();
                closeMenu();
            });
        },
        [editor],
    );

    return (
        <LexicalTypeaheadMenuPlugin<MentionOption>
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
                        style={{ width: '280px', maxHeight: '40vh', overflow: 'hidden' }}
                        role="listbox"
                    >
                        <div className="overflow-y-auto overflow-x-hidden scrollbar flex-1">
                            {options.map((option, i) => {
                                const item = option.item;
                                let iconName: string | null = null;
                                try {
                                    iconName = item.getItemTypeIconName();
                                } catch {
                                    /* ignore */
                                }
                                const label = item.isRegularItem()
                                    ? truncateText(getDisplayNameFromItem(item), 48)
                                    : truncateText(item.getDisplayTitle(), 48);
                                return (
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
                                        {iconName ? (
                                            <span className="scale-80 flex-shrink-0">
                                                <CSSItemTypeIcon itemType={iconName} />
                                            </span>
                                        ) : null}
                                        <span className="flex-1 text-sm font-color-secondary truncate">
                                            {label}
                                        </span>
                                    </div>
                                );
                            })}
                        </div>
                    </div>,
                    anchorRef.current,
                );
            }}
        />
    );
};
