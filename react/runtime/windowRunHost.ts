/**
 * A Zotero renderer as the viewer of its run session: what the session reaches
 * in the window it runs for (selections, popups and dialogs, agent actions,
 * display enrichment of stream events, and the window-side effects of a run).
 */

import type { createStore, Setter } from 'jotai';
import { logger } from '@beaver/agent-core/platform/logger';
import type { WSMissingZoteroDataEvent } from '@beaver/agent-core/protocol/agentProtocol';
import { pendingApprovalFromRequest, type PendingApproval } from '@beaver/agent-core/run-state/pendingApprovals';
import type { ZoteroItemReference } from '@beaver/agent-core/types/zotero';
import { extractZoteroReferencesFromToolCall } from '@beaver/agent-core/run-state/toolLabels';
import type { UndoConfirmResult } from '../../src/services/agentRuns/runHost';
import type { RunGate, RunViewer } from '../../src/services/agentRuns/runViewer';
import { externalReferenceItemMappingAtom, externalReferenceMappingAtom } from '@beaver/agent-core/citations/externalReferences';
import { isSidebarVisibleAtom } from '../atoms/ui';
import { chatFillsAtom } from '@beaver/agent-core/run-state/tableChatFills';
import { mergePageLabelsByAttachmentIdAtom } from '@beaver/agent-core/citations/atoms';
import type { AgentRun } from '@beaver/agent-core/agents/types';
import { collectTableArtifacts } from '@beaver/agent-core/run-state/tableResults';
import { getHostWindow, tryGetWindowRuntime } from './windowRuntime';
import { selectedModelAtom } from '../atoms/models';
import { userIdAtom } from '../atoms/auth';
import { threadNavigationSeqAtom, loadThreadAtom } from '../atoms/threads';
import { mergeItemsChoicesAtom } from '../atoms/mergeItemsChoices';
import { addPopupMessageAtom } from '../utils/popupMessageUtils';
import { addWarningAtom } from '../atoms/warnings';
import { promptEditDraftsAtom } from '../atoms/promptEdits';
import { profileSyncStatusAtom, searchableLibraryIdsAtom, syncWithZoteroAtom } from '../atoms/profile';
import { triggerProfileRefresh } from '../hooks/useProfileSync';
import { recordFeatureCreditGrantAtom } from '../atoms/featureCreditRuns';
import { backendHighTokenUsageRunsAtom } from '../atoms/messageUIState';
import { maybeShowCitationTipAtom } from '../atoms/citationTip';
import { preloadPageLabelsForCitations } from '../utils/pageLabels';
import { markExternalReferenceImportedAtom } from '../atoms/externalReferences';
import { BeaverTemporaryAnnotations } from '../utils/annotationUtils';
import { leaveJobWait } from '../atoms/jobLeave';
import { dismissDiffPreview } from '../utils/noteEditorDiffPreview';
import { clearDiffPreviewNoteKey, noteLibraryIdFromActionData, updateDiffPreviewForNote } from '../utils/diffPreviewCoordinator';
import { processToolReturnResults } from '../agents/toolResultProcessing';
import { upgradeToolReturn } from '../compat/legacyToolResults';
import { loadItemDataForAgentActions, autoApplyAnnotationAgentActions } from '../utils/agentActionUtils';
import { openCreatedTable } from '../host/zotero/tables';
import { loadFullItemDataWithAllTypes, safeIsInTrash } from '../../src/utils/zoteroUtils';
import { resolveItemReference, resolveLibraryRef } from '../../src/utils/libraryIdentity';
import { agentItemFilterAsync } from '../../src/utils/agentItemSupport';
import { isAttachmentOnServer } from '../../src/utils/webAPI';
import { wasItemAddedBeforeLastSync } from '../utils/sourceUtils';
import { getAppliedPdfAnnotationCount } from '../agents/agentActionCounts';
import {
    AgentAction,
    addAgentActionsAtom,
    upsertAgentActionsAtom,
    threadAgentActionsAtom,
    recordUndeliveredActionsAtom,
    resumeUnrecordedResultsAtom,
    retryUnrecordedActionsNow,
    withUnrecordedResults,
    isAnnotationAgentAction,
    isEditAnnotationsAgentAction,
    isEditMetadataAgentAction,
    isCreateItemAgentAction,
    isItemCreatingAgentAction,
    isAnyEditNoteAgentAction,
    isImportItemAgentAction,
    isCreateCollectionAgentAction,
    isOrganizeItemsAgentAction,
    isManageTagsAgentAction,
    isManageCollectionsAgentAction,
    isEditNoteAgentAction,
    isEditNoteBatchAgentAction,
    isCreateNoteAgentAction,
    hasAppliedZoteroItem,
    hasAppliedBulkAnnotations,
    isCreateAnnotationsAgentAction,
} from '../agents/agentActions';

/** Applied actions a retry would remove, by kind, for the undo confirmation. */
interface ActionsToUndo {
    annotations: AgentAction[];
    annotationEdits: AgentAction[];
    metadataEdits: AgentAction[];
    noteEdits: AgentAction[];
    createItems: AgentAction[];
    createCollections: AgentAction[];
    organizeItems: AgentAction[];
    manageTags: AgentAction[];
    manageCollections: AgentAction[];
    createNotes: AgentAction[];
    mergeItems: AgentAction[];
}

/** Sort the applied actions among `actions` by kind; the rest are left out. */
function appliedActionsByKind(actions: AgentAction[]): ActionsToUndo {
    const applied = (isKind: (action: AgentAction) => boolean) =>
        actions.filter(action => isKind(action) && action.status === 'applied');
    return {
        annotations: actions.filter((action) =>
            (isAnnotationAgentAction(action) && hasAppliedZoteroItem(action)) ||
            (isCreateAnnotationsAgentAction(action) && hasAppliedBulkAnnotations(action))
        ),
        annotationEdits: applied(isEditAnnotationsAgentAction),
        metadataEdits: applied(isEditMetadataAgentAction),
        noteEdits: applied(isAnyEditNoteAgentAction),
        createItems: applied(isItemCreatingAgentAction),
        createCollections: applied(isCreateCollectionAgentAction),
        organizeItems: applied(isOrganizeItemsAgentAction),
        manageTags: applied(isManageTagsAgentAction),
        manageCollections: applied(isManageCollectionsAgentAction),
        createNotes: applied(isCreateNoteAgentAction),
        mergeItems: applied((action) => action.action_type === 'merge_items'),
    };
}

/**
 * Prompt user to confirm undoing applied agent actions during regeneration.
 * Shows a combined dialog listing all types of changes that will be undone.
 * Returns 'undo' to undo and regenerate, 'skip' to regenerate without undoing,
 * or 'cancel' to abort regeneration entirely.
 *
 * Table changes are never undone here: a fill's answers cost credits, and each
 * table keeps its own version history. `tablesChanged` only adds a note saying
 * so, since the dialog otherwise reads as undoing everything the response did.
 */
function confirmUndoAppliedActions(actionsInRemovedRuns: AgentAction[], removedRuns: readonly AgentRun[], win?: Window): UndoConfirmResult {
    const actions = appliedActionsByKind(actionsInRemovedRuns);
    const { annotations, annotationEdits, metadataEdits, noteEdits, createItems, createCollections, organizeItems, manageTags, manageCollections, createNotes, mergeItems } = actions;
    const totalActions = annotations.length + annotationEdits.length + metadataEdits.length +
                         noteEdits.length + createItems.length + createCollections.length + organizeItems.length +
                         manageTags.length + manageCollections.length + createNotes.length + mergeItems.length;

    if (totalActions === 0) return 'skip';
    const tablesChanged = collectTableArtifacts(removedRuns).length > 0;

    // Build a list of changes
    const changeLines: string[] = [];
    if (annotations.length > 0) {
        const annotationCount = annotations.reduce(
            (sum, action) => sum + getAppliedPdfAnnotationCount(action),
            0,
        );
        changeLines.push(`• ${annotationCount} PDF annotation${annotationCount === 1 ? '' : 's'}`);
    }
    if (annotationEdits.length > 0) {
        const annotationCount = annotationEdits.reduce((sum, action) => {
            const before = action.result_data?.before;
            const appliedRefs = action.result_data?.applied_refs;
            const count = Array.isArray(before)
                ? before.length
                : Array.isArray(appliedRefs)
                    ? appliedRefs.length
                    : 1;
            return sum + count;
        }, 0);
        changeLines.push(`• ${annotationCount} PDF annotation change${annotationCount === 1 ? '' : 's'}`);
    }
    if (metadataEdits.length > 0) {
        changeLines.push(`• ${metadataEdits.length} metadata edit${metadataEdits.length === 1 ? '' : 's'}`);
    }
    if (noteEdits.length > 0) {
        changeLines.push(`• ${noteEdits.length} note edit${noteEdits.length === 1 ? '' : 's'}`);
    }
    if (createItems.length > 0) {
        changeLines.push(`• ${createItems.length} created item${createItems.length === 1 ? '' : 's'}`);
    }
    if (createCollections.length > 0) {
        changeLines.push(`• ${createCollections.length} created collection${createCollections.length === 1 ? '' : 's'}`);
    }
    if (organizeItems.length > 0) {
        changeLines.push(`• ${organizeItems.length} organize action${organizeItems.length === 1 ? '' : 's'}`);
    }
    if (manageTags.length > 0) {
        changeLines.push(`• ${manageTags.length} tag change${manageTags.length === 1 ? '' : 's'}`);
    }
    if (manageCollections.length > 0) {
        changeLines.push(`• ${manageCollections.length} collection change${manageCollections.length === 1 ? '' : 's'}`);
    }
    if (createNotes.length > 0) {
        changeLines.push(`• ${createNotes.length} created note${createNotes.length === 1 ? '' : 's'}`);
    }
    if (mergeItems.length > 0) {
        changeLines.push(`• ${mergeItems.length} duplicate merge${mergeItems.length === 1 ? '' : 's'}`);
    }

    const title = 'Retry?';
    const tablesNote = tablesChanged
        ? '\n\nChanges to tables are kept. To go back, use Version history in the table.'
        : '';
    const message = `The following changes were applied and can be undone:\n\n${changeLines.join('\n')}${tablesNote}\n\nUndo them and retry, or retry without undoing?`;

    const buttonIndex = Zotero.Prompt.confirm({
        window: win ?? getHostWindow(),
        title,
        text: message,
        button0: 'Undo && Retry',
        // Cancel must be at button1 so Escape/dialog-close routes here
        // (Services.prompt.confirmEx returns index 1 on Esc).
        button1: Zotero.Prompt.BUTTON_TITLE_CANCEL,
        button2: 'Retry',
        defaultButton: 1,
    });

    if (buttonIndex === 0) return 'undo';
    if (buttonIndex === 2) return 'skip';
    return 'cancel';
}


// =============================================================================
// Missing Zotero Data Handling
// =============================================================================

/** Reason why an item might be missing from the backend */
type MissingItemReason =
    | 'not_found'           // Item doesn't exist in Zotero
    | 'library_unavailable' // Library is not available on this computer
    | 'in_trash'            // Item is in trash
    | 'library_not_synced'  // Library not configured to sync
    | 'filtered_from_sync'  // Doesn't pass sync filters (e.g., not a PDF)
    | 'pending_sync'        // Added after last sync
    | 'file_unavailable_locally_and_on_server' // File unavailable locally and on server
    | 'unknown';            // Unknown reason

/**
 * Determine why an item is missing from the backend.
 * Returns the most likely reason based on item status checks.
 */
async function determineMissingReason(view: Store, ref: ZoteroItemReference, userId: string | null): Promise<MissingItemReason> {
    try {
        // Get searchable libraries from store
        const searchableLibraryIds = view.get(searchableLibraryIdsAtom);
        const syncWithZotero = view.get(syncWithZoteroAtom);
        const resolvedLibraryId = resolveLibraryRef(ref);
        if (!resolvedLibraryId) {
            return 'library_unavailable';
        }

        // Check if library is searchable (synced for Pro, all local for Free)
        if (!searchableLibraryIds.includes(resolvedLibraryId)) {
            return 'library_not_synced';
        }

        // Try to get the item from Zotero
        const item = await Zotero.Items.getByLibraryAndKeyAsync(resolvedLibraryId, ref.zotero_key);
        if (!item) {
            return 'not_found';
        }

        // Load item and parent item data for proper status checks
        await Zotero.Items.loadDataTypes([item], ["primaryData"]);
        if (item.parentID) {
            const parentItem = await Zotero.Items.getAsync(item.parentID);
            if (parentItem) {
                await Zotero.Items.loadDataTypes([parentItem], ["primaryData"]);
            }
        }

        // Check if in trash
        const trashState = safeIsInTrash(item);
        if (trashState === true) {
            return 'in_trash';
        }

        // Check if the item is a kind Beaver supports and is available
        const passesAgentFilters = await agentItemFilterAsync(item);
        if (!passesAgentFilters) {
            return 'filtered_from_sync';
        }

        // Check if available locally or on server
        const availableLocallyOrOnServer = !item.isAttachment() || (await item.fileExists()) || isAttachmentOnServer(item);
        if (!availableLocallyOrOnServer) {
            return 'file_unavailable_locally_and_on_server';
        }

        // Check if pending sync (added after last sync)
        if (userId) {
            try {
                const wasAddedBeforeSync = await wasItemAddedBeforeLastSync(item, syncWithZotero, userId);
                if (!wasAddedBeforeSync) {
                    return 'pending_sync';
                }
            } catch {
                // Unable to determine pending status
            }
        }

        // If we get here and item exists but wasn't found in backend, it's unknown
        return 'unknown';
    } catch (error) {
        logger(`determineMissingReason: Error checking item ${ref.library_id}-${ref.zotero_key}: ${error}`, 1);
        return 'unknown';
    }
}

/** Human-readable messages for each missing reason */
const MISSING_REASON_MESSAGES: Record<MissingItemReason, string> = {
    not_found: 'Item not found in your Zotero library',
    library_unavailable: "Library is not available on this computer. It may be a group library you haven't joined on this device",
    in_trash: 'Item is in trash',
    library_not_synced: 'Library is not configured to sync with Beaver',
    filtered_from_sync: 'Item type not supported',
    pending_sync: 'Item was added after the last sync. Please wait for sync to complete or sync manually in settings',
    file_unavailable_locally_and_on_server: 'File is unavailable',
    unknown: `Unexpected error. Please read about <a href="${process.env.WEBAPP_BASE_URL + '/docs/trouble-file-sync'}" className="text-link">sync issues</a> in the documentation and contact support if the issue persists.`,
};

/**
 * Process missing Zotero data event and generate a warning message.
 * Determines reasons for all items and creates a warning with a list of reasons and counts.
 */
async function handleMissingZoteroData(
    view: Store,
    event: WSMissingZoteroDataEvent,
    userId: string | null,
    addWarning: (params: { run_id: string; type: string; message: string; data?: Record<string, unknown> }) => void
): Promise<void> {
    if (event.items.length === 0) return;

    // Determine reasons for each item
    const reasons = await Promise.all(
        event.items.map(async (item) => ({
            item,
            reason: await determineMissingReason(view, item, userId)
        }))
    );
    logger('handleMissingZoteroData: reasons', reasons, 1);

    // Count reasons
    const reasonCounts = new Map<MissingItemReason, number>();
    for (const { reason } of reasons) {
        reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1);
    }

    // Sort reasons by count (descending) for better readability
    const sortedReasons = Array.from(reasonCounts.entries())
        .sort((a, b) => b[1] - a[1]);

    // Determine the primary reason to show
    // Prioritize 'unknown' as it's most severe, otherwise show the most common reason
    const unknownEntry = sortedReasons.find(([reason]) => reason === 'unknown');
    const [primaryReason, primaryCount] = unknownEntry || sortedReasons[0];

    // Build user-friendly message
    const itemCount = event.items.length;
    const itemWord = itemCount === 1 ? 'attachment' : 'attachments';
    const otherCount = itemCount - primaryCount;

    let message = `Unable to process ${itemCount} ${itemWord}: ${MISSING_REASON_MESSAGES[primaryReason]}`;

    // Add count if not all items have the same reason
    if (primaryCount < itemCount) {
        message += ` (${primaryCount}/${itemCount})`;
    }

    // Mention other reasons exist without listing them all
    if (otherCount > 0) {
        message += `\n\n${otherCount} other ${itemWord} ${otherCount === 1 ? 'has a' : 'have'} different reason.`;
    }

    // Add sync documentation link if any sync-related reasons are present
    const syncRelatedReasons: MissingItemReason[] = ['pending_sync'];
    const hasSyncRelatedReason = sortedReasons.some(([reason]) => syncRelatedReasons.includes(reason));
    if (hasSyncRelatedReason) {
        const syncDocUrl = process.env.WEBAPP_BASE_URL + '/docs/trouble-file-sync';
        message += `\n\n<a href="${syncDocUrl}" className="text-link">Learn more</a> about fixing sync issues.`;
    }

    // Add warning
    addWarning({
        run_id: event.run_id,
        type: 'missing_zotero_data',
        message,
        data: {
            items: event.items,
            reason_counts: Object.fromEntries(reasonCounts),
        },
    });
}

type Store = ReturnType<typeof createStore>;

/**
 * Show the session's pending edits of the notes `approvals` target in the note
 * editor, once per note. A target may be named portably only, so its library
 * is resolved rather than read off the numeric id.
 */
function refreshNotePreviews(approvals: readonly PendingApproval[]): void {
    const notes = new Map<string, { libraryId: number; zoteroKey: string }>();
    for (const approval of approvals) {
        if (approval.actionType !== 'edit_note' && approval.actionType !== 'edit_note_batch') continue;
        const libraryId = noteLibraryIdFromActionData(approval.actionData);
        const zoteroKey = approval.actionData?.zotero_key;
        if (libraryId == null || !zoteroKey) continue;
        notes.set(`${libraryId}-${zoteroKey}`, { libraryId, zoteroKey });
    }
    for (const { libraryId, zoteroKey } of notes.values()) updateDiffPreviewForNote(libraryId, zoteroKey);
}

/** The renderer whose store is `view`, as the viewer of its run session. */
export function createWindowRunViewer(view: Store): RunViewer {
    /**
     * The window's setter, behind a run's gate: each write happens only while
     * that run still owns the chat.
     */
    const windowSet = (gate: RunGate): Setter => ((...args: Parameters<Setter>) => {
        let result: unknown;
        gate(() => { result = (view.set as Setter)(...args); });
        return result;
    }) as Setter;
    return {
        hostWindow: () => {
            const runtime = tryGetWindowRuntime(true);
            return runtime && !runtime.hostWindow.closed ? runtime.hostWindow : null;
        },
        sidebarVisible: () => view.get(isSidebarVisibleAtom) === true,
        getModel: () => view.get(selectedModelAtom),
        getUserId: () => view.get(userIdAtom),
        navigationSeq: () => view.get(threadNavigationSeqAtom),
        actionChanges: (actionId: string) => view.get(mergeItemsChoicesAtom)[actionId],
        agentActions: () => view.get(threadAgentActionsAtom),
        chatFillSnapshot: (jobId: string) => view.get(chatFillsAtom).get(jobId)?.snapshot,
        externalReferences: () => ({
            externalRefs: view.get(externalReferenceMappingAtom),
            externalItemMapping: view.get(externalReferenceItemMappingAtom),
        }),

        notify: (gate, notice) => windowSet(gate)(addPopupMessageAtom, notice),
        addWarning: (gate, warning) => windowSet(gate)(addWarningAtom, warning),
        reportMissingZoteroData: (gate, event) => {
            handleMissingZoteroData(
                view,
                event,
                view.get(userIdAtom),
                (params) => windowSet(gate)(addWarningAtom, params),
            ).catch(err =>
                logger(`WS onMissingZoteroData: Failed to handle missing data: ${err}`, 1)
            );
        },
        confirmUndo: (actions, removedRuns, win) => confirmUndoAppliedActions(actions, removedRuns, win),

        approvalRequested: (event) => refreshNotePreviews([pendingApprovalFromRequest(event)]),
        approvalsRemoved: (removed) => refreshNotePreviews(removed),
        approvalsCleared: () => {
            dismissDiffPreview();
            clearDiffPreviewNoteKey();
        },
        dismissDiffPreview: () => dismissDiffPreview(),
        reloadThread: (threadId, userId) =>
            view.set(loadThreadAtom, { user_id: userId, threadId, preserveDraft: true }),
        dropPromptEditDrafts: (gate, runIds) => {
            windowSet(gate)(promptEditDraftsAtom, (prev) => {
                const next = { ...prev };
                let changed = false;
                for (const id of runIds) {
                    if (id in next) {
                        delete next[id];
                        changed = true;
                    }
                }
                return changed ? next : prev;
            });
        },
        backendReachable: () => {
            // If the profile sync was stuck in transient/fatal (and its retry
            // backoff or the OS online event hasn't cleared it), force a
            // refresh so the header indicator drops promptly instead of
            // lingering until the next backoff tick.
            if (view.get(profileSyncStatusAtom).kind !== 'ok') {
                triggerProfileRefresh();
            }
            // Re-send acknowledgements of applied actions the server has yet to record.
            retryUnrecordedActionsNow();
        },
        recordFeatureCredit: (gate, grant) => windowSet(gate)(recordFeatureCreditGrantAtom, grant),
        markHighTokenUsage: (gate, runId) =>
            windowSet(gate)(backendHighTokenUsageRunsAtom, (prev) => ({ ...prev, [runId]: true })),
        citationsChanged: (gate) => windowSet(gate)(maybeShowCitationTipAtom),
        preloadPageLabels: (citations) => preloadPageLabelsForCitations(citations),
        mergePageLabels: (labels) => view.set(mergePageLabelsByAttachmentIdAtom, labels),
        markExternalReferenceImported: (gate, externalId, ref: ZoteroItemReference) =>
            windowSet(gate)(markExternalReferenceImportedAtom, externalId, ref),
        cleanupTemporaryAnnotations: async (logPrefix) => {
            // Reader-only citation highlights go before the runs that created them.
            try {
                await BeaverTemporaryAnnotations.cleanupAll();
            } catch (error) {
                logger(`${logPrefix}: Error cleaning up temporary annotations: ${error}`);
            }
        },
        leaveJobWaitOnClose: () => leaveJobWait({ closing: tryGetWindowRuntime(true)?.hostWindow ?? null }),

        addAgentActions: (gate, actions) => windowSet(gate)(addAgentActionsAtom, actions),
        upsertAgentActions: (gate, actions) => windowSet(gate)(upsertAgentActionsAtom, actions),
        removeRunActions: (gate, runIds) =>
            windowSet(gate)(threadAgentActionsAtom, (prev) => prev.filter((action) => !runIds.includes(action.run_id))),
        replaceAgentActions: (gate, actions, runIds) => gate(() => {
            view.set(threadAgentActionsAtom, withUnrecordedResults(view.get, view.set, actions, runIds));
            view.set(resumeUnrecordedResultsAtom);
        }),
        // Whether or not the run still owns the chat.
        recordUndeliveredActions: (info, revocationsAtRunStart) =>
            void view.set(recordUndeliveredActionsAtom, info, revocationsAtRunStart),

        enrichToolCall: (part) => {
            const itemReferences = extractZoteroReferencesFromToolCall(part);
            if (itemReferences.length === 0) return undefined;
            logger(`WS onPart: Loading ${itemReferences.length} item data for tool call`, 1);
            return (async () => {
                const itemPromises = itemReferences.map(async ref => {
                    const resolved = await resolveItemReference(ref);
                    return resolved.status === 'found' ? resolved.item : null;
                });
                const items = (await Promise.all(itemPromises)).filter((item): item is Zotero.Item => !!item);
                if (items.length > 0) {
                    await loadFullItemDataWithAllTypes(items).catch(err =>
                        logger(`WS onPart: Failed to load item data for tool call: ${err}`, 1)
                    );
                }
            })();
        },
        processToolReturn: (part, gate) => processToolReturnResults(part, windowSet(gate)),
        upgradeToolReturn: (part, toolCallArgs) => upgradeToolReturn(part, toolCallArgs),
        prepareAgentActions: async (runId, actions) => {
            await loadItemDataForAgentActions(actions).catch(err =>
                logger(`WS agent actions: Failed to load item data for agent actions: ${err}`, 1)
            );
            // Auto-apply annotations if enabled
            autoApplyAnnotationAgentActions(runId, actions);
        },
        openCreatedTable: (tableKey, runId, toolCallId) => {
            void openCreatedTable(tableKey, getHostWindow(), runId, toolCallId);
        },
    };
}
