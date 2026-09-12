import type { WindowRuntime } from '../../src/runtime/instance';
import {
    handleTestApplicationStateHttpRequest,
    handleTestBeaverSidebarHttpRequest,
    handleTestBeaverWindowHttpRequest,
    handleTestSelectTabHttpRequest,
} from './httpHandlers/testApplicationStateHandlers';
import {
    handleBatchProgressClear,
    handleBatchProgressPreview,
} from './httpHandlers/testBatchProgressHandlers';
import {
    handleTestApproveActionHttpRequest,
    handleTestChatSendHttpRequest,
    handleTestConfirmCreditsHttpRequest,
    handleTestCurrentIdsHttpRequest,
    handleTestListActionsHttpRequest,
    handleTestLoadThreadHttpRequest,
    handleTestNewThreadHttpRequest,
    handleTestUndoActionHttpRequest,
} from './httpHandlers/testChatHandlers';
import {
    handleTestResolveItemDisplayHttpRequest,
} from './httpHandlers/testCitationHandlers';
import {
    handleTestEpubAnnotationParityHttpRequest,
} from './httpHandlers/testEpubAnnotationHandlers';

import {
    handleTestNoteApplyHttpRequest,
    handleTestNoteCloseEditorHttpRequest,
    handleTestNoteOpenEditorHttpRequest,
    handleTestNotePreviewHttpRequest,
    handleTestNoteUndoHttpRequest,
} from './httpHandlers/testNoteHandlers';

import {
    handleTestPdfCaptchaEligibilityHttpRequest,
    handleTestPdfRetrievalHttpRequest,
} from './httpHandlers/testPdfRetrievalHandlers';

import { handleTestQuickPromptHttpRequest } from './httpHandlers/testQuickPromptHandlers';
import {
    handleTestEpubCitationNavigateHttpRequest,
    handleTestReaderStateHttpRequest,
} from './httpHandlers/testReaderHandlers';
import { handleTestRunStatusPopupHttpRequest } from './httpHandlers/testRunStatusPopupHandlers';
import { handleTestListSavedActionsHttpRequest } from './httpHandlers/testSavedActionsHandlers';
import {
    handleTestSnapshotAnnotationParityHttpRequest,
} from './httpHandlers/testSnapshotAnnotationHandlers';
import {
    handleTestCloseTableHttpRequest,
    handleTestOpenStoredTableHttpRequest,
    handleTestOpenTableHttpRequest,
    handleTestTableOpenReaderHttpRequest,
} from './httpHandlers/testTableHandlers';
import { handleTestVersionPopupHttpRequest } from './httpHandlers/testVersionPopupHandlers';
import { captureOperationContext } from '../runtime/operationContext';
export function registerWindowTestCommands(runtime: WindowRuntime, inspect: (request: any) => any): void {
 const handlers = {
 'inspect-runtime': async (request: any) => inspect(request),
'/beaver/test/batch-progress-preview': handleBatchProgressPreview,
'/beaver/test/batch-progress-clear': handleBatchProgressClear,
'/beaver/test/note-open-editor': handleTestNoteOpenEditorHttpRequest,
'/beaver/test/note-close-editor': handleTestNoteCloseEditorHttpRequest,
'/beaver/test/note-undo': handleTestNoteUndoHttpRequest,
'/beaver/test/note-apply': handleTestNoteApplyHttpRequest,
'/beaver/test/note-preview': handleTestNotePreviewHttpRequest,
'/beaver/test/pdf-retrieval': handleTestPdfRetrievalHttpRequest,
'/beaver/test/pdf-captcha-eligibility': handleTestPdfCaptchaEligibilityHttpRequest,
'/beaver/test/epub-annotation-parity': handleTestEpubAnnotationParityHttpRequest,
'/beaver/test/snapshot-annotation-parity': handleTestSnapshotAnnotationParityHttpRequest,
'/beaver/test/reader-state': handleTestReaderStateHttpRequest,
'/beaver/test/epub-citation-navigate': handleTestEpubCitationNavigateHttpRequest,
'/beaver/test/resolve-item-display': handleTestResolveItemDisplayHttpRequest,
'/beaver/test/new-thread': handleTestNewThreadHttpRequest,
'/beaver/test/chat-send': handleTestChatSendHttpRequest,
'/beaver/test/current-ids': handleTestCurrentIdsHttpRequest,
'/beaver/test/load-thread': handleTestLoadThreadHttpRequest,
'/beaver/test/list-actions': handleTestListActionsHttpRequest,
'/beaver/test/approve-action': handleTestApproveActionHttpRequest,
'/beaver/test/confirm-credits': handleTestConfirmCreditsHttpRequest,
'/beaver/test/undo-action': handleTestUndoActionHttpRequest,
'/beaver/test/application-state': handleTestApplicationStateHttpRequest,
'/beaver/test/beaver-window': handleTestBeaverWindowHttpRequest,
'/beaver/test/open-table': handleTestOpenTableHttpRequest,
'/beaver/test/close-table': handleTestCloseTableHttpRequest,
'/beaver/test/open-stored-table': handleTestOpenStoredTableHttpRequest,
'/beaver/test/table-open-reader': handleTestTableOpenReaderHttpRequest,
'/beaver/test/beaver-sidebar': handleTestBeaverSidebarHttpRequest,
'/beaver/test/select-tab': handleTestSelectTabHttpRequest,
'/beaver/test/run-status-popup': handleTestRunStatusPopupHttpRequest,
'/beaver/test/quick-prompt': handleTestQuickPromptHttpRequest,
'/beaver/test/version-popup': handleTestVersionPopupHttpRequest,
'/beaver/test/saved-actions': handleTestListSavedActionsHttpRequest,
'render-markdown': async (request: { content: string }) => captureOperationContext(false).renderMarkdown!(request.content),
};
 Zotero.Beaver.runtime.registerWindowCommands(runtime, handlers);
}
