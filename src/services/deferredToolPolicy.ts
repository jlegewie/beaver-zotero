import { logger } from '@beaver/agent-core/platform/logger';
import { getPref } from '../utils/prefs';
export const DEFAULT_DEFERRED_TOOL_GROUPS: Record<string, string> = {
    edit_metadata: 'metadata_edits',
    edit_item: 'metadata_edits',
    edit_note: 'note_edits',
    edit_note_batch: 'note_edits',
    // A rewrite that discards or replaces most of a note gets its own group, so
    // approving note edits never carries one with it. Classification happens in
    // validation (see noteRewriteRisk.ts) — it is the only step holding both the
    // live note and the payload — and rides along on the action data as
    // `destructive_rewrite` so later approval steps, which only ever see the
    // `edit_note_batch` action type, classify it the same way. Like annotation
    // deletion this has no Preferences row on purpose: with nothing to persist a
    // preference against it always resolves to `always_ask`, so "apply note
    // edits automatically" cannot reach it.
    destructive_note_rewrite: 'note_rewrite',
    create_note: 'note_creation',
    create_collection: 'library_modifications',
    organize_items: 'library_modifications',
    manage_tags: 'library_structure',
    manage_collections: 'library_structure',
    create_highlight_annotations: 'annotations',
    create_note_annotations: 'annotations',
    edit_annotations: 'annotations',
    // Deletion is its own group so approving annotation edits never carries
    // deletions with it. It has no editable Preferences row on purpose, so the
    // normal UI always asks unless the user grants deletion for the current
    // run. A manually configured underlying group preference is still read.
    delete_annotations: 'annotation_deletion',
    create_item: 'create_items',
    create_items: 'create_items',
};

/**
 * AgentAction aliases used only when authorizing or matching run approvals.
 * Keeping these out of DEFAULT_DEFERRED_TOOL_GROUPS prevents action-record
 * names from silently acquiring persistent preference defaults.
 */
export const RUN_APPROVAL_ACTION_TYPE_ALIASES: Record<string, string> = {
    zotero_note: 'note_creation',
    highlight_annotation: 'annotations',
    note_annotation: 'annotations',
};

export type DeferredToolPreference = 'always_ask' | 'always_apply' | 'continue_without_applying';

export interface DeferredToolPreferencesData {
    /** Maps tool names to group names */
    toolToGroup: Record<string, string>;
    /** Maps group names to preference values */
    groupPreferences: Record<string, DeferredToolPreference>;
}

// Default preferences for groups
const DEFAULT_GROUP_PREFERENCES: Record<string, DeferredToolPreference> = {
    'metadata_edits': 'always_ask',
    'note_edits': 'always_ask',
    'note_creation': 'always_apply',
    'library_modifications': 'always_ask',
    'library_structure': 'always_ask',
    'annotations': 'always_ask',
    'create_items': 'always_ask',
};

export function loadPreferences(): DeferredToolPreferencesData {
    try {
        const prefString = getPref('deferredToolPreferences');
        if (prefString && typeof prefString === 'string') {
            const parsed = JSON.parse(prefString);
            const storedToolToGroup = { ...(parsed.toolToGroup ?? {}) };
            // Older versions persisted the full run-authorization alias map.
            // Strip those action-record names so they cannot acquire a
            // preference merely by being authorization aliases.
            for (const actionType of Object.keys(RUN_APPROVAL_ACTION_TYPE_ALIASES)) {
                delete storedToolToGroup[actionType];
            }
            // Deletion moved out of the shared annotations preference group.
            // A persisted mapping from an older profile must not override the
            // new safety boundary and turn annotations=always_apply into an
            // implicit standing grant to delete annotations.
            delete storedToolToGroup.delete_annotations;
            return {
                toolToGroup: { ...DEFAULT_DEFERRED_TOOL_GROUPS, ...storedToolToGroup },
                groupPreferences: { ...DEFAULT_GROUP_PREFERENCES, ...parsed.groupPreferences },
            };
        }
    } catch (error) {
        logger(`deferredToolPreferences: Failed to load preferences: ${error}`, 1);
    }
    return {
        toolToGroup: { ...DEFAULT_DEFERRED_TOOL_GROUPS },
        groupPreferences: { ...DEFAULT_GROUP_PREFERENCES },
    };
}

