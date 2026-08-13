import React, { useState } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getNodeByKey, NodeKey } from 'lexical';
import { CancelIcon, FileIcon, Icon } from '@beaver/agent-ui/icons';
import { getHost } from '@beaver/agent-ui/host';
import { $isMentionNode, type MentionDescriptor } from './MentionNode';

/**
 * Visual for a MentionNode.
 *
 * Renders purely from the node's descriptor - no data lookup, so the pill works
 * in any client. Styled to match MessageItemButton (same `source-button`
 * class), so pills feel at home with the attachment row above the editor. Kept
 * intentionally thin: no hover preview, no validation, no atom wiring. Those
 * can be layered on later when mentions are integrated with the attachment
 * system.
 */
export const MentionPill: React.FC<{
    nodeKey: NodeKey;
    descriptor: MentionDescriptor;
}> = ({ nodeKey, descriptor }) => {
    const [editor] = useLexicalComposerContext();
    const [isHovered, setIsHovered] = useState(false);

    const handleRemove = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        editor.update(() => {
            const node = $getNodeByKey(nodeKey);
            if ($isMentionNode(node)) node.remove();
        });
    };

    const { label, sublabel, iconName, ref } = descriptor;

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
            aria-label={sublabel ? `Mention: ${label}, ${sublabel}` : `Mention: ${label}`}
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
            onMouseDown={(e) => {
                // Prevent the editor from losing its selection when clicking the pill
                e.preventDefault();
            }}
            onClick={(e) => {
                e.preventDefault();
                // A descriptor without a ref (e.g. a document selection) points
                // at nothing to reveal, so the pill is simply not activatable.
                if (!ref) return;
                getHost().navigation?.revealInLibrary(ref);
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
                    <Icon icon={CancelIcon} className="scale-80" />
                </span>
            ) : iconName ? (
                <span className="scale-80">
                    {/* The client owns its item-type artwork; the generic
                        document glyph is the honest fallback when it has none. */}
                    {getHost().components?.itemTypeIcon({ itemType: iconName })
                        ?? <Icon icon={FileIcon} />}
                </span>
            ) : null}
            <span className="truncate">{label}</span>
            {sublabel ? (
                <span className="truncate font-color-tertiary ml-1">{sublabel}</span>
            ) : null}
        </button>
    );
};
