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

export interface Action {
    id: string;                    // "builtin-*" for built-ins, crypto.randomUUID() for user
    title: string;                 // Max 45 chars
    text: string;                  // Prompt template with {{variables}}
    id_model?: string;
    targetType: ActionTargetType;
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
    attachment: "PDF",
    note: "Note",
    collection: "Collection",
    global: "Global",
};

export const TARGET_TYPE_DESCRIPTIONS: Record<ActionTargetType, string> = {
    items: "Requires one or more selected items",
    attachment: "Requires a PDF attachment",
    note: "Requires a note to be open",
    collection: "Requires a collection to be selected",
    global: "Available everywhere",
};

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

const VALID_TARGET_TYPES: Set<string> = new Set(["items", "attachment", "note", "collection", "global"]);

export const isAction = (obj: unknown): obj is Action => {
    if (typeof obj !== 'object' || obj === null) return false;
    const o = obj as Record<string, unknown>;
    return (
        typeof o.id === 'string' &&
        typeof o.title === 'string' &&
        typeof o.text === 'string' &&
        typeof o.targetType === 'string' &&
        VALID_TARGET_TYPES.has(o.targetType as string) &&
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
