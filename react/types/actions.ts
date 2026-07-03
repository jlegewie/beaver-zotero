/**
 * Actions V2.0 — Type definitions
 *
 * Replaces the old `CustomPrompt` type with a richer model that supports
 * a two-layer architecture (built-in actions + user overrides) and a
 * target system instead of the boolean `requiresAttachment`.
 *
 * An action declares the kinds of context it accepts via `targets` (a set of
 * target types). Visibility is an OR over the set: the action shows whenever
 * at least one eligible item of an accepted kind is in context. At invocation
 * a single *resolved* target type is chosen by the entry point (slash-menu
 * group, context menu, launcher) and carried on the pill / wire — the list
 * exists only at the declaration layer.
 *
 * Stored data may still use the legacy single `targetType` field; readers
 * normalize via `normalizeStoredAction` / `normalizeStoredOverride` and
 * writers persist the `targets` shape.
 */

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

export type ActionTargetType = "items" | "attachment" | "note" | "collection" | "global";

/**
 * Skill category for the homepage launcher. Orthogonal to `targets`:
 * `targets` is what an action binds to; `category` is what kind of work it is.
 * An action can have both, independently.
 */
export type ActionCategory = "research" | "write" | "organize" | "annotate";

/** Category filter for the Actions preferences list — a skill category, or the "no category" bucket. */
export type ActionCategoryFilter = ActionCategory | "uncategorized";

export interface Action {
    id: string;                    // "builtin-*" for built-ins, crypto.randomUUID() for user
    title: string;                 // Max 45 chars
    text: string;                  // Prompt template with {{variables}}
    name?: string;                 // Slash-command name (no whitespace); unset or "" → derived from title ("" marks an explicitly cleared name so it survives JSON overrides)
    id_model?: string;
    /** Target kinds this action accepts (non-empty). `global` should be the
     *  sole entry when present — "works anywhere" doesn't combine. */
    targets: ActionTargetType[];
    category?: ActionCategory;     // Skill grouping for the homepage launcher (independent of targets)
    argumentHint?: string;         // Hint shown during autocomplete to indicate expected arguments
    sortOrder?: number;            // Lower = higher in list
    deprecated?: boolean;          // For phasing out built-ins
    lastUsed?: string;             // Runtime-only, merged from separate pref
}

/**
 * Surgical override for a built-in action. Only changed fields are stored.
 * `targets` replaces the base list wholesale when set.
 */
export interface ActionOverride {
    hidden?: boolean;
    title?: string;
    text?: string;
    name?: string;
    id_model?: string;
    targets?: ActionTargetType[];
    category?: ActionCategory;
    argumentHint?: string;
    sortOrder?: number;
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
    global: "Works anywhere, no context needed",
    items: "Works with library items",
    attachment: "Works with PDF, EPUB, and snapshot attachments",
    note: "Works with Zotero notes",
    collection: "Works with collections",
};

/** User-facing labels for the homepage skill categories. */
export const CATEGORY_LABELS: Record<ActionCategory, string> = {
    research: "Research",
    write: "Write",
    organize: "Organize",
    annotate: "Annotate",
};

// ---------------------------------------------------------------------------
// Target presets — the curated target sets offered in the preferences UI.
// The data model supports arbitrary sets; the picker only offers these.
// ---------------------------------------------------------------------------

export interface TargetPreset {
    id: string;
    label: string;
    description: string;
    targets: ActionTargetType[];
}

export const TARGET_PRESETS: TargetPreset[] = [
    { id: "global", label: "General", description: "Works anywhere, no context needed", targets: ["global"] },
    { id: "items", label: "Item", description: "Works with library items", targets: ["items"] },
    { id: "attachment", label: "Attachment", description: "Works with PDF, EPUB, and snapshot attachments", targets: ["attachment"] },
    { id: "items-attachment", label: "Item or attachment", description: "Works with library items and file attachments", targets: ["items", "attachment"] },
    { id: "note", label: "Note", description: "Works with Zotero notes", targets: ["note"] },
    { id: "collection", label: "Collection", description: "Works with collections", targets: ["collection"] },
];

/** Order-insensitive equality of two target sets. */
export const sameTargets = (a: ActionTargetType[], b: ActionTargetType[]): boolean =>
    a.length === b.length && a.every(t => b.includes(t));

/** The preset matching a target set (order-insensitive), if any. */
export const findTargetPreset = (targets: ActionTargetType[]): TargetPreset | undefined =>
    TARGET_PRESETS.find(p => sameTargets(p.targets, targets));

/** Display label for a target set: the preset label, or the joined kind labels
 *  for a custom (hand-edited) set. */
export const targetsLabel = (targets: ActionTargetType[]): string =>
    findTargetPreset(targets)?.label ?? targets.map(t => TARGET_TYPE_LABELS[t]).join(" or ");

/** Description for a target set: the preset description, or the primary
 *  kind's description for a custom set. */
export const targetsDescription = (targets: ActionTargetType[]): string =>
    findTargetPreset(targets)?.description ?? TARGET_TYPE_DESCRIPTIONS[targets[0]];

// ---------------------------------------------------------------------------
// Validators & normalization
//
// Stored actions/overrides come in two shapes: the current `targets` array
// and the legacy single `targetType` string (older versions also stored a
// `minItems` number, which is dropped). Readers accept both and normalize;
// writers always persist `targets`.
// ---------------------------------------------------------------------------

const VALID_TARGET_TYPES: Set<string> = new Set(["items", "attachment", "note", "collection", "global"]);
const VALID_CATEGORIES: Set<string> = new Set(["research", "write", "organize", "annotate"]);

const isValidTargetsArray = (value: unknown): value is ActionTargetType[] =>
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(t => typeof t === 'string' && VALID_TARGET_TYPES.has(t));

/** Accepts either shape of a stored action (current `targets` or legacy `targetType`). */
export const isStoredAction = (obj: unknown): boolean => {
    if (typeof obj !== 'object' || obj === null) return false;
    const o = obj as Record<string, unknown>;
    const hasValidTargets = isValidTargetsArray(o.targets) ||
        (typeof o.targetType === 'string' && VALID_TARGET_TYPES.has(o.targetType));
    return (
        typeof o.id === 'string' &&
        typeof o.title === 'string' &&
        typeof o.text === 'string' &&
        hasValidTargets &&
        (o.category === undefined || (typeof o.category === 'string' && VALID_CATEGORIES.has(o.category as string))) &&
        (o.name === undefined || (typeof o.name === 'string' && !/\s/.test(o.name))) &&
        (o.argumentHint === undefined || typeof o.argumentHint === 'string') &&
        (o.id_model === undefined || typeof o.id_model === 'string') &&
        (o.sortOrder === undefined || typeof o.sortOrder === 'number') &&
        (o.deprecated === undefined || typeof o.deprecated === 'boolean') &&
        (o.lastUsed === undefined || typeof o.lastUsed === 'string')
    );
};

/** Normalize a stored action (either shape) to the current `targets` shape.
 *  Call only after `isStoredAction` has validated the value. */
export const normalizeStoredAction = (raw: Record<string, unknown>): Action => {
    const { targetType, minItems: _minItems, targets, ...rest } = raw as Record<string, unknown> & {
        targetType?: ActionTargetType;
        minItems?: number;
        targets?: ActionTargetType[];
    };
    return {
        ...(rest as unknown as Omit<Action, 'targets'>),
        targets: isValidTargetsArray(targets) ? targets : [targetType as ActionTargetType],
    };
};

/** Normalize a stored override: legacy `targetType` becomes `targets`,
 *  legacy `minItems` is dropped. Unknown target values are ignored. */
export const normalizeStoredOverride = (raw: ActionOverride & { targetType?: string; minItems?: number }): ActionOverride => {
    const { targetType, minItems: _minItems, targets, ...rest } = raw;
    const normalized: ActionOverride = { ...rest };
    if (isValidTargetsArray(targets)) {
        normalized.targets = targets;
    } else if (typeof targetType === 'string' && VALID_TARGET_TYPES.has(targetType)) {
        normalized.targets = [targetType as ActionTargetType];
    }
    return normalized;
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
