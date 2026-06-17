import { ToolCallStatus } from './atoms';
import { ToolCallPart } from './types';
import { parseArgs, TOOL_BASE_LABELS } from './toolCallRequest';
import { isItemRow, type ToolResultView } from '../types/toolResultViews';

// Request-side, Zotero-free helpers live in `./toolCallRequest`; re-exported here
// so existing importers (e.g. agentRunAtoms) keep their import path.
export { extractZoteroReferencesFromToolCall } from './toolCallRequest';

/**
 * Host-resolved display data folded into a tool-call header label for calls that
 * have no view model yet (pending / failed). Resolved by the caller via the
 * `itemData` host slice; absent on clients without that capability.
 */
export interface ToolCallLabelEnrich {
    /** Bibliographic name for a content/note/annotation reference ("Smith 2005"). */
    itemDisplayName?: string;
    /** Library scope name for list_* tools. */
    libraryName?: string;
    /** Collection scope name for list_* tools. */
    collectionName?: string;
}

export interface ToolCallLabelOptions {
    /** Hydrated tool-result view model — present once the call has returned. */
    view?: ToolResultView | null;
    /** Host-resolved request-side display data (used when there is no `view`). */
    enrich?: ToolCallLabelEnrich | null;
}

/** Tools whose label headlines a single item's bibliographic name. */
const SINGLE_ITEM_NAME_TOOLS = new Set([
    'read', 'read_pages', 'read_attachment', 'view', 'read_note',
]);

/** Annotation tools whose label headlines the annotation source name. */
const ANNOTATION_NAME_TOOLS = new Set(['get_annotations', 'find_annotations']);

/** List tools whose label shows a host-resolved library/collection scope name. */
const LIST_SCOPE_TOOLS = new Set(['list_items', 'list_collections', 'list_tags']);

/**
 * What host-resolved display data a tool-call label needs *beyond* its view
 * model. The caller (e.g. `ToolCallPartView`) uses this to decide whether to run
 * the `itemData` host resolution effect, and skips it otherwise.
 *
 * - `itemName` — a content/note/annotation reference whose name the view does not
 *   already supply (pending/failed, or an empty annotation view).
 * - `scope` — a `list_*` library/collection scope name (never carried by the view).
 */
export function getLabelEnrichmentNeeds(
    part: ToolCallPart,
    view: ToolResultView | null | undefined,
): { itemName: boolean; scope: boolean } {
    const toolName = part.tool_name;
    const itemName =
        (SINGLE_ITEM_NAME_TOOLS.has(toolName) || ANNOTATION_NAME_TOOLS.has(toolName)) &&
        getViewDisplayName(view, toolName) === null;
    return { itemName, scope: LIST_SCOPE_TOOLS.has(toolName) };
}

/**
 * The headline display name a completed view supplies for a tool-call label, or
 * null when the view carries none (the label then falls back to the host-resolved
 * request-side name, or the base label). Pure — derived from the view model only.
 */
export function getViewDisplayName(
    view: ToolResultView | null | undefined,
    toolName: string,
): string | null {
    if (!view) return null;
    if (SINGLE_ITEM_NAME_TOOLS.has(toolName) && view.view_type === 'item_list') {
        const row = view.items[0];
        return row && isItemRow(row) ? (row.display_name ?? null) : null;
    }
    if (ANNOTATION_NAME_TOOLS.has(toolName) && view.view_type === 'annotation_list') {
        // Scoped (single distinct source) → that source name; unscoped
        // multi-source → null (label falls back to base + count suffix).
        const sources = new Set(
            view.annotations
                .map(a => a.source_display_name)
                .filter((s): s is string => !!s),
        );
        return sources.size === 1 ? [...sources][0] : null;
    }
    return null;
}

/** The completed view's locator badge for a single-item tool ("Page 1-3" / "Lines 10-20"). */
function getViewLocationLabel(view: ToolResultView | null | undefined, toolName: string): string | null {
    if (!view || view.view_type !== 'item_list' || !SINGLE_ITEM_NAME_TOOLS.has(toolName)) return null;
    const row = view.items[0];
    return row && isItemRow(row) ? (row.location_label ?? null) : null;
}

/**
 * Parenthetical count suffix for a completed tool-call label, derived from the
 * view model. Per-tool wording (not a single number): read/view/read_note carry
 * their locator inline and get no suffix; search/list use "(N results/collections/
 * tags)"; attachment_search uses match count; lookup_work uses "(N found)".
 * Returns null when there is nothing to append.
 */
export function getToolResultLabelSuffix(
    view: ToolResultView | null | undefined,
    toolName: string,
): string | null {
    if (!view) return null;
    // Single-item read/view/read_note carry the locator inline — no count suffix.
    if (SINGLE_ITEM_NAME_TOOLS.has(toolName)) return null;
    const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
    switch (view.view_type) {
        case 'item_list': {
            const n = view.items.length;
            return n ? ` (${plural(n, 'result')})` : null;
        }
        case 'collection_list': {
            const n = view.total_count;
            return n ? ` (${plural(n, 'collection')})` : null;
        }
        case 'tag_list': {
            const n = view.total_count;
            return n ? ` (${plural(n, 'tag')})` : null;
        }
        case 'attachment_search': {
            const n = view.total_matches;
            return n ? ` (${n} match${n === 1 ? '' : 'es'})` : null;
        }
        case 'annotation_list': {
            const n = view.annotations.length;
            return n ? ` (${plural(n, 'annotation')})` : null;
        }
        case 'external_reference_list': {
            if (toolName === 'lookup_work') {
                const n = view.found_count ?? view.references.length;
                return n != null ? ` (${n} found)` : null;
            }
            const n = view.references.length;
            return n ? ` (${plural(n, 'result')})` : null;
        }
        default:
            return null;
    }
}

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
 * - Tool results: Storage ref paths (agent_runs/.../tool_results/...) or .json.gz files (legacy)
 * - Agent Skills: Files in /skills/{skill-name}/ directory
 * - Skill resources: Bundled resources in /skills/{skill-name}/{scripts|references|assets}/
 * - Documentation: Files in /docs/ directory
 * 
 * Agent Skills specification: https://agentskills.io/specification
 */
function detectReadFileType(path: string): 'tool_result' | 'skill' | 'skill_resource' | 'documentation' | 'unknown' {
    const trimmedPath = path.trim();
    const pathLower = trimmedPath.toLowerCase();

    // Tool results: storage_ref format (new) or .json.gz files (legacy)
    if (/^agent_runs\/[^/]+\/tool_results\//.test(trimmedPath)) {
        return 'tool_result';
    }
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
 * Normalize a list parameter that might be passed as a JSON string.
 * 
 * Handles cases where the LLM passes a JSON string instead of a proper list.
 * This matches the backend validator behavior.
 * 
 * @param value Either a list, a JSON string representation of a list, or null/undefined
 * @returns A list of strings, or null if value is invalid
 */
function normalizeListParam(value: unknown): string[] | null {
    if (value === null || value === undefined) {
        return null;
    }
    
    // If it's already a list, validate items are strings
    if (Array.isArray(value)) {
        for (const item of value) {
            if (typeof item !== 'string') {
                return null; // Invalid: non-string item in array
            }
        }
        return value;
    }
    
    // If it's a string, try to parse as JSON
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            
            // Parsed successfully - validate the result
            if (Array.isArray(parsed)) {
                for (const item of parsed) {
                    if (typeof item !== 'string') {
                        return null; // Invalid: non-string item in parsed array
                    }
                }
                return parsed;
            } else if (typeof parsed === 'string') {
                // JSON string that decoded to a string (e.g., '"hello"')
                return [parsed];
            } else {
                // Parsed to something else (dict, number, etc.) - invalid
                return null;
            }
        } catch {
            // Not valid JSON - treat as a single item
            // This handles cases like passing "Attention Is All You Need" as a single title
            return [value];
        }
    }
    
    // Any other type is invalid
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
export function getToolCallLabel(
    part: ToolCallPart,
    status: ToolCallStatus,
    opts?: ToolCallLabelOptions,
): string {
    const main = computeMainLabel(part, status, opts);
    const suffix = getToolResultLabelSuffix(opts?.view ?? null, part.tool_name);
    return suffix ? `${main}${suffix}` : main;
}

/**
 * Build the inline part of the label (base + arg-derived qualifier + headline
 * name + locator), without the view-derived count suffix. Pure: any Zotero
 * resolved names/locators arrive via `opts.enrich` / `opts.view`.
 */
function computeMainLabel(
    part: ToolCallPart,
    status: ToolCallStatus,
    opts?: ToolCallLabelOptions,
): string {
    const toolName = part.tool_name;
    const baseLabel = TOOL_BASE_LABELS[toolName] ?? 'Calling function';

    // Progress messages take precedence when present
    if (status === 'in_progress' && part.progress) {
        return `${baseLabel}: ${part.progress}`;
    }

    const args = parseArgs(part);
    const view = opts?.view ?? null;

    // Headline name (item/note/annotation tools): prefer the hydrated view, else
    // the host-resolved request-side name.
    const resolvedName = getViewDisplayName(view, toolName) ?? opts?.enrich?.itemDisplayName ?? null;
    // Actual locator from the completed view (overrides the requested range).
    const viewLocator = getViewLocationLabel(view, toolName);

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
            // Library/collection scope names are host-resolved into opts.enrich.
            const parts: string[] = [];
            const libraryParam = args.library as string | number | undefined;

            // Collection scope (host-resolved name)
            if (opts?.enrich?.collectionName) {
                parts.push(`"${opts.enrich.collectionName}"`);
            }

            // Tag parameter (pure, arg-derived)
            const tag = args.tag as string | undefined;
            if (tag) {
                parts.push(`tag "${truncate(tag, 20)}"`);
            }

            // Show library name only when no collection/tag filter and library is specified
            if (parts.length === 0 && libraryParam != null) {
                parts.push(opts?.enrich?.libraryName
                    ? `"${opts.enrich.libraryName}"`
                    : `"${libraryParam}"`);
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

        case 'search_in_attachment':
        case 'find_in_attachments': {
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

        case 'read_attachment':
        case 'read_pages': {
            const startPage = args.start_page as number | undefined;
            const endPage = args.end_page as number | undefined;

            // Requested page range from args (fallback when no completed view)
            let argRange = '';
            if (startPage !== undefined && endPage !== undefined) {
                argRange = startPage === endPage ? `p. ${startPage}` : `p. ${startPage}-${endPage}`;
            } else if (startPage !== undefined) {
                argRange = `p. ${startPage}+`;
            } else if (endPage !== undefined) {
                argRange = `p. 1-${endPage}`;
            }

            // Prefer the completed view's actual locator; the locator is shown only
            // alongside a resolved item name (never a bare page range).
            const locator = viewLocator ?? argRange;
            if (resolvedName) {
                return locator ? `${baseLabel}: ${resolvedName}, ${locator}` : `${baseLabel}: ${resolvedName}`;
            }
            return baseLabel;
        }

        case 'read': {
            const pagesArg = args.pages as string | undefined;
            const linesArg = args.lines as string | undefined;

            // Range args are contiguous 1-indexed range strings like "3" or "1-10"
            const normalizeRange = (value: string | undefined): string | null => {
                if (typeof value !== 'string') return null;
                const trimmed = value.trim();
                return /^\d+(-\d+)?$/.test(trimmed) ? trimmed : null;
            };

            const pageRangeValue = normalizeRange(pagesArg);
            const lineRangeValue = normalizeRange(linesArg);

            // Requested locator from args (fallback when no completed view).
            let argRange = '';
            if (pageRangeValue) {
                argRange = `p. ${pageRangeValue}`;
            } else if (lineRangeValue) {
                argRange = lineRangeValue.includes('-') ? `lines ${lineRangeValue}` : `line ${lineRangeValue}`;
            }

            // The completed view's actual locator wins over the requested range;
            // the locator is shown only alongside a resolved item name.
            const locator = viewLocator ?? argRange;
            if (resolvedName) {
                return locator ? `${baseLabel}: ${resolvedName}, ${locator}` : `${baseLabel}: ${resolvedName}`;
            }
            return baseLabel;
        }

        case 'view': {
            const pagesArg = args.pages as string | undefined;

            // `pages` is a contiguous 1-indexed range string like "3" or "1-5";
            // absent for image attachments.
            const pageRangeValue =
                typeof pagesArg === 'string' && /^\d+(-\d+)?$/.test(pagesArg.trim())
                    ? pagesArg.trim()
                    : null;
            const argRange = pageRangeValue ? `p. ${pageRangeValue}` : '';

            const locator = viewLocator ?? argRange;
            if (resolvedName) {
                return locator ? `${baseLabel}: ${resolvedName}, ${locator}` : `${baseLabel}: ${resolvedName}`;
            }
            return baseLabel;
        }

        // === Annotation tools ===
        case 'get_annotations': {
            if (resolvedName) {
                return `${baseLabel}: ${resolvedName}`;
            }
            return baseLabel;
        }

        case 'find_annotations': {
            // Scoped (single-source) calls headline the source name.
            if (resolvedName) {
                return `${baseLabel}: ${resolvedName}`;
            }

            const color = args.color as string | undefined;
            const annotationType = args.annotation_type as string | undefined;
            if (color || annotationType) {
                const label = [color, annotationType ? `${annotationType}s` : 'annotations']
                    .filter(Boolean)
                    .join(' ');
                return `${baseLabel}: ${truncate(label, 40)}`;
            }

            const tag = args.tag as string | undefined;
            if (tag) {
                return `${baseLabel}: tagged "${truncate(tag, 30)}"`;
            }

            const text = args.text_contains as string | undefined;
            if (text) {
                return `${baseLabel}: "${truncate(text, 40)}"`;
            }

            const collection = args.collection as string | undefined;
            if (collection) {
                return `${baseLabel}: ${truncate(collection, 40)}`;
            }

            return baseLabel;
        }

        // === Extract tool ===
        case 'extract': {
            const attachmentIds = args.attachment_ids as string[] | undefined;
            const count = Array.isArray(attachmentIds) ? attachmentIds.length : 0;
            const label = args.label as string | undefined;
            if (label) {
                return `${baseLabel}: ${truncate(label, 60)}`;
            }
            if (count > 0) {
                return `${baseLabel}: ${count} paper${count === 1 ? '' : 's'}`;
            }
            return baseLabel;
        }

        // === External search tools ===
        case 'external_search': {
            const searchLabel = args.search_label as string | undefined;
            const query = args.query as string | undefined;
            const label = searchLabel || (query ? truncate(query, 60) : null);
            if (label) {
                return `${baseLabel}: ${label}`;
            }
            return baseLabel;
        }

        case 'lookup_work': {
            // Normalize list parameters (handles JSON strings like "['title']")
            const identifiers = normalizeListParam(args.identifiers);
            const titles = normalizeListParam(args.titles);
            
            // Handle old singular parameter formats
            const identifier = args.identifier as string | undefined;
            const title = args.title as string | undefined;
            
            // Check for invalid parameters
            const hasInvalidIdentifiers = args.identifiers !== undefined && identifiers === null;
            const hasInvalidTitles = args.titles !== undefined && titles === null;
            if (hasInvalidIdentifiers || hasInvalidTitles) {
                return `${baseLabel}: Invalid query`;
            }
            
            // Count total queries
            const idCount = identifiers?.length ?? (identifier ? 1 : 0);
            const titleCount = titles?.length ?? (title ? 1 : 0);
            const totalCount = idCount + titleCount;
            
            // Single item lookup: show the identifier or title
            if (totalCount === 1) {
                const singleLabel = identifier || title || identifiers?.[0] || titles?.[0];
                if (singleLabel) {
                    return `${baseLabel}: ${truncate(singleLabel, 40)}`;
                }
            }
            
            // Multiple items: show query count while the lookup is running
            if (totalCount > 1) {
                return status === 'completed'
                    ? baseLabel
                    : `${baseLabel}: ${totalCount} queries`;
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

            const parentKey = args.parent_collection as string | undefined;
            if (parentKey) {
                if (opts?.enrich?.collectionName) {
                    return `${baseLabel} in "${opts.enrich.collectionName}"`;
                }
                return `${baseLabel}: subcollections`;
            }

            // Show library name when listing top-level collections
            if (libraryParam != null) {
                return opts?.enrich?.libraryName
                    ? `${baseLabel}: "${opts.enrich.libraryName}"`
                    : `${baseLabel}: "${libraryParam}"`;
            }
            return `${baseLabel}`;
        }

        case 'list_tags': {
            const libraryParam = args.library as string | number | undefined;

            const collectionKey = args.collection_key as string | undefined;
            if (collectionKey) {
                if (opts?.enrich?.collectionName) {
                    return `${baseLabel} in "${opts.enrich.collectionName}"`;
                }
                return `${baseLabel} in collection`;
            }

            // Show library name when listing all tags in a library
            if (libraryParam != null) {
                return opts?.enrich?.libraryName
                    ? `${baseLabel}: "${opts.enrich.libraryName}"`
                    : `${baseLabel}: "${libraryParam}"`;
            }
            return `${baseLabel}`;
        }

        case 'manage_tags': {
            const tag = args.tag as string | undefined;
            if (tag) {
                return `${baseLabel}: "${truncate(tag, 20)}"`;
            }
            return baseLabel;
        }

        case 'manage_collections': {
            const collection = args.collection as string | undefined;
            if (collection) {
                return `${baseLabel}: "${truncate(collection, 20)}"`;
            }
            return baseLabel;
        }

        // === Note tools ===
        case 'read_note': {
            // resolvedName is the note title (from the view, or host-resolved).
            if (resolvedName) {
                return `${baseLabel}: "${truncate(resolvedName, 30)}"`;
            }
            return baseLabel;
        }

        // === Tool results ===
        case 'load_tool_results': {
            return baseLabel;
        }

        // Progressive disclosure tools
        case 'load_capability': {
            // args.id is the capability id (e.g. "library-management").
            const id = args.id as string | undefined;
            if (id) {
                const pretty = SKILL_NAME_LABELS[id]
                    || id.replace(/-/g, ' ').split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
                return `${baseLabel}: ${truncate(pretty, 30)}`;
            }
            return baseLabel;
        }

        case 'search_tools': {
            // args.queries is a list of strings (older builds used args.keywords).
            const queries = normalizeListParam(args.queries)
                ?? (typeof args.keywords === 'string' ? [args.keywords] : null);
            if (queries && queries[0]) {
                return `${baseLabel}: "${truncate(queries[0], 40)}"`;
            }
            return baseLabel;
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
