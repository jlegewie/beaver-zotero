import React from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import Citation from '../citations/Citation';
import rehypeKatex from 'rehype-katex';
import deepmerge from 'deepmerge';
import NoteDisplay, { StreamingNoteBlock } from './NoteDisplay';
import { 
    preprocessCitations, 
    createPreprocessState 
} from '../../utils/citationPreprocessing';
import { processPartialContent } from '../../utils/markdownPartialContent';

const citationDataAttributes = [
    'data-library-id', 'dataLibraryId',
    'data-library-ref', 'dataLibraryRef',
    'data-zotero-key', 'dataZoteroKey',
    'data-external-id', 'dataExternalId',
    'data-external-source', 'dataExternalSource',
    'data-ext-key', 'dataExtKey',
    'data-loc', 'dataLoc',
    'data-loc-kind', 'dataLocKind',
    'data-loc-value', 'dataLocValue',
    'data-requested-citation-key', 'dataRequestedCitationKey',
    'data-resolved-citation-key', 'dataResolvedCitationKey',
    'data-consecutive', 'dataConsecutive',
    'data-adjacent', 'dataAdjacent',
    'data-invalid-reason', 'dataInvalidReason',
    'data-raw-identity', 'dataRawIdentity',
    'data-identity-attr', 'dataIdentityAttr',
];

// Create a custom schema that extends GitHub's defaults but allows normalized citation tags.
const customSchema = deepmerge(defaultSchema, {
    tagNames: [...(defaultSchema.tagNames || []), 'citation'],
    attributes: {
        ...defaultSchema.attributes,
        citation: citationDataAttributes
    },
    protocols: {
        ...defaultSchema.protocols,
        href: [...(defaultSchema.protocols?.href || []), 'zotero']
    }
});

/**
 * Extract text content from a HAST node tree.
 */
function hastTextContent(node: any): string {
    if (node.type === 'text') return node.value || '';
    if (node.children) {
        return node.children.map((c: any) => hastTextContent(c)).join('');
    }
    return '';
}

/**
 * Rehype plugin that converts math nodes to Zotero's note format
 * instead of rendering with KaTeX.
 *
 * After remark-math + rehype-sanitize, math nodes appear as:
 *   - Inline:  <code class="language-math">content</code>
 *   - Display: <pre><code class="language-math">content</code></pre>
 *
 * This plugin transforms them to:
 *   - Inline:  <span class="math">$content$</span>
 *   - Display: <pre class="math">$$content$$</pre>
 */
function rehypeZoteroMath() {
    return (tree: any) => {
        transformMathNodes(tree);
    };
}

function transformMathNodes(node: any) {
    if (!node.children) return;

    for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i];
        if (child.type !== 'element') continue;

        const classes: string[] = Array.isArray(child.properties?.className)
            ? child.properties.className
            : [];

        // Display math: <pre><code class="language-math">content</code></pre>
        if (child.tagName === 'pre' && child.children?.length === 1) {
            const codeChild = child.children[0];
            if (codeChild.type === 'element' && codeChild.tagName === 'code') {
                const codeClasses: string[] = Array.isArray(codeChild.properties?.className)
                    ? codeChild.properties.className
                    : [];
                if (codeClasses.includes('language-math')) {
                    const mathContent = hastTextContent(codeChild);
                    child.properties = { className: ['math'] };
                    child.children = [{ type: 'text', value: `$$${mathContent}$$` }];
                    continue;
                }
            }
        }

        // Inline math: <code class="language-math">content</code>
        if (child.tagName === 'code' && classes.includes('language-math')) {
            const mathContent = hastTextContent(child);
            child.tagName = 'span';
            child.properties = { className: ['math'] };
            child.children = [{ type: 'text', value: `$${mathContent}$` }];
            continue;
        }

        // Recurse into untransformed nodes
        transformMathNodes(child);
    }
}

/** Allow zotero:// URLs through react-markdown's URL sanitization */
function urlTransform(url: string): string {
    if (url.startsWith('zotero://')) return url;
    return defaultUrlTransform(url);
}

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


const MarkdownRenderer: React.FC<MarkdownRendererProps> = React.memo(function MarkdownRenderer({
    content,
    className = 'markdown',
    exportRendering = false,
    messageId,
    runId,
    enableNoteBlocks = true
}) {
    // Heavy preprocessing: skip when content/flags are unchanged (e.g. parent re-render).
    const processedSegments = React.useMemo(() => {
        const processedContent = processPartialContent(content, exportRendering);

        const segments = enableNoteBlocks
            ? parseContentIntoSegments(processedContent)
            : [{ type: 'markdown' as const, content: processedContent }];

        // Track citation state across all markdown segments for consecutive detection
        const preprocessState = createPreprocessState();

        return segments.map((segment) => {
            if (segment.type === 'note') {
                return segment;
            }

            let markdownContent = segment.content;
            markdownContent = preprocessCitations(markdownContent, preprocessState);
            markdownContent = markdownContent
                .replace(/```plaintext\s*([\s\S]*?)\s*```/, '$1')
                .replace(/(?<!\\)\\\(((?:\\.|[^\\])*?)\\\)/g, (_, match) => `$${match}$`)
                .replace(/(?<!\\)\\\[((?:\\.|[^\\])*?)\\\]/g, (_, match) => `$$${match}$$`)
                .replace(/\$\$([^$]+)\$\$/g, (_, equation) => `\n$$\n${equation.trim()}\n$$\n`);

            return { type: 'markdown' as const, content: markdownContent };
        });
    }, [content, exportRendering, enableNoteBlocks]);

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
                            rehypePlugins={[rehypeRaw, [rehypeSanitize, customSchema], exportRendering ? rehypeZoteroMath : rehypeKatex]}
                            urlTransform={urlTransform}
                            components={{
                                // @ts-expect-error - Custom component not in ReactMarkdown types
                                citation: ({node, ...props}: any) => {
                                    return <Citation {...props} exportRendering={exportRendering} />;
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
});

export default MarkdownRenderer;
