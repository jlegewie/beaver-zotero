/**
 * Shareable actions — versioned, self-contained (de)serialization.
 *
 * A single {@link Action} is exported to / imported from a small JSON envelope
 * that carries an explicit `kind` marker and a numeric `version`, so the format
 * can evolve without breaking files written by older or newer builds.
 *
 * Everything needed to read and write *every* supported version lives in THIS
 * file: the envelope shape, the per-version parsers (keyed in `VERSION_PARSERS`),
 * and the writer. To add a v2, add a `ShareableActionFileV2` interface and a
 * `parseV2` entry — nothing outside this module needs to change.
 *
 * The module is deliberately React-free and Zotero-free so it can be unit
 * tested in isolation and reused by any entry point (file export, drag & drop,
 * clipboard). Actual file I/O lives in `react/utils/actionShareFile.ts`.
 */

import type { Action, ActionCategory, ActionTargetType } from './actions';

// ---------------------------------------------------------------------------
// Format constants
// ---------------------------------------------------------------------------

/** Discriminator stamped on every exported file. */
export const SHAREABLE_ACTION_KIND = 'beaver.action' as const;

/** Current write version. Bump only when the payload shape changes. */
export const SHAREABLE_ACTION_VERSION = 1 as const;

/** File extension (without the dot) for exported actions. */
export const SHAREABLE_ACTION_FILE_EXTENSION = 'beaveraction';

// ---------------------------------------------------------------------------
// Envelope + payload shapes
// ---------------------------------------------------------------------------

/**
 * The subset of {@link Action} fields that define a shareable action. Purely
 * local/runtime fields are intentionally excluded:
 *  - `lastUsed`   — per-machine usage timestamp
 *  - `sortOrder`  — local list ordering, reassigned on import
 *  - `deprecated` — only meaningful for shipped built-ins
 */
export interface ShareableActionPayloadV1 {
    /** The author's action id. Preserved when free, regenerated on collision. */
    id: string;
    title: string;
    text: string;
    description?: string;
    /** Explicit slash-command name (no whitespace). Absent → derived from title. */
    name?: string;
    id_model?: string;
    targets: ActionTargetType[];
    category?: ActionCategory;
    argumentHint?: string;
}

/** Versioned envelope written to a `.beaveraction` file. */
export interface ShareableActionFileV1 {
    kind: typeof SHAREABLE_ACTION_KIND;
    version: 1;
    /** Free-form provenance (app name/version). Ignored on import. */
    exportedBy?: string;
    action: ShareableActionPayloadV1;
}

/** Union of every supported envelope version. */
export type ShareableActionFile = ShareableActionFileV1;

/** Result of parsing a shareable-action file. `error` is user-facing. */
export type ParseShareableActionResult =
    | { ok: true; action: Action }
    | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

/** Build the current-version envelope for an action. */
export const toShareableActionFile = (action: Action): ShareableActionFile => {
    const payload: ShareableActionPayloadV1 = {
        id: action.id,
        title: action.title,
        text: action.text,
        targets: [...action.targets],
    };
    if (action.description !== undefined) payload.description = action.description;
    if (action.name !== undefined) payload.name = action.name;
    if (action.id_model !== undefined) payload.id_model = action.id_model;
    if (action.category !== undefined) payload.category = action.category;
    if (action.argumentHint !== undefined) payload.argumentHint = action.argumentHint;

    return {
        kind: SHAREABLE_ACTION_KIND,
        version: SHAREABLE_ACTION_VERSION,
        exportedBy: 'Beaver',
        action: payload,
    };
};

/** Serialize an action to the JSON text of a `.beaveraction` file. */
export const serializeAction = (action: Action): string =>
    JSON.stringify(toShareableActionFile(action), null, 2);

// ---------------------------------------------------------------------------
// Validation helpers (self-contained — do not depend on actions.ts validators
// so this module fully owns the wire format it accepts)
// ---------------------------------------------------------------------------

const VALID_TARGET_TYPES: ReadonlySet<string> = new Set([
    'items', 'attachment', 'note', 'collection', 'global',
]);
const VALID_CATEGORIES: ReadonlySet<string> = new Set([
    'research', 'write', 'organize', 'annotate',
]);

const isNonEmptyString = (v: unknown): v is string =>
    typeof v === 'string' && v.trim().length > 0;

const isOptionalString = (v: unknown): boolean =>
    v === undefined || typeof v === 'string';

// ---------------------------------------------------------------------------
// Per-version parsers
// ---------------------------------------------------------------------------

type VersionParser = (envelope: Record<string, unknown>) => ParseShareableActionResult;

const parseV1: VersionParser = (envelope) => {
    const raw = envelope.action;
    if (typeof raw !== 'object' || raw === null) {
        return { ok: false, error: 'The action data is missing or malformed.' };
    }
    const a = raw as Record<string, unknown>;

    if (!isNonEmptyString(a.title)) {
        return { ok: false, error: 'The action is missing a title.' };
    }
    if (!isNonEmptyString(a.text)) {
        return { ok: false, error: 'The action is missing a prompt.' };
    }
    if (
        !Array.isArray(a.targets) ||
        a.targets.length === 0 ||
        !a.targets.every(t => typeof t === 'string' && VALID_TARGET_TYPES.has(t))
    ) {
        return { ok: false, error: 'The action does not target anything Beaver recognizes.' };
    }
    if (a.category !== undefined && !(typeof a.category === 'string' && VALID_CATEGORIES.has(a.category))) {
        return { ok: false, error: 'The action has an unknown category.' };
    }
    if (
        !isOptionalString(a.description) ||
        !isOptionalString(a.name) ||
        !isOptionalString(a.id_model) ||
        !isOptionalString(a.argumentHint)
    ) {
        return { ok: false, error: 'The action has malformed fields.' };
    }
    if (typeof a.name === 'string' && /\s/.test(a.name)) {
        return { ok: false, error: 'The action\'s slash command cannot contain whitespace.' };
    }

    // Build a clean Action. The id is carried through as-is (may be empty);
    // conflict resolution is the importer's responsibility, not the parser's.
    const action: Action = {
        id: typeof a.id === 'string' ? a.id : '',
        title: a.title,
        text: a.text,
        targets: a.targets as ActionTargetType[],
    };
    if (a.description !== undefined) action.description = a.description as string;
    if (a.name !== undefined) action.name = a.name as string;
    if (a.id_model !== undefined) action.id_model = a.id_model as string;
    if (a.category !== undefined) action.category = a.category as ActionCategory;
    if (a.argumentHint !== undefined) action.argumentHint = a.argumentHint as string;

    return { ok: true, action };
};

/** Every version Beaver can read. Add new versions here. */
const VERSION_PARSERS: Record<number, VersionParser> = {
    1: parseV1,
};

/** The highest version this build understands (for messaging). */
const MAX_SUPPORTED_VERSION = Math.max(...Object.keys(VERSION_PARSERS).map(Number));

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

/**
 * Parse the JSON text of a `.beaveraction` file into an {@link Action}.
 * Never throws; malformed input yields a user-facing `error`.
 */
export const parseShareableAction = (json: string): ParseShareableActionResult => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch {
        return { ok: false, error: 'This file is not valid JSON.' };
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { ok: false, error: 'This file does not contain a Beaver action.' };
    }
    const envelope = parsed as Record<string, unknown>;
    if (envelope.kind !== SHAREABLE_ACTION_KIND) {
        return { ok: false, error: 'This file is not a Beaver action.' };
    }

    const version = envelope.version;
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
        return { ok: false, error: 'This action file has no valid version.' };
    }
    const parser = VERSION_PARSERS[version];
    if (!parser) {
        return version > MAX_SUPPORTED_VERSION
            ? { ok: false, error: 'This action was exported by a newer version of Beaver. Update Beaver to import it.' }
            : { ok: false, error: `This action file version (${version}) is not supported.` };
    }
    return parser(envelope);
};
