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

import type { BeaverClientType } from "../protocol/agentProtocol";

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

export type ActionTargetType = "items" | "attachment" | "note" | "collection" | "global";

/**
 * Clients an action can run in. An action is only usable in a client listed
 * here (or in any client when the field is absent — the default).
 *
 * Spelled with the same identifiers as the handshake's `client_type` rather
 * than a vocabulary of its own, so one client id means one thing everywhere.
 */
export type ActionClient = BeaverClientType;

/**
 * Defaults to the Zotero plugin so that a bundle which never registers still
 * reports the right client for it — the Zotero plugin has always been this
 * value, and a forgotten registration must not change its behavior. Every other
 * host has to register: running as, say, the Word add-in while reporting
 * `zotero-plugin` would show the user actions their client cannot execute.
 */
const DEFAULT_ACTION_CLIENT: ActionClient = "zotero-plugin";

let actionClient: ActionClient = DEFAULT_ACTION_CLIENT;

/**
 * Register the client this build runs as. Call once at host bundle init, before
 * any action is imported or exported.
 *
 * Each bundle carries its own copy of this module state (the Zotero plugin
 * ships two: esbuild and webpack), so a host with more than one bundle must
 * register in each of them.
 */
export function setActionClient(client: ActionClient): void {
    actionClient = client;
}

/** The client this build runs as. Used to gate imported/shared actions. */
export function getActionClient(): ActionClient {
    return actionClient;
}

/**
 * Categories this build has a dedicated label/icon for. Not the legal set —
 * see {@link ActionCategory}.
 */
export const KNOWN_ACTION_CATEGORIES = ["research", "write", "organize", "annotate"] as const;

/** A category this build renders with a dedicated label and icon. */
export type KnownActionCategory = (typeof KNOWN_ACTION_CATEGORIES)[number];

/**
 * Skill category for the homepage launcher. Orthogonal to `targets`:
 * `targets` is what an action binds to; `category` is what kind of work it is.
 *
 * Open vocabulary: any non-empty string is legal. Unknown values are stored
 * and rendered with a generic label/icon — rejecting them would drop the
 * action on the next save. `string & {}` keeps autocomplete for known values.
 */
export type ActionCategory = KnownActionCategory | (string & {});

/**
 * Filter value for "has no category". Empty string so it cannot collide with a
 * real category (those are non-empty). Falsy — pass it with `??`, not `||`.
 * Don't replace this with a word like `"uncategorized"`: that is a legal category.
 */
export const UNCATEGORIZED_FILTER = "";

/** Category filter for the Actions preferences list — a skill category, or the "no category" bucket. */
export type ActionCategoryFilter = ActionCategory | typeof UNCATEGORIZED_FILTER;

/** Blank (including {@link UNCATEGORIZED_FILTER}) → undefined. */
const storedCategory = (value: unknown): ActionCategory | undefined =>
    typeof value === "string" && value.trim().length > 0 ? value : undefined;

export interface Action {
    id: string;                    // "builtin-*" for built-ins, crypto.randomUUID() for user
    title: string;                 // Max 45 chars
    text: string;                  // Prompt template with {{variables}}
    description?: string;          // Short human-facing summary, shown in the /command chip hover card
    name?: string;                 // Slash-command name (no whitespace); unset or "" → derived from title ("" marks an explicitly cleared name so it survives JSON overrides)
    id_model?: string;
    /** Target kinds this action accepts (non-empty). `global` should be the
     *  sole entry when present — "works anywhere" doesn't combine. */
    targets: ActionTargetType[];
    /** Clients this action supports. Absent → runs in any client. */
    client?: ActionClient[];
    category?: ActionCategory;     // Skill grouping for the homepage launcher (independent of targets)
    argumentHint?: string;         // Hint shown during autocomplete to indicate expected arguments
    sortOrder?: number;            // Lower = higher in list
    deprecated?: boolean;          // For phasing out built-ins
    lastUsed?: string;             // Runtime-only, merged from separate pref
    /** Built-in-only, code-defined: a locked action is read-only in the UI
     *  (no field edits, no delete/reset). It is never user-settable — not
     *  surfaced in the editor, the override model, or the share schema — and is
     *  stripped from custom actions on save. Duplicating a locked action yields
     *  an unlocked, editable copy. Defaults to unlocked when absent. */
    locked?: boolean;
}

/**
 * Surgical override for a built-in. Only changed fields are stored.
 * `targets` replaces the base list wholesale when set.
 *
 * Absent vs cleared: absent means use the shipped value; `null` means the user
 * removed it. Other fields use `""` for that; category cannot (`""` is not a
 * category). Merges must coerce `null` to undefined so it never lands on Action.
 */
export interface ActionOverride {
    hidden?: boolean;
    title?: string;
    text?: string;
    description?: string;
    name?: string;
    id_model?: string;
    targets?: ActionTargetType[];
    category?: ActionCategory | null;
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
    global: "Anywhere",
};

export const TARGET_TYPE_DESCRIPTIONS: Record<ActionTargetType, string> = {
    global: "Works anywhere, no context needed",
    items: "Works with library items",
    attachment: "Works with PDF, EPUB, and snapshot attachments",
    note: "Works with Zotero notes",
    collection: "Works with collections",
};

/** Labels for known categories. Not exhaustive — use {@link categoryLabel}. */
export const CATEGORY_LABELS: Record<string, string | undefined> = {
    research: "Research",
    write: "Write",
    organize: "Organize",
    annotate: "Annotate",
} satisfies Record<KnownActionCategory, string>;

/**
 * Map, not object: category is any string, and `{}.constructor` is a function
 * (inherited), so `labels[category] ?? fallback` would return that function.
 * Every lookup keyed by a category value must go through a Map.
 */
const CATEGORY_LABEL_LOOKUP = new Map<string, string>(
    Object.entries(CATEGORY_LABELS).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
    ),
);

/** Title-case an unfamiliar category id ("deep-research" → "Deep Research"). */
const titleCaseCategory = (category: string): string =>
    category
        .split(/[-_\s]+/)
        .filter(word => word.length > 0)
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");

/** Known label, title-cased id for unknown categories, or "Uncategorized". */
export const categoryLabel = (category: ActionCategory | undefined): string => {
    if (!category) return "Uncategorized";
    return CATEGORY_LABEL_LOOKUP.get(category) ?? titleCaseCategory(category);
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
    { id: "global", label: "Anywhere", description: "Works anywhere, no context needed", targets: ["global"] },
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

/** Shape only. Rejecting an unknown value would drop the action on save. */
const isValidCategory = (value: unknown): boolean =>
    typeof value === 'string' && value.trim().length > 0;

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
        (o.description === undefined || typeof o.description === 'string') &&
        hasValidTargets &&
        (o.category === undefined || isValidCategory(o.category)) &&
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
    const { targetType, minItems: _minItems, targets, locked: _locked, ...rest } = raw as Record<string, unknown> & {
        targetType?: ActionTargetType;
        minItems?: number;
        targets?: ActionTargetType[];
        locked?: unknown;
    };
    return {
        ...(rest as unknown as Omit<Action, 'targets'>),
        // Blank is not a category — don't copy rest.category through.
        category: storedCategory((rest as { category?: unknown }).category),
        targets: isValidTargetsArray(targets) ? targets : [targetType as ActionTargetType],
    };
};

/** Normalize a stored override: legacy `targetType` becomes `targets`,
 *  legacy `minItems` is dropped. Unknown target values are ignored. */
export const normalizeStoredOverride = (raw: ActionOverride & { targetType?: string; minItems?: number }): ActionOverride => {
    const { targetType, minItems: _minItems, targets, ...rest } = raw;
    const normalized: ActionOverride = { ...rest };
    // Blank → null (cleared, beats the shipped value). Non-strings are dropped
    // without calling string methods — prefs aren't field-validated.
    const storedOverrideCategory = normalized.category;
    if (typeof storedOverrideCategory === 'string' && storedOverrideCategory.trim() === '') {
        normalized.category = null;
    } else if (
        storedOverrideCategory !== undefined &&
        storedOverrideCategory !== null &&
        typeof storedOverrideCategory !== 'string'
    ) {
        delete normalized.category;
    }
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
