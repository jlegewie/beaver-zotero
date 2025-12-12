import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import ZoteroCitation from '../sources/ZoteroCitation';
import rehypeKatex from 'rehype-katex';
import deepmerge from 'deepmerge';
import NoteDisplay, { StreamingNoteBlock } from './NoteDisplay';
import { 
    parseCitationAttributes, 
    computeCitationKeyFromAttrs, 
    getCitationIdentityKey 
} from '../../types/citations';

// Create a custom schema that extends GitHub's defaults but allows citation tags
// Supported citation formats:
//   <citation item_id="..."/>           - parent item reference
//   <citation att_id="..."/>            - attachment reference  
//   <citation att_id="..." sid="..."/>  - attachment with sentence ID
//   <citation external_id="..."/>       - external reference
const customSchema = deepmerge(defaultSchema, {
    tagNames: [...(defaultSchema.tagNames || []), 'citation'],
    attributes: {
        ...defaultSchema.attributes,
        // Note: We allow extra attributes that get passed through but ignored
        // attachment_id is normalized to att_id during preprocessing
        // citation_key is used for metadata lookup (replaces raw_tag)
        citation: ['item_id', 'att_id', 'attachment_id', 'sid', 'external_id', 'consecutive', 'adjacent', 'citation_key']
    }
});

type Segment = 
    | { type: 'markdown', content: string }
    | { type: 'note', data: StreamingNoteBlock };

type MarkdownRendererProps = {
    content: string;
    className?: string;
    exportRendering?: boolean;
    /** Message ID for SSE/HTTP streaming (proposed actions) */
    messageId?: string;
    /** Agent run ID for WebSocket streaming (agent actions) */
    runId?: string;
    enableNoteBlocks?: boolean;
};

/**
 * Construct a raw tag string from attributes (excluding id which is injected)
 * This is used to match against the raw_tag from agent actions.
 * 
 * IMPORTANT: Attributes are sorted alphabetically to ensure consistent matching.
 */
function constructRawTag(tagName: string, attributes: Record<string, string>): string {
    // Filter out 'id' attribute as it's injected by the backend, then sort
    const attrs = Object.entries(attributes)
        .filter(([key]) => key !== 'id')
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([key, value]) => `${key}="${value}"`)
        .join(' ');
    return attrs ? `<${tagName} ${attrs}>` : `<${tagName}>`;
}

/**
 * Parse content into alternating segments of markdown and note blocks
 * @param content The raw content string containing markdown and note tags
 * @returns Array of segments in order of appearance
 */
function parseContentIntoSegments(content: string): Segment[] {
    const segments: Segment[] = [];
    
    // Regex to find opening note tags with attributes
    const noteOpeningTagRegex = /<note\s+([^>]*?)>/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    
    while ((match = noteOpeningTagRegex.exec(content)) !== null) {
        const openTagStart = match.index;
        const openTagEnd = openTagStart + match[0].length;
        const attributesStr = match[1];
        
        // Add markdown segment before this note (if any)
        if (openTagStart > lastIndex) {
            const markdownContent = content.substring(lastIndex, openTagStart);
            if (markdownContent.trim().length > 0) {
                segments.push({ type: 'markdown', content: markdownContent });
            }
        }
        
        // Extract attributes from the opening tag
        const attributes: Record<string, string> = {};
        const attrRegex = /(\w+)="([^"]*)"/g;
        let attrMatch: RegExpExecArray | null;
        while ((attrMatch = attrRegex.exec(attributesStr)) !== null) {
            attributes[attrMatch[1]] = attrMatch[2];
        }
        
        // Look for closing tag
        const closingTagPattern = '</note>';
        const closingTagIndex = content.indexOf(closingTagPattern, openTagEnd);
        
        let noteContent: string;
        let isComplete: boolean;
        let nextIndex: number;
        
        if (closingTagIndex !== -1) {
            // Found closing tag
            noteContent = content.substring(openTagEnd, closingTagIndex);
            isComplete = true;
            nextIndex = closingTagIndex + closingTagPattern.length;
        } else {
            // No closing tag - treat rest of content as note content
            noteContent = content.substring(openTagEnd);
            isComplete = false;
            nextIndex = content.length;
        }
        
        // Construct raw tag for matching (excludes 'id' attribute)
        const rawTag = constructRawTag('note', attributes);
        
        // Create note block
        const noteBlock: StreamingNoteBlock = {
            id: attributes.id || '',
            title: attributes.title,
            itemId: attributes.item_id || null,
            attributes,
            content: noteContent,
            isComplete,
            rawTag
        };
        
        segments.push({ type: 'note', data: noteBlock });
        lastIndex = nextIndex;
    }
    
    // Add any remaining markdown content after the last note
    if (lastIndex < content.length) {
        const markdownContent = content.substring(lastIndex);
        if (markdownContent.trim().length > 0) {
            segments.push({ type: 'markdown', content: markdownContent });
        }
    }
    
    // If no notes were found, return single markdown segment
    if (segments.length === 0 && content.trim().length > 0) {
        segments.push({ type: 'markdown', content });
    }
    
    return segments;
}

/**
 * Preprocess citations in markdown content.
 * 
 * Handles various LLM output formats gracefully:
 * - Self-closing: <citation att_id="..."/>
 * - Opening only (missing /): <citation att_id="...">
 * - Full pair: <citation att_id="..."></citation>
 * - Attribute variations: attachment_id → att_id
 * 
 * Injects citation_key for metadata lookup (e.g., "zotero:1-ABC123" or "external:xyz")
 * 
 * @param content Markdown content with citation tags
 * @param lastCitationKeyRef Reference to the last citation key (for consecutive tracking)
 * @returns Preprocessed content with normalized citations
 */
function preprocessCitations(content: string, lastCitationKeyRef: { value: string }): string {
    let lastCitationEndIndex = -1;
    
    // Match citation tags in all formats
    return content.replace(
        /<citation\s+((?:[^>])+?)\s*(?:\/>|>(?:<\/citation>)?)/g,
        (match, attributesStr, offset, fullString) => {
            // Parse and normalize attributes using shared utility
            const normalizedAttrs = parseCitationAttributes(attributesStr);
            
            // Get identity key for consecutive detection
            const identityKey = getCitationIdentityKey(normalizedAttrs);
            
            // Check if this citation references the same item as the previous one
            const isConsecutive = identityKey && identityKey === lastCitationKeyRef.value;
            
            // Check if adjacent (only whitespace between this and previous citation)
            const isAdjacent = isConsecutive && lastCitationEndIndex >= 0 && 
                fullString.substring(lastCitationEndIndex, offset).trim() === '';
            
            // Update tracking for next iteration
            lastCitationKeyRef.value = identityKey;
            lastCitationEndIndex = offset + match.length;
            
            // Build normalized attribute string for HTML output
            const attrParts: string[] = [];
            if (normalizedAttrs.item_id) attrParts.push(`item_id="${normalizedAttrs.item_id}"`);
            if (normalizedAttrs.att_id) attrParts.push(`att_id="${normalizedAttrs.att_id}"`);
            if (normalizedAttrs.external_id) attrParts.push(`external_id="${normalizedAttrs.external_id}"`);
            if (normalizedAttrs.sid) attrParts.push(`sid="${normalizedAttrs.sid}"`);
            const normalizedAttrStr = attrParts.join(' ');
            
            // Compute citation_key for metadata lookup (single source of truth)
            const citationKey = computeCitationKeyFromAttrs(normalizedAttrs);
            const citationKeyAttr = citationKey ? `citation_key="${citationKey}"` : '';
            
            // Build final tag with normalized attributes
            const baseAttrs = [normalizedAttrStr, citationKeyAttr].filter(Boolean).join(' ');
            
            if (isAdjacent) {
                return `<citation ${baseAttrs} consecutive="true" adjacent="true"></citation>`;
            }
            if (isConsecutive) {
                return `<citation ${baseAttrs} consecutive="true"></citation>`;
            }
            
            return `<citation ${baseAttrs}></citation>`;
        }
    );
}

const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({
    content, 
    className = 'markdown', 
    exportRendering = false,
    messageId,
    runId,
    enableNoteBlocks = true
}) => {
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

        // Clean up backticks around complete citations (handles both /> and > endings)
        processed = processed.replace(/`(<citation[^>]*\/?>)`/g, '$1');

        // Filter out other partial tags
        const partialTagPatterns = [
            /<citation[^>]*$/,                // Partial citation tag
            /<note[^>]*$/,                    // Partial note opening tag
            /<\/note$/,                       // Partial note closing tag
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
    
    // Parse into segments if note blocks are enabled
    const segments = enableNoteBlocks 
        ? parseContentIntoSegments(processedContent)
        : [{ type: 'markdown' as const, content: processedContent }];
    
    // Track last citation key across all markdown segments for consecutive detection
    const lastCitationKeyRef = { value: "" };
    
    // Process each segment
    const processedSegments = segments.map((segment, index) => {
        if (segment.type === 'note') {
            return segment;
        }
        
        // Apply citation preprocessing to markdown segments
        let markdownContent = segment.content;
        
        // Preprocess citations
        markdownContent = preprocessCitations(markdownContent, lastCitationKeyRef);
        
        // Apply other markdown preprocessing
        markdownContent = markdownContent
            // Fix common formatting issues
            .replace(/```plaintext\s*([\s\S]*?)\s*```/, '$1')
            .replace(/\$\$([^$]+)\$\$/g, (_, equation) => `\n$$\n${equation.trim()}\n$$\n`)
            // Inline and display math
            .replace(/(?<!\\)\\\(((?:\\.|[^\\])*?)\\\)/g, (_, match) => `$${match}$`)
            .replace(/(?<!\\)\\\[((?:\\.|[^\\])*?)\\\]/g, (_, match) => `$$${match}$$`);
        
        return { type: 'markdown' as const, content: markdownContent };
    });

    // Render segments
    return (
        <div className="display-flex flex-col gap-3">
            {processedSegments.map((segment, index) => {
                if (segment.type === 'note') {
                    // Use id if available, otherwise use rawTag or index for key stability
                    const noteKey = segment.data.id || segment.data.rawTag || `${segment.data.title}-${index}`;
                    return (
                        <NoteDisplay
                            key={`note-${noteKey}`}
                            note={segment.data}
                            messageId={messageId}
                            runId={runId}
                            exportRendering={exportRendering}
                        />
                    );
                }
                
                // Render markdown segment
                return (
                    <div key={`markdown-${index}`} className={className}>
                        <ReactMarkdown
                            remarkPlugins={[remarkMath, remarkGfm]}
                            rehypePlugins={[rehypeRaw, [rehypeSanitize, customSchema], rehypeKatex]}
                            components={{
                                // @ts-expect-error - Custom component not in ReactMarkdown types
                                citation: ({node, ...props}: any) => {
                                    return <ZoteroCitation {...props} exportRendering={exportRendering} />;
                                }
                            }}
                        >
                            {segment.content}
                        </ReactMarkdown>
                    </div>
                );
            })}
        </div>
    );
};

export default MarkdownRenderer;