import React, { useMemo, useContext } from 'react';
import type { Components } from 'react-markdown';
import MarkdownBody from './MarkdownBody';
import NoteDisplay, { StreamingNoteBlock } from './NoteDisplay';

type NoteRendererContextValue = {
    messageId?: string;
    exportRendering: boolean;
    notes: Record<string, StreamingNoteBlock>;
};

const NoteRendererContext = React.createContext<NoteRendererContextValue | null>(null);

const ATTRIBUTE_REGEX = /([a-zA-Z0-9_-]+)\s*=\s*"([^"]*)"/g;

function parseAttributes(attributeString: string): Record<string, string> {
    const attributes: Record<string, string> = {};
    attributeString.replace(ATTRIBUTE_REGEX, (_, name, value) => {
        if (name) {
            attributes[name] = value;
        }
        return '';
    });
    return attributes;
}

function extractNoteBlocks(content: string): { sanitizedContent: string; notes: Record<string, StreamingNoteBlock> } {
    const notes: Record<string, StreamingNoteBlock> = {};
    let sanitizedContent = '';
    let cursor = 0;
    const openTagRegex = /<note\b[^>]*>/gi;
    let match: RegExpExecArray | null;

    while ((match = openTagRegex.exec(content)) !== null) {
        const startIndex = match.index;
        const openTag = match[0];
        const tagEndIndex = startIndex + openTag.length;

        sanitizedContent += content.slice(cursor, startIndex);

        const attributeString = openTag
            .replace(/^<note/i, '')
            .replace(/>$/i, '')
            .trim();
        const attributes = parseAttributes(attributeString);
        const noteId = attributes.id;

        if (!noteId) {
            sanitizedContent += content.slice(startIndex, tagEndIndex);
            cursor = tagEndIndex;
            continue;
        }

        const closingRegex = /<\/note>/gi;
        closingRegex.lastIndex = tagEndIndex;
        const closingMatch = closingRegex.exec(content);

        const noteContentEnd = closingMatch ? closingMatch.index : content.length;
        const innerContent = content.slice(tagEndIndex, noteContentEnd);
        const hasClosingTag = Boolean(closingMatch);
        
        // Debug logging
        console.log('[extractNoteBlocks] Extracted note:', {
            noteId,
            title: attributes.title,
            contentLength: innerContent.length,
            contentPreview: innerContent.substring(0, 100),
            isComplete: hasClosingTag
        });

        notes[noteId] = {
            id: noteId,
            title: attributes.title,
            itemId: attributes.item_id ?? attributes.itemId ?? null,
            attributes,
            content: innerContent,
            isComplete: hasClosingTag
        };

        sanitizedContent += `<note id="${noteId}" data-note-id="${noteId}"></note>`;

        if (hasClosingTag && closingMatch) {
            cursor = closingMatch.index + closingMatch[0].length;
            openTagRegex.lastIndex = cursor;
        } else {
            cursor = content.length;
            break;
        }
    }

    if (cursor < content.length) {
        sanitizedContent += content.slice(cursor);
    }

    return { sanitizedContent, notes };
}

const NoteElement: React.FC<any> = ({ node, children, ...props }) => {
    const context = useContext(NoteRendererContext);
    if (!context) {
        console.log('[NoteElement] No context available');
        return <>{children}</>;
    }
    const properties = node?.properties || {};
    const noteId =
        (properties['data-note-id'] as string | undefined) ??
        (properties['dataNoteId'] as string | undefined) ??
        (properties.id as string | undefined) ??
        (props['data-note-id'] as string | undefined) ??
        (props['dataNoteId'] as string | undefined) ??
        (props.id as string | undefined);
    if (!noteId) {
        console.log('[NoteElement] No noteId found in properties:', properties, 'or props:', props);
        return <>{children}</>;
    }
    const noteData = context.notes[noteId];
    if (!noteData) {
        console.log('[NoteElement] No note data found for noteId:', noteId, 'Available notes:', Object.keys(context.notes));
        return <>{children}</>;
    }
    
    console.log('[NoteElement] Rendering note:', {
        noteId,
        title: noteData.title,
        contentLength: noteData.content.length,
        messageId: context.messageId
    });

    return (
        <NoteDisplay
            note={noteData}
            messageId={context.messageId}
            exportMode={context.exportRendering}
        />
    );
};

type MarkdownRendererProps = {
    content: string;
    className?: string;
    exportRendering?: boolean;
    messageId?: string;
    enableNoteBlocks?: boolean;
};

const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({
    content, 
    className = 'markdown', 
    exportRendering = false,
    messageId,
    enableNoteBlocks = true
}) => {

    // Preprocess citation tags:
    // - transform self-closing citation tags into proper open/close tags
    // - tracks repeated citations with the same ID to add the `consecutive` attribute
    let lastCitationId = "";
    
    // Process partial tags at the end of content
    const processPartialContent = (content: string): string => {
        let processed = content;

        // Remove invisible or control characters
        // Includes: zero-width space, zero-width non-joiner, soft hyphen, etc.
        processed = processed.normalize("NFKC").replace(/[\u200B-\u200D\uFEFF\u00AD]/g, '');
            
        // Complete unclosed code blocks
        // const codeBlockRegex = /```(?:\w+)?\s+[^`]*$/;
        // const codeBlockMatch = processed.match(codeBlockRegex);
        // if (codeBlockMatch && codeBlockMatch.index !== undefined && 
        //     codeBlockMatch.index + codeBlockMatch[0].length === processed.length) {
        //     // Add closing ``` for proper formatting during streaming
        //     return processed + "\n```";
        // }

        // Complete unclosed bold formatting for rendering during streaming
        // Strategy: Count ** pairs and if there's an odd number, temporarily add closing **
        const boldMarkers = (processed.match(/\*\*/g) || []).length;
        if (boldMarkers % 2 === 1) {
            if (!processed.endsWith('**')) {
                processed = processed + '**';
            }
        }

        // Clean up backticks around complete citations
        processed = processed.replace(/`(<citation[^>]*\/>)`/g, '$1');

        // Filter out other partial tags
        const partialTagPatterns = [
            /<citation[^>]*$/,                // Partial citation tag
            /<[a-z][a-z0-9]*(?:\s+[^>]*)?$/i, // Any partial HTML tag
            /\$\$[^$]*$/                      // Unclosed math equation
        ];
        
        // Check if content ends with any of our partial tag patterns
        for (const pattern of partialTagPatterns) {
            const match = processed.match(pattern);
            if (match && match.index !== undefined && match.index + match[0].length === processed.length) {
                // Remove the partial tag if it's at the end of the content
                processed = processed.substring(0, match.index);
                break; // Only apply one filter
            }
        }
        
        return processed;
    };
    
    const processedContent = processPartialContent(content);
    
    const preprocessedContent = processedContent
        .replace(
            /<citation\s+((?:[^>])+?)\s*\/>/g,
            (match, attributesStr) => {
                // Extract the ID from attributes
                const idMatch = attributesStr.match(/id="([^"]+)"/);
                const id = idMatch ? idMatch[1] : "";
                
                // Check if this citation has the same ID as the previous one
                const isConsecutive = id && id === lastCitationId;
                
                // Update the last citation ID
                lastCitationId = id;
                
                // Add the consecutive attribute if needed
                if (isConsecutive) {
                    return `<citation ${attributesStr} consecutive="true"></citation>`;
                }
                
                return `<citation ${attributesStr}></citation>`;
            }
        )
        // Fix common formatting issues
        .replace(/```plaintext\s*([\s\S]*?)\s*```/, '$1')
        .replace(/\$\$([^$]+)\$\$/g, (_, equation) => `\n$$\n${equation.trim()}\n$$\n`)
        // Inline and display math
        .replace(/(?<!\\)\\\(((?:\\.|[^\\])*?)\\\)/g, (_, match) => `$${match}$`)
        .replace(/(?<!\\)\\\[((?:\\.|[^\\])*?)\\\]/g, (_, match) => `$$${match}$$`);

    const noteExtraction = useMemo(() => {
        if (!enableNoteBlocks) {
            return {
                sanitizedContent: preprocessedContent,
                notes: {} as Record<string, StreamingNoteBlock>
            };
        }
        return extractNoteBlocks(preprocessedContent);
    }, [enableNoteBlocks, preprocessedContent]);

    const noteContextValue = useMemo<NoteRendererContextValue | null>(() => {
        if (!enableNoteBlocks) {
            return null;
        }
        return {
            messageId,
            exportRendering,
            notes: noteExtraction.notes
        };
    }, [enableNoteBlocks, exportRendering, messageId, noteExtraction.notes]);

    const markdownComponents = enableNoteBlocks
        ? ({
            note: (props: any) => <NoteElement {...props} />
        } as Components)
        : undefined;

    const markdownElement = (
        <MarkdownBody
            className={className}
            exportRendering={exportRendering}
            content={noteExtraction.sanitizedContent}
            components={markdownComponents}
        />
    );

    if (noteContextValue) {
        return (
            <NoteRendererContext.Provider value={noteContextValue}>
                {markdownElement}
            </NoteRendererContext.Provider>
        );
    }

    return markdownElement;
};

export default MarkdownRenderer;