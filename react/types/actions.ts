/**
 * Actions V2.0 — Type definitions
 *
 * Replaces the old `CustomPrompt` type with a richer model that supports
 * a two-layer architecture (built-in actions + user overrides) and a
 * `targetType` system instead of the boolean `requiresAttachment`.
 */

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

export type ActionTargetType = "items" | "attachment" | "note" | "collection" | "global";

/**
 * Skill category for the homepage launcher. Orthogonal to `targetType`:
 * `targetType` is what an action binds to; `category` is what kind of work it is.
 * An action can have both, independently.
 */
export type ActionCategory = "research" | "organize" | "annotate";

/** Category filter for the Actions preferences list — a skill category, or the "no category" bucket. */
export type ActionCategoryFilter = ActionCategory | "uncategorized";

export interface Action {
    id: string;                    // "builtin-*" for built-ins, crypto.randomUUID() for user
    title: string;                 // Max 45 chars
    text: string;                  // Prompt template with {{variables}}
    id_model?: string;
    targetType: ActionTargetType;
    category?: ActionCategory;     // Skill grouping for the homepage launcher (independent of targetType)
    placeholder?: string;          // Reserved for a future slash-command argument slot (currently unwired)
    minItems?: number;             // For targetType "items", default 1
    sortOrder?: number;            // Lower = higher in list
    deprecated?: boolean;          // For phasing out built-ins
    lastUsed?: string;             // Runtime-only, merged from separate pref
}

/**
 * Surgical override for a built-in action. Only changed fields are stored.
 */
export interface ActionOverride {
    hidden?: boolean;
    title?: string;
    text?: string;
    id_model?: string;
    targetType?: ActionTargetType;
    category?: ActionCategory;
    placeholder?: string;
    sortOrder?: number;
    minItems?: number;
}

/**
 * Top-level shape persisted in the `beaver.actions` preference.
 */
export interface ActionCustomizations {
    version: 1;
    overrides: Record<string, ActionOverride>;
    custom: Action[];
}

/** Map of action id → ISO timestamp, stored in `beaver.actionsLastUsed`. */
export type ActionLastUsedMap = Record<string, string>;

// ---------------------------------------------------------------------------
// Labels & descriptions for target types
// ---------------------------------------------------------------------------

export const TARGET_TYPE_LABELS: Record<ActionTargetType, string> = {
    items: "Items",
    attachment: "Attachment",
    note: "Note",
    collection: "Collection",
    global: "General",
};

export const TARGET_TYPE_DESCRIPTIONS: Record<ActionTargetType, string> = {
    items: "Works with library items",
    attachment: "Works with PDF, EPUB, and snapshot attachments",
    note: "Works with Zotero notes",
    collection: "Works with collections",
    global: "Works anywhere, no context needed",
};

/** User-facing labels for the homepage skill categories. */
export const CATEGORY_LABELS: Record<ActionCategory, string> = {
    research: "Research",
    organize: "Organize",
    annotate: "Annotate",
};

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

const VALID_TARGET_TYPES: Set<string> = new Set(["items", "attachment", "note", "collection", "global"]);
const VALID_CATEGORIES: Set<string> = new Set(["research", "organize", "annotate"]);

export const isAction = (obj: unknown): obj is Action => {
    if (typeof obj !== 'object' || obj === null) return false;
    const o = obj as Record<string, unknown>;
    return (
        typeof o.id === 'string' &&
        typeof o.title === 'string' &&
        typeof o.text === 'string' &&
        typeof o.targetType === 'string' &&
        VALID_TARGET_TYPES.has(o.targetType as string) &&
        (o.category === undefined || (typeof o.category === 'string' && VALID_CATEGORIES.has(o.category as string))) &&
        (o.placeholder === undefined || typeof o.placeholder === 'string') &&
        (o.id_model === undefined || typeof o.id_model === 'string') &&
        (o.minItems === undefined || typeof o.minItems === 'number') &&
        (o.sortOrder === undefined || typeof o.sortOrder === 'number') &&
        (o.deprecated === undefined || typeof o.deprecated === 'boolean') &&
        (o.lastUsed === undefined || typeof o.lastUsed === 'string')
    );
};

export const isActionCustomizations = (obj: unknown): obj is ActionCustomizations => {
    if (typeof obj !== 'object' || obj === null) return false;
    const o = obj as Record<string, unknown>;
    return (
        o.version === 1 &&
        typeof o.overrides === 'object' && o.overrides !== null && !Array.isArray(o.overrides) &&
        Array.isArray(o.custom)
    );
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a unique ID for a new user-created action. */
export const generateActionId = (): string => crypto.randomUUID();
