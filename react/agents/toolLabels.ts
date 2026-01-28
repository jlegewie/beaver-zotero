import { ToolCallStatus } from './atoms';
import { ToolCallPart } from './types';
import { getLibraryByIdOrName, getCollectionByIdOrName } from '../../src/services/agentDataProvider/utils';

/**
 * Get display name from a Zotero item (Author Year format).
 * For attachments, uses the parent item's metadata.
 */
function getItemDisplayName(item: Zotero.Item): string {
    // For attachments, get the parent item
    const targetItem = item.isAttachment() ? item.parentItem || item : item;
    
    const firstCreator = targetItem.firstCreator || 'Unknown';
    const year = targetItem.getField('date')?.match(/\d{4}/)?.[0] || '';
    
    return `${firstCreator}${year ? ` ${year}` : ''}`;
}

/**
 * Parse attachment_id format '<library_id>-<zotero_key>' and get the Zotero item.
 */
function getItemFromAttachmentId(attachmentId: string): Zotero.Item | null {
    const [libraryIdStr, zoteroKey] = attachmentId.split('-');
    if (!libraryIdStr || !zoteroKey) return null;
    
    const libraryId = parseInt(libraryIdStr, 10);
    if (isNaN(libraryId)) return null;
    
    return Zotero.Items.getByLibraryAndKey(libraryId, zoteroKey) || null;
}

/**
 * Base labels for tool calls (display names).
 * Maps tool_name to a human-readable base label.
 */
const TOOL_BASE_LABELS: Record<string, string> = {
    // Search tools
    item_search: 'Item search',
    item_search_by_topic: 'Item search',
    item_search_by_metadata: 'Item search',
    fulltext_search: 'Fulltext search',
    fulltext_search_keywords: 'Keyword search',

    // List tools
    list_items: 'List items',
    list_collections: 'List collections',
    list_tags: 'List tags',
    list_libraries: 'List libraries',
    zotero_search: 'Zotero search',

    // Metadata tools
    get_metadata: 'Get metadata',
    edit_metadata: 'Edit metadata',

    // Organization tools
    organize_items: 'Organize items',
    create_collection: 'Create collection',

    // Reading tools
    read_pages: 'Reading',
    search_in_documents: 'Search in documents',
    search_in_attachment: 'Search in attachment',
    search_in_attachments: 'Search in attachments',
    read_file: 'Retrieving data',
    view_pages: 'Viewing pages',
    view_page_images: 'Viewing pages',

    // Annotations
    add_highlight_annotations: 'Highlight annotations',
    add_note_annotations: 'Note annotations',

    // External search
    search_external_references: 'Web search',
    create_zotero_item: 'Add item',
    external_search: 'Web search',
    lookup_work: 'Lookup work',
};


/**
 * Labels for skill names.
 */
const SKILL_NAME_LABELS: Record<string, string> = {
    'library-management': 'Library management',
};

/**
 * Detect the type of file being read by the read_file tool.
 * 
 * Categorizes files according to:
 * - Tool results: Files ending with .json.gz (compressed tool results from GCS)
 * - Agent Skills: Files in /skills/{skill-name}/ directory
 * - Skill resources: Bundled resources in /skills/{skill-name}/{scripts|references|assets}/
 * - Documentation: Files in /docs/ directory
 * 
 * Agent Skills specification: https://agentskills.io/specification
 */
function detectReadFileType(path: string): 'tool_result' | 'skill' | 'skill_resource' | 'documentation' | 'unknown' {
    const trimmedPath = path.trim();
    const pathLower = trimmedPath.toLowerCase();
    
    // Tool results: files ending with .json.gz
    if (pathLower.endsWith('.json.gz')) {
        return 'tool_result';
    }
    
    // Agent Skills: files in /skills/ directory
    if (pathLower.includes('/skills/')) {
        // Agent Skills main file: SKILL.md (case-insensitive per spec)
        const fileName = trimmedPath.split('/').pop()?.toUpperCase();
        if (fileName === 'SKILL.MD') {
            return 'skill';
        }
        
        // Agent Skills bundled resources (per agentskills.io specification)
        const parts = pathLower.split('/skills/');
        if (parts.length > 1) {
            const skillPath = parts[1];
            const pathSegments = skillPath.split('/');
            // Check for standard skill resource directories (scripts/, references/, assets/)
            if (pathSegments.length > 1 && ['scripts', 'references', 'assets'].includes(pathSegments[1])) {
                return 'skill_resource';
            }
        }
        
        // Other files in skills directory default to skill
        return 'skill';
    }
    
    // Documentation: files in /docs/ directory
    if (pathLower.includes('/docs/')) {
        return 'documentation';
    }
    
    return 'unknown';
}

/**
 * Truncate a string to a maximum length, adding ellipsis if needed.
 */
function truncate(str: string, maxLength: number): string {
    if (str.length <= maxLength) return str;
    return str.slice(0, maxLength) + '...';
}

/**
 * Parse args from ToolCallPart - handles both string and object formats.
 */
function parseArgs(part: ToolCallPart): Record<string, unknown> {
    if (!part.args) return {};
    if (typeof part.args === 'string') {
        try {
            return JSON.parse(part.args);
        } catch {
            return {};
        }
    }
    return part.args as Record<string, unknown>;
}

/**
 * Build year filter label from year_filter object.
 */
function formatYearFilter(yearFilter: unknown): string | null {
    if (!yearFilter || typeof yearFilter !== 'object') return null;
    const filter = yearFilter as { exact?: number; min?: number; max?: number };

    if (filter.exact !== undefined) {
        return `(${filter.exact})`;
    }
    if (filter.min !== undefined && filter.max !== undefined) {
        return `(${filter.min}-${filter.max})`;
    }
    if (filter.min !== undefined) {
        return `(>=${filter.min})`;
    }
    if (filter.max !== undefined) {
        return `(<=${filter.max})`;
    }
    return null;
}

/**
 * Generate a display label for a tool call.
 *
 * Creates human-readable labels like:
 * - "Fulltext search: social capital"
 * - "Metadata search: Smith (2020)"
 * - "Reading: Smith 2020, p. 5-10"
 * - "Retrieving previous results" (for read_file with .json.gz files)
 * - "Reading skill: pdf-processing" (for any Agent Skills file)
 * - "Reading documentation" (for any file in /docs/)
 * 
 * If the tool has a progress message, it takes precedence over the default label.
 */
export function getToolCallLabel(part: ToolCallPart, status: ToolCallStatus): string {
    const toolName = part.tool_name;
    const baseLabel = TOOL_BASE_LABELS[toolName] ?? 'Calling function';
    
    // Progress messages take precedence when present
    if (status === 'in_progress' && part.progress) {
        return `${baseLabel}: ${part.progress}`;
    }
    
    const args = parseArgs(part);

    switch (toolName) {
        // === Fulltext search tools ===
        case 'fulltext_search': {
            const query = args.query_semantic as string | undefined;
            if (query) {
                return `${baseLabel}: "${truncate(query, 40)}"`;
            }
            return baseLabel;
        }

        case 'fulltext_search_keywords': {
            const queries = args.query_primary as string[] | undefined;
            if (queries && queries.length > 0) {
                return `${baseLabel}: "${truncate(queries[0], 40)}"`;
            }
            return baseLabel;
        }

        // === Item search tools ===
        case 'item_search':
        case 'item_search_by_topic': {
            const topic = args.topic_query as string | undefined;
            if (topic) {
                return `${baseLabel}: "${truncate(topic, 40)}"`;
            }
            return baseLabel;
        }

        case 'item_search_by_metadata': {
            const parts: string[] = [];
            if (args.author_query) parts.push(args.author_query as string);
            if (args.title_query) parts.push(args.title_query as string);
            if (args.publication_query) parts.push(`in ${args.publication_query}`);
            const yearLabel = formatYearFilter(args.year_filter);
            if (yearLabel) parts.push(yearLabel);

            if (parts.length > 0) {
                return `${baseLabel}: ${truncate(parts.join(' '), 50)}`;
            }
            return baseLabel;
        }

        // === List tools ===
        case 'list_items': {
            const parts: string[] = [];
            
            // Handle library parameter
            const libraryParam = args.library as string | number | undefined;
            const libraryId = typeof libraryParam === 'number' 
                ? libraryParam 
                : (typeof libraryParam === 'string' ? parseInt(libraryParam, 10) : undefined);
            
            // Handle collection parameter
            const collectionParam = args.collection_key as string | undefined;
            if (collectionParam) {
                const collection = getCollectionByIdOrName(collectionParam, libraryId);
                if (collection) {
                    parts.push(`"${collection.name}"`);
                }
            }
            
            // Handle tag parameter
            const tag = args.tag as string | undefined;
            if (tag) {
                parts.push(`tag "${truncate(tag, 20)}"`);
            }
            
            // Show library name only when no collection/tag filter and library is specified
            if (parts.length === 0 && libraryParam) {
                const library = getLibraryByIdOrName(libraryParam);
                if (library.library && library.library.name) {
                    parts.push(`"${library.library.name}"`);
                } else {
                    parts.push(`"${libraryParam}"`);
                }
            }
            
            if (parts.length > 0) {
                return `${baseLabel}: ${truncate(parts.join(' '), 50)}`;
            }
            return `${baseLabel}`;
        }

        // === Reading tools ===
        case 'search_in_documents': {
            const description = args.description as string | undefined;
            const query = args.query as string | undefined;
            const label = description || (query ? truncate(query, 50) : null);
            if (label) {
                return `${baseLabel}: ${label}`;
            }
            return baseLabel;
        }

        case 'search_in_attachment': {
            const query = args.query as string | undefined;
            if (query) {
                return `${baseLabel}: "${truncate(query, 40)}"`;
            }
            return baseLabel;
        }
        
        case 'read_file': {
            const path = args.path as string | undefined;
            if (path) {
                const fileType = detectReadFileType(path);
                switch (fileType) {
                    case 'tool_result':
                        return 'Retrieving previous results';
                    case 'skill':
                    case 'skill_resource': {
                        // Extract skill name from path: /skills/{skill-name}/...
                        const skillMatch = path.match(/\/skills\/([^/]+)/i);
                        const skillKey = skillMatch?.[1];
                        const skillName = SKILL_NAME_LABELS[skillKey as string] 
                            || skillKey?.replace(/-/g, ' ').split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
                            || 'skill';
                        return `Loading skill: ${truncate(skillName, 30)}`;
                    }
                    case 'documentation':
                        return 'Reading documentation';
                    case 'unknown':
                    default:
                        return `${baseLabel}: ${truncate(path, 40)}`;
                }
            }
            return baseLabel;
        }

        case 'read_pages': {
            const attachmentId = args.attachment_id as string | undefined;
            const startPage = args.start_page as number | undefined;
            const endPage = args.end_page as number | undefined;

            // Build page range string
            let pageRange = '';
            if (startPage !== undefined && endPage !== undefined) {
                pageRange = startPage === endPage ? `p. ${startPage}` : `p. ${startPage}-${endPage}`;
            } else if (startPage !== undefined) {
                pageRange = `p. ${startPage}+`;
            } else if (endPage !== undefined) {
                pageRange = `p. 1-${endPage}`;
            }

            // Get item display name from attachment_id
            if (attachmentId) {
                const item = getItemFromAttachmentId(attachmentId);
                if (item) {
                    const displayName = getItemDisplayName(item);
                    if (pageRange) {
                        return `${baseLabel}: ${displayName}, ${pageRange}`;
                    }
                    return `${baseLabel}: ${displayName}`;
                }
            }

            // Fallback: just show page range or base label
            if (pageRange) {
                return `${baseLabel}: ${pageRange}`;
            }
            return baseLabel;
        }

        // === External search tools ===
        case 'external_search': {
            const searchLabel = args.search_label as string | undefined;
            const query = args.query as string | undefined;
            const label = searchLabel || (query ? truncate(query, 40) : null);
            if (label) {
                return `${baseLabel}: ${label}`;
            }
            return baseLabel;
        }

        case 'lookup_work': {
            const label = (args.identifier || args.title) as string | undefined;
            if (label) {
                return `${baseLabel}: ${truncate(label, 40)}`;
            }
            return baseLabel;
        }

        // === Library management tools ===
        case 'zotero_search': {
            const conditions = args.conditions as Array<{ 
                field?: string; 
                value?: string | null; 
                operator?: string 
            }> | undefined;
            
            if (conditions && conditions.length > 0) {
                // Show first condition as summary
                const firstCond = conditions[0];
                const field = firstCond.field || 'any';
                const operator = firstCond.operator || 'is';
                const value = firstCond.value ?? '';
                
                // Map operators to readable symbols/text
                const operatorLabels: Record<string, string> = {
                    'is': '=',
                    'isNot': '≠',
                    'contains': 'contains',
                    'doesNotContain': 'does not contain',
                    'beginsWith': 'begins with',
                    'isLessThan': '<',
                    'isGreaterThan': '>',
                    'isBefore': 'before',
                    'isAfter': 'after',
                    'isInTheLast': 'in the last',
                };
                
                const operatorLabel = operatorLabels[operator] || operator;
                
                // Format the condition based on operator type
                if (value === '' && (operator === 'doesNotContain' || operator === 'is')) {
                    // Special case: empty field search
                    return `${baseLabel}: ${field} is empty`;
                } else if (['<', '>', '=', '≠'].includes(operatorLabel)) {
                    // Symbolic operators
                    return `${baseLabel}: ${field} ${operatorLabel} "${truncate(value, 25)}"`;
                } else {
                    // Text operators
                    return `${baseLabel}: "${field}" ${operatorLabel} "${truncate(value, 20)}"`;
                }
            }
            return baseLabel;
        }

        case 'list_collections': {
            const libraryParam = args.library as string | number | undefined;
            const libraryId = typeof libraryParam === 'number' 
                ? libraryParam 
                : (typeof libraryParam === 'string' ? parseInt(libraryParam, 10) : undefined);
            
            const parentKey = args.parent_collection as string | undefined;
            if (parentKey) {
                const collection = getCollectionByIdOrName(parentKey, libraryId);
                if (collection) {
                    return `${baseLabel} in "${collection.name}"`;
                }
                return `${baseLabel}: subcollections`;
            }
            
            // Show library name when listing top-level collections
            if (libraryParam) {
                const library = getLibraryByIdOrName(libraryParam);
                if (library.library && library.library.name) {
                    return `${baseLabel}: "${library.library.name}"`;
                } else {
                    return `${baseLabel}: "${libraryParam}"`;
                }
            }
            return `${baseLabel}`;
        }

        case 'list_tags': {
            const libraryParam = args.library as string | number | undefined;
            const libraryId = typeof libraryParam === 'number' 
                ? libraryParam 
                : (typeof libraryParam === 'string' ? parseInt(libraryParam, 10) : undefined);
            
            const collectionKey = args.collection_key as string | undefined;
            if (collectionKey) {
                const collection = getCollectionByIdOrName(collectionKey, libraryId);
                if (collection) {
                    return `${baseLabel} in "${collection.name}"`;
                }
                return `${baseLabel} in collection`;
            }
            
            // Show library name when listing all tags in a library
            if (libraryParam) {
                const library = getLibraryByIdOrName(libraryParam);
                if (library.library && library.library.name) {
                    return `${baseLabel}: "${library.library.name}"`;
                } else {
                    return `${baseLabel}: "${libraryParam}"`;
                }
            }
            return `${baseLabel}`;
        }

        // === Tools without dynamic labels ===
        case 'view_page_images':
        case 'add_highlight_annotations':
        case 'add_note_annotations':
        case 'create_zotero_item':
        case 'list_libraries':
        default:
            return baseLabel;
    }
}

