/**
 * Actions V2.0 — Type definitions
 *
 * Replaces the old `CustomPrompt` type with a richer model that supports
 * a two-layer architecture (built-in actions + user overrides) and a
 * target system instead of the boolean `requiresAttachment`.
 *
 * An action declares the kinds of context it accepts via `targets` (a set of
 * target types). Visibility is an OR over the set: the action shows whenever
 * at least one eligible item of an accepted kind is in context, where a paper
 * and its file stand in for each other. Only `targets` decides where an action
 * appears; `category` sets its icon. At invocation a single *resolved* target
 * type is chosen by the entry point (context bar, slash-menu group, context
 * menu) and carried on the pill / wire — the list exists only at the
 * declaration layer.
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
 * What kind of work an action is. Sets its icon everywhere and, for actions
 * that work anywhere, the homepage category list it is in. Never affects
 * where an action appears: that is `targets` alone.
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
    /** Target kinds this action accepts (non-empty). `global` alongside other
     *  kinds means the action binds to a matching selection when there is one
     *  and otherwise runs with no context. */
    targets: ActionTargetType[];
    /** Clients this action supports. Absent → runs in any client. */
    client?: ActionClient[];
    category?: ActionCategory;     // Icon and homepage category list; never affects where the action appears
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

/** Order-insensitive equality of two target sets. */
export const sameTargets = (a: ActionTargetType[], b: ActionTargetType[]): boolean =>
    a.length === b.length && a.every(t => b.includes(t));

// ---------------------------------------------------------------------------
// "Applies to" — how the Actions preferences present an action's targets.
//
// When an action runs, a paper and its file stand in for each other, so the
// editor offers one "Items" choice for `items` and `attachment`, with a "needs
// the file" switch for actions that accept only attachments. Stored targets
// keep their exact shape until the user changes the choice.
// ---------------------------------------------------------------------------

export interface AppliesTo {
    items: boolean;
    /** Items only through a file (`attachment` without `items`). */
    needsFile: boolean;
    notes: boolean;
    collections: boolean;
    /** Runs with nothing selected (`global`). */
    anywhere: boolean;
}

export function appliesToFromTargets(targets: readonly ActionTargetType[]): AppliesTo {
    const acceptsItems = targets.includes('items');
    const acceptsFiles = targets.includes('attachment');
    return {
        items: acceptsItems || acceptsFiles,
        needsFile: acceptsFiles && !acceptsItems,
        notes: targets.includes('note'),
        collections: targets.includes('collection'),
        anywhere: targets.includes('global'),
    };
}

/**
 * Stored targets for an "Applies to" choice. An items choice keeps the item
 * shape of `previous` (`['items']` stays item-level); new ones accept both the
 * paper and its file. A choice with nothing checked works anywhere.
 */
export function targetsFromAppliesTo(choice: AppliesTo, previous: readonly ActionTargetType[] = []): ActionTargetType[] {
    const targets: ActionTargetType[] = [];
    if (choice.items) {
        if (choice.needsFile) targets.push('attachment');
        else if (previous.includes('items') && !previous.includes('attachment')) targets.push('items');
        else targets.push('items', 'attachment');
    }
    if (choice.notes) targets.push('note');
    if (choice.collections) targets.push('collection');
    if (choice.anywhere || targets.length === 0) targets.push('global');
    return targets;
}

/** Short label for an action's targets, e.g. "Items or collections". */
export function appliesToLabel(targets: readonly ActionTargetType[]): string {
    const choice = appliesToFromTargets(targets);
    const parts: string[] = [];
    if (choice.items) parts.push(choice.needsFile ? 'Item files' : 'Items');
    if (choice.notes) parts.push('Notes');
    if (choice.collections) parts.push('Collections');
    if (choice.anywhere) parts.push('Anywhere');
    const [first, ...rest] = parts.map((part, i) => (i === 0 ? part : part.toLowerCase()));
    if (rest.length === 0) return first ?? 'Anywhere';
    return `${[first, ...rest.slice(0, -1)].join(', ')} or ${rest[rest.length - 1]}`;
}

/** "Applies to" values the Actions preferences list can filter by. */
export type AppliesToFilter = 'items' | 'note' | 'collection' | 'global';

export const APPLIES_TO_FILTER_LABELS: Record<AppliesToFilter, string> = {
    items: 'Items',
    note: 'Notes',
    collection: 'Collections',
    global: 'Anywhere',
};

/** Whether an action shows under an "Applies to" filter. Items covers files. */
export const matchesAppliesToFilter = (targets: readonly ActionTargetType[], filter: AppliesToFilter): boolean =>
    filter === 'items' ? appliesToFromTargets(targets).items : targets.includes(filter);

/** Targets for a new action created under an "Applies to" filter. */
export const targetsForAppliesToFilter = (filter: AppliesToFilter): ActionTargetType[] =>
    targetsFromAppliesTo({
        items: filter === 'items',
        needsFile: false,
        notes: filter === 'note',
        collections: filter === 'collection',
        anywhere: filter === 'global',
    });

/** A request to pre-filter the Actions preferences list (and so the defaults
 *  of an action added there). */
export interface ActionsListFilter {
    category?: ActionCategoryFilter;
    appliesTo?: AppliesToFilter;
}

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
