import { useEffect, useRef } from 'react';
import { $getRoot, $createTextNode, $createParagraphNode } from 'lexical';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $createZoteroItemNode } from './ZoteroItemNode';

const ZOTERO_REF_REGEX = /@(\d+)-([A-Za-z0-9]{8})/g;

interface PlainTextValuePluginProps {
    value: string;
    onChange: (value: string) => void;
}

export default function PlainTextValuePlugin({ value, onChange }: PlainTextValuePluginProps): null {
    const [editor] = useLexicalComposerContext();
    const lastValueFromEditor = useRef(value);
    const isExternalUpdate = useRef(false);

    // Editor -> Parent: extract plain text on update
    useEffect(() => {
        return editor.registerUpdateListener(({ editorState }) => {
            // Skip updates triggered by our own external sync
            if (isExternalUpdate.current) return;

            editorState.read(() => {
                const text = $getRoot().getTextContent();
                if (text !== lastValueFromEditor.current) {
                    lastValueFromEditor.current = text;
                    onChange(text);
                }
            });
        });
    }, [editor, onChange]);

    // Parent -> Editor: rebuild content when value changes externally
    useEffect(() => {
        // Skip if this value came from the editor itself
        if (value === lastValueFromEditor.current) return;

        lastValueFromEditor.current = value;
        isExternalUpdate.current = true;

        editor.update(() => {
            const root = $getRoot();
            root.clear();

            const lines = value.split('\n');
            for (const line of lines) {
                const paragraph = $createParagraphNode();
                buildNodesForLine(line, paragraph);
                root.append(paragraph);
            }
        }, {
            discrete: true,
        });

        // Reset flag after the update completes
        // Use setTimeout to ensure it happens after the update listener fires
        setTimeout(() => {
            isExternalUpdate.current = false;
        }, 0);
    }, [editor, value]);

    return null;
}

function buildNodesForLine(
    text: string,
    paragraph: ReturnType<typeof $createParagraphNode>
): void {
    let lastIndex = 0;

    for (const match of text.matchAll(ZOTERO_REF_REGEX)) {
        const matchStart = match.index!;

        // Add text before the match
        if (matchStart > lastIndex) {
            paragraph.append($createTextNode(text.slice(lastIndex, matchStart)));
        }

        // Add ZoteroItemNode
        const libraryId = parseInt(match[1], 10);
        const zoteroKey = match[2];
        paragraph.append($createZoteroItemNode(libraryId, zoteroKey));

        lastIndex = matchStart + match[0].length;
    }

    // Add remaining text
    if (lastIndex < text.length) {
        paragraph.append($createTextNode(text.slice(lastIndex)));
    }
}
