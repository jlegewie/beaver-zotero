import { useEffect } from 'react';
import { TextNode, $createTextNode } from 'lexical';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $createZoteroItemNode } from './ZoteroItemNode';

// Match @{id}-{key} followed by a word boundary (space, end, punctuation)
const ZOTERO_REF_REGEX = /@(\d+)-([A-Za-z0-9]{8})(?=\s|$|[.,;:!?)\]}])/g;

export default function ZoteroItemTransformPlugin(): null {
    const [editor] = useLexicalComposerContext();

    useEffect(() => {
        return editor.registerNodeTransform(TextNode, (textNode) => {
            const text = textNode.getTextContent();
            const matches = [...text.matchAll(ZOTERO_REF_REGEX)];

            if (matches.length === 0) return;

            // Process right-to-left to avoid index shifting
            for (let i = matches.length - 1; i >= 0; i--) {
                const match = matches[i];
                const matchStart = match.index!;
                const matchEnd = matchStart + match[0].length;
                const libraryId = parseInt(match[1], 10);
                const zoteroKey = match[2];

                // Split at match boundaries
                let targetNode = textNode;

                // If there's text after the match, split there first
                if (matchEnd < targetNode.getTextContent().length) {
                    targetNode.splitText(matchEnd);
                    // targetNode is now the part before + match
                }

                // If there's text before the match, split there
                if (matchStart > 0) {
                    const [, afterNode] = targetNode.splitText(matchStart);
                    if (afterNode) {
                        targetNode = afterNode;
                    }
                }

                // Replace the target node (which now contains only the match) with a ZoteroItemNode
                const zoteroNode = $createZoteroItemNode(libraryId, zoteroKey);
                targetNode.replace(zoteroNode);

                // Insert a space after the chip so the cursor has somewhere to land
                const nextSibling = zoteroNode.getNextSibling();
                if (!nextSibling || (nextSibling instanceof TextNode && !nextSibling.getTextContent().startsWith(' '))) {
                    const spaceNode = $createTextNode(' ');
                    zoteroNode.insertAfter(spaceNode);
                    // Move selection to after the space
                    spaceNode.select(1, 1);
                }
            }
        });
    }, [editor]);

    return null;
}
