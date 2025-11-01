import { citationMetadataAtom, citationDataAtom } from "../atoms/citations"
import { userAtom, isAuthenticatedAtom, authLoadingAtom } from "../atoms/auth"
import { fileStatusAtom, errorCodeStatsAtom, errorCodeStatsIsLoadingAtom, errorCodeStatsErrorAtom, lastFetchedErrorCountsAtom, aggregatedErrorMessagesForFailedFilesAtom, aggregatedErrorMessagesForSkippedFilesAtom, fileStatusSummaryAtom, isUploadProcessedAtom } from "../atoms/files"
import { readerTextSelectionAtom, currentMessageContentAtom, currentReaderAttachmentAtom, currentReaderAttachmentKeyAtom, inputAttachmentCountAtom } from "../atoms/messageComposition"
import { supportedModelsAtom, selectedModelAtom, isAgentModelAtom, availableModelsAtom } from "../atoms/models"
import { isProfileInvalidAtom, profileWithPlanAtom, isProfileLoadedAtom, syncLibraryIdsAtom, planFeaturesAtom, profileBalanceAtom, hasAuthorizedAccessAtom, hasCompletedOnboardingAtom, syncWithZoteroAtom } from "../atoms/profile"
import { syncStatusAtom, syncingAtom, syncErrorAtom, syncStatusSummaryAtom, overallSyncStatusAtom } from "../atoms/sync"
import { userAttachmentsAtom, toolAttachmentsAtom, isChatRequestPendingAtom, isStreamingAtom, isCancellableAtom, isCancellingAtom, recentThreadsAtom, currentThreadIdAtom, currentAssistantMessageIdAtom, threadMessagesAtom } from "../atoms/threads"
import { isSidebarVisibleAtom, isLibraryTabAtom, isPreferencePageVisibleAtom, showFileStatusDetailsAtom, userScrolledAtom, activePreviewAtom, popupMessagesAtom } from "../atoms/ui"
import { store } from "../store"

export const atomRegistry = {
    // Auth
    isAuthenticated: isAuthenticatedAtom,
    user: userAtom,
    authLoading: authLoadingAtom,

    // Citations
    citationMetadata: citationMetadataAtom,
    citationMetadataView: citationDataAtom,

    // Files
    fileStatus: fileStatusAtom,
    errorCodeStats: errorCodeStatsAtom,
    errorCodeStatsIsLoading: errorCodeStatsIsLoadingAtom,
    errorCodeStatsError: errorCodeStatsErrorAtom,
    lastFetchedErrorCounts: lastFetchedErrorCountsAtom,
    aggregatedErrorMessagesForFailedFiles: aggregatedErrorMessagesForFailedFilesAtom,
    aggregatedErrorMessagesForPlanLimitFiles: aggregatedErrorMessagesForSkippedFilesAtom,
    fileStatusSummary: fileStatusSummaryAtom,
    isUploadProcessed: isUploadProcessedAtom,

    // Input
    currentMessageContent: currentMessageContentAtom,
    currentReaderAttachment: currentReaderAttachmentAtom,
    currentReaderAttachmentKey: currentReaderAttachmentKeyAtom,
    inputAttachmentCount: inputAttachmentCountAtom,
    readerTextSelection: readerTextSelectionAtom,

    // Models
    supportedModels: supportedModelsAtom,
    selectedModel: selectedModelAtom,
    isAgentModel: isAgentModelAtom,
    availableModels: availableModelsAtom,

    // Profile
    isProfileInvalid: isProfileInvalidAtom,
    isProfileLoaded: isProfileLoadedAtom,
    profileWithPlan: profileWithPlanAtom,
    syncLibraryIds: syncLibraryIdsAtom,
    planFeatures: planFeaturesAtom,
    profileBalance: profileBalanceAtom,
    hasAuthorizedAccess: hasAuthorizedAccessAtom,
    hasCompletedOnboarding: hasCompletedOnboardingAtom,
    syncWithZotero: syncWithZoteroAtom,

    // Sync
    syncStatus: syncStatusAtom,
    syncing: syncingAtom,
    syncError: syncErrorAtom,
    syncStatusSummary: syncStatusSummaryAtom,
    overallSyncStatus: overallSyncStatusAtom,

    // Threads
    userAttachments: userAttachmentsAtom,
    toolAttachments: toolAttachmentsAtom,
    isChatRequestPending: isChatRequestPendingAtom,
    isStreaming: isStreamingAtom,
    isCancellable: isCancellableAtom,
    isCancelling: isCancellingAtom,
    recentThreads: recentThreadsAtom,
    threadMessages: threadMessagesAtom,
    currentThreadId: currentThreadIdAtom,
    currentAssistantMessageId: currentAssistantMessageIdAtom,

    // UI
    isSidebarVisible: isSidebarVisibleAtom,
    isLibraryTab: isLibraryTabAtom,
    isPreferencePageVisible: isPreferencePageVisibleAtom,
    showFileStatusDetails: showFileStatusDetailsAtom,
    userScrolled: userScrolledAtom,
    activePreview: activePreviewAtom,
    popupMessages: popupMessagesAtom,
}

export const getJotaiState = () => {
    const state: Record<string, unknown> = {}
    
    Object.entries(atomRegistry).forEach(([key, atom]) => {
        try {
            state[key] = store.get(atom as any)
        } catch (error: any) {
            state[key] = `Error reading atom: ${error.message}`
        }
    })    

    return state;
}