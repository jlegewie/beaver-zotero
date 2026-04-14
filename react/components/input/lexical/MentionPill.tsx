import React, { useEffect, useState } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getNodeByKey, NodeKey } from 'lexical';
import { CSSItemTypeIcon, CSSIcon } from '../../icons/icons';
import { truncateText } from '../../../utils/stringUtils';
import { getDisplayNameFromItem } from '../../../utils/sourceUtils';
import { $isMentionNode } from './MentionNode';

const MAX_ITEM_TEXT_LENGTH = 30;

/**
 * Visual for a MentionNode.
 *
 * Styled to match MessageItemButton (same `source-button` class), so pills
 * feel at home with the attachment row above the editor. Kept intentionally
 * thin: no hover preview, no validation, no atom wiring. Those can be layered
 * on later when mentions are integrated with the attachment system.
 */
export const MentionPill: React.FC<{
    nodeKey: NodeKey;
    libraryID: number;
    itemKey: string;
}> = ({ nodeKey, libraryID, itemKey }) => {
    const [editor] = useLexicalComposerContext();
    const [isHovered, setIsHovered] = useState(false);
    const [item, setItem] = useState<Zotero.Item | null>(null);

    useEffect(() => {
        let cancelled = false;
        // Cached lookup first (synchronous in most cases)
        try {
            const cached = Zotero.Items.getByLibraryAndKey(libraryID, itemKey);
            if (cached) {
                setItem(cached as Zotero.Item);
                return;
            }
        } catch {
            /* fall through */
        }
        // Fallback to async load
        Zotero.Items.getByLibraryAndKeyAsync(libraryID, itemKey)
            .then((loaded) => {
                if (!cancelled && loaded) setItem(loaded as Zotero.Item);
            })
            .catch(() => {
                /* ignore - render fallback */
            });
        return () => {
            cancelled = true;
        };
    }, [libraryID, itemKey]);

    const handleRemove = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        editor.update(() => {
            const node = $getNodeByKey(nodeKey);
            if ($isMentionNode(node)) node.remove();
        });
    };

    const displayName = item
        ? item.isRegularItem()
            ? truncateText(getDisplayNameFromItem(item), MAX_ITEM_TEXT_LENGTH)
            : truncateText(item.getDisplayTitle(), MAX_ITEM_TEXT_LENGTH)
        : `${libraryID}-${itemKey}`;

    const iconName = (() => {
        try {
            return item?.getItemTypeIconName() ?? null;
        } catch {
            return null;
        }
    })();

    return (
        // Render as a button to match the existing MessageItemButton look.
        // `contentEditable=false` and `data-lexical-decorator` keep the browser
        // and Lexical from treating its inner text as editable content.
        <button
            type="button"
            contentEditable={false}
            data-lexical-decorator="true"
            className="variant-outline source-button beaver-mention-pill"
            style={{ height: '22px', verticalAlign: 'middle' }}
            aria-label={`Zotero item: ${displayName}`}
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
            onMouseDown={(e) => {
                // Prevent the editor from losing its selection when clicking the pill
                e.preventDefault();
            }}
            onClick={(e) => {
                e.preventDefault();
                if (!item) return;
                try {
                    const win = Zotero.getMainWindow();
                    if (win && win.ZoteroPane) win.ZoteroPane.selectItem(item.id);
                } catch {
                    /* ignore */
                }
            }}
        >
            {isHovered ? (
                <span
                    role="button"
                    aria-label="Remove mention"
                    className="source-remove"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={handleRemove}
                >
                    <CSSIcon name="x-8" className="icon-16" />
                </span>
            ) : iconName ? (
                <span className="scale-80">
                    <CSSItemTypeIcon itemType={iconName} />
                </span>
            ) : null}
            <span className="truncate">{displayName}</span>
        </button>
    );
};
