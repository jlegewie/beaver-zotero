/**
 * OS-native system notifications for events the user may miss while working
 * outside the Beaver UI.
 *
 * Five events are surfaced:
 *   - Deferred approval requests (note edit, metadata change, cost
 *     confirmation, ...): the approval UI only renders inside the Beaver
 *     sidebar, so if the user is elsewhere the task stalls waiting for a
 *     decision (see notifyApprovalRequest).
 *   - User questions (ask_user_question tool): the question panel only renders
 *     inside the sidebar, so the run stalls until the user answers and a user
 *     working elsewhere has no signal it is waiting (see notifyUserQuestion).
 *   - Credit confirmations: the run pauses on a spending decision that can only
 *     be answered in the sidebar (see notifyCreditConfirmation).
 *   - Batch approvals: the run pauses before a batch starts changing the
 *     library, and the card only renders in the sidebar (see
 *     notifyBatchApproval).
 *   - Completed responses: the reply only renders inside the sidebar, so a
 *     user working elsewhere has no signal it is ready (see notifyRunComplete).
 *
 * All are gated on whether the user can currently see the Beaver UI. Three
 * visibility scenarios are handled (see getBeaverVisibility):
 *   A) Beaver UI is on screen and focused  -> no notification (user sees it).
 *   B) A Zotero window is focused but Beaver is not visible -> no
 *      notification: the run status popup in the main window's corner
 *      (react/components/runStatusPopup) reports the event there.
 *   C) Zotero is in the background -> system notification (only way to reach
 *      the user).
 *
 * Clicking a notification focuses the Zotero/Beaver window and opens the
 * Beaver sidebar so the user lands directly on the pending approval or reply.
 *
 * The decision runs where the run does, in the plugin realm, once per event.
 * Each call names the window that shows the run (`NotificationTarget`).
 */

import { config } from "../../package.json";
import { logger } from "@beaver/agent-core/platform/logger";
import { getPref } from "../utils/prefs";
import { findBeaverWindow } from "../ui/beaverWindowLookup";
import {
    WSAskUserQuestionRequest,
    WSBatchApprovalRequest,
    WSCreditConfirmationRequest,
    WSDeferredApprovalRequest,
} from "@beaver/agent-core/protocol/agentProtocol";

type BeaverVisibility = "beaver-visible" | "zotero-focused" | "zotero-unfocused";

/** The window that shows a run, as notifications need it. */
export interface NotificationTarget {
    /** The main window whose Beaver surface shows the run, if it is still open. */
    hostWindow(): Window | null | undefined;
    /** Whether that window's Beaver sidebar is open. */
    sidebarVisible(): boolean;
    /**
     * Open the run's chat in `hostWindow`, for a run no window shows. Absent,
     * or doing nothing, when a window shows it: clicking then only brings
     * that window's Beaver forward.
     */
    open?(): void;
}

const NOTIFICATION_ICON = `chrome://${config.addonRef}/content/icons/beaver.png`;

// Stable alert names: a new notification with the same name replaces the
// previous one instead of stacking, so parallel approvals (or back-to-back
// responses) never pile up. Separate names keep approval and response-ready
// notifications from replacing each other.
const APPROVAL_NOTIFICATION_NAME = "beaver-approval";
const QUESTION_NOTIFICATION_NAME = "beaver-question";
const CREDIT_CONFIRMATION_NOTIFICATION_NAME = "beaver-credit-confirmation";
const BATCH_APPROVAL_NOTIFICATION_NAME = "beaver-batch-approval";
const RUN_COMPLETE_NOTIFICATION_NAME = "beaver-run-complete";

// Notification bodies are one-liners in the OS shell; longer copy is elided
// rather than wrapped. The card in the sidebar carries the full text.
const MAX_BODY_CHARS = 160;

// Parallel tool calls can queue several approvals in the same tick. Collect
// them for a short window and surface a single notification with a count.
const COALESCE_WINDOW_MS = 400;

/** Approvals waiting to be surfaced together, per window that shows them. */
const queuedApprovals = new Map<NotificationTarget, WSDeferredApprovalRequest[]>();

/** Whether any Zotero window has the focus, i.e. Zotero is the app in front. */
function anyZoteroWindowFocused(): boolean {
    try {
        const windows = Services.wm.getEnumerator(null as unknown as string);
        while (windows.hasMoreElements()) {
            const win = windows.getNext() as Window;
            if (!win.closed && win.document?.hasFocus?.() === true) return true;
        }
    } catch {
        // No window mediator: no window has the focus.
    }
    return false;
}

/**
 * Determine whether the user can currently see the Beaver UI.
 */
function getBeaverVisibility(target: NotificationTarget): BeaverVisibility {
    let mainWindowFocused = false;
    try {
        const mainWindow = target.hostWindow();
        mainWindowFocused = mainWindow?.document?.hasFocus?.() === true;
    } catch {
        // Ignore — treat as not focused
    }

    let beaverWindowFocused = false;
    try {
        const beaverWindow = findBeaverWindow();
        beaverWindowFocused = beaverWindow != null && !beaverWindow.closed &&
            beaverWindow.__beaverOwnerWindowRef?.deref() === target.hostWindow() &&
            beaverWindow.document?.hasFocus?.() === true;
    } catch {
        // Ignore — treat as not focused
    }

    let sidebarVisible = false;
    try {
        sidebarVisible = target.sidebarVisible();
    } catch {
        // A closed window shows nothing.
    }

    // Scenario A: the approval UI is in front of the user.
    if (beaverWindowFocused || (mainWindowFocused && sidebarVisible)) {
        return "beaver-visible";
    }

    // Scenario B: a Zotero window is focused, but Beaver is not visible. Any
    // Zotero window counts: runs go on in chats no focused window shows.
    if (mainWindowFocused || anyZoteroWindowFocused()) {
        return "zotero-focused";
    }

    // Scenario C: Zotero is in the background.
    return "zotero-unfocused";
}

/**
 * Whether an event that stalls waiting for the user should surface an
 * OS-native notification: the user opted in, and the Beaver UI is not already
 * in front of them.
 */
function shouldNotifySystem(target: NotificationTarget): boolean {
    if (getPref("enableSystemNotifications") !== true) {
        return false;
    }

    switch (getBeaverVisibility(target)) {
        case "beaver-visible":
            // Scenario A: the pending UI is already on screen — nothing to do.
            return false;
        case "zotero-focused":
            // Scenario B: Zotero is focused but Beaver is not visible. The run
            // status popup in the main window's corner
            // (react/components/runStatusPopup) already shows the pending
            // decision or the finished response there, with its controls, so
            // an OS notification on top of it would say the same thing twice.
            return false;
        case "zotero-unfocused":
            // Scenario C: Zotero is in the background.
            return true;
    }
}

/**
 * Human-readable notification text for an approval request.
 */
function describeApproval(event: WSDeferredApprovalRequest): { title: string; body: string } {
    const title = "Beaver needs your approval";
    switch (event.action_type) {
        case "confirm_extraction":
            return { title, body: "Approve text extraction to let the task continue." };
        case "confirm_external_search":
            return { title, body: "Approve an external literature search to let the task continue." };
        case "edit_note":
        case "edit_note_batch":
            return { title, body: "Review a note edit to let the task continue." };
        case "edit_annotations":
            return { title, body: "Review an annotation change to let the task continue." };
        case "edit_metadata":
            return { title, body: "Review a metadata change to let the task continue." };
        default:
            return { title, body: "A task is waiting for your decision." };
    }
}

/**
 * Notification text for one or more queued approval requests. A single request
 * gets a specific message; a burst collapses into a count.
 */
function describeApprovals(events: WSDeferredApprovalRequest[]): { title: string; body: string } {
    if (events.length === 1) {
        return describeApproval(events[0]);
    }
    return {
        title: "Beaver needs your approval",
        body: `${events.length} actions are waiting for your decision.`,
    };
}

/**
 * Focus the Beaver UI: raise the separate window if open, otherwise focus the
 * main Zotero window and open the sidebar.
 */
function focusBeaver(target: NotificationTarget): void {
    try {
        target.open?.();
        const beaverWindow = findBeaverWindow();
        if (beaverWindow && !beaverWindow.closed && beaverWindow.__beaverOwnerWindowRef?.deref() === target.hostWindow()) {
            beaverWindow.focus();
            return;
        }

        const mainWindow = target.hostWindow();
        if (!mainWindow || mainWindow.closed) return;
        mainWindow.focus();

        const eventBus = (mainWindow as any).__beaverEventBus;
        if (eventBus) {
            eventBus.dispatchEvent(
                new (mainWindow as any).CustomEvent("toggleChat", {
                    detail: { forceOpen: true },
                }),
            );
        }
    } catch (error) {
        logger(`systemNotifications: Failed to focus Beaver: ${error}`, 1);
    }
}

/**
 * Show an OS-native notification that focuses Beaver when clicked. `name`
 * groups replaceable notifications: a later notification with the same name
 * replaces the earlier one instead of stacking.
 */
function showNotification(title: string, body: string, name: string, target: NotificationTarget): void {
    try {
        const alertsService = (Components.classes as any)["@mozilla.org/alerts-service;1"]
            .getService(Components.interfaces.nsIAlertsService);

        const listener = {
            observe(_subject: unknown, topic: string) {
                if (topic === "alertclickcallback") {
                    focusBeaver(target);
                    // Dismiss the notification so it does not linger (e.g. in the
                    // macOS Notification Center) after the user has acted on it.
                    try {
                        alertsService.closeAlert(name);
                    } catch {
                        // Best-effort: the OS usually clears the clicked alert itself.
                    }
                }
            },
        };

        // `showAlert` + `nsIAlertNotification` works on every supported Zotero;
        // the older `showAlertNotification` shorthand is gone in Firefox 153.
        const alert = (Components.classes as any)["@mozilla.org/alert-notification;1"]
            .createInstance(Components.interfaces.nsIAlertNotification);
        alert.init(
            name, // shared name so notifications replace, never stack
            NOTIFICATION_ICON,
            title,
            body,
            true, // text clickable
            "", // cookie (unused — the click handler always focuses Beaver)
        );
        alertsService.showAlert(alert, listener);
    } catch (error) {
        // System notifications are best-effort; the in-sidebar UI remains the
        // source of truth.
        logger(`systemNotifications: Failed to show notification: ${error}`, 1);
    }
}

/**
 * Show an OS-native notification for one or more pending approval requests.
 */
function showSystemNotification(events: WSDeferredApprovalRequest[], target: NotificationTarget): void {
    if (events.length === 0) return;
    const { title, body } = describeApprovals(events);
    showNotification(title, body, APPROVAL_NOTIFICATION_NAME, target);
}

/**
 * Surface the approvals collected during the coalescing window as one
 * notification, then reset for the next batch.
 */
function flushQueuedApprovals(target: NotificationTarget): void {
    const events = queuedApprovals.get(target) ?? [];
    queuedApprovals.delete(target);
    // The window that showed them closed meanwhile: nothing is left to open.
    if (!target.hostWindow()) return;
    showSystemNotification(events, target);
}

/**
 * Decide whether to surface a system notification for a pending approval
 * request, based on whether the user can currently see the Beaver UI.
 */
export function notifyApprovalRequest(target: NotificationTarget, event: WSDeferredApprovalRequest): void {
    if (!shouldNotifySystem(target)) {
        return;
    }

    // Coalesce a burst of parallel approvals of one window into a single
    // notification. The coalescing window opens on the first queued request
    // and flushes everything together.
    const queued = queuedApprovals.get(target);
    if (queued) {
        queued.push(event);
        return;
    }
    queuedApprovals.set(target, [event]);
    setTimeout(() => flushQueuedApprovals(target), COALESCE_WINDOW_MS);
}

/**
 * Notification text for a pending user question. A single question shows its
 * text directly; a burst of questions collapses into a count.
 */
function describeQuestions(event: WSAskUserQuestionRequest): { title: string; body: string } {
    const title = "Beaver has a question";
    const questions = event.questions ?? [];
    if (questions.length <= 1) {
        const question = questions[0]?.question?.trim();
        return {
            title,
            body: question && question.length > 0
                ? question
                : "Answer a question to let the task continue.",
        };
    }
    return {
        title,
        body: `${questions.length} questions are waiting for your answer.`,
    };
}

/**
 * Surface a system notification when the agent asks the user a question
 * and the user can't currently see the Beaver UI.
 */
export function notifyUserQuestion(target: NotificationTarget, event: WSAskUserQuestionRequest): void {
    if (!shouldNotifySystem(target)) {
        return;
    }

    const { title, body } = describeQuestions(event);
    showNotification(title, body, QUESTION_NOTIFICATION_NAME, target);
}

/** Shorten a body to one notification-sized line. */
function truncateBody(text: string): string {
    const cleaned = text.replace(/\s+/g, " ").trim();
    return cleaned.length > MAX_BODY_CHARS
        ? `${cleaned.slice(0, MAX_BODY_CHARS - 1).trimEnd()}…`
        : cleaned;
}

/**
 * Surface a system notification when a run pauses for a credit confirmation
 * and the user can't currently see the Beaver UI.
 *
 * The title and body are the backend's own copy — this path composes no
 * wording of its own, exactly as the card does.
 */
export function notifyCreditConfirmation(target: NotificationTarget, event: WSCreditConfirmationRequest): void {
    if (!shouldNotifySystem(target)) {
        return;
    }

    // Keep notification copy consistent with the backend-provided card text.
    showNotification(
        event.title,
        truncateBody(event.message),
        CREDIT_CONFIRMATION_NOTIFICATION_NAME,
        target,
    );
}

/**
 * Surface a system notification when a run pauses for a batch approval and the
 * user can't currently see the Beaver UI.
 *
 * The title and body are the backend's own copy — this path composes no
 * wording of its own, exactly as the card does.
 *
 * The body is the batch goal. The destructive warning stays on the card: it is
 * a separate claim about what will be removed, it only reads as one in its own
 * block, and appending it here would both invent a combined sentence and risk
 * eliding a destruction claim mid-word at the one-line limit.
 */
export function notifyBatchApproval(target: NotificationTarget, event: WSBatchApprovalRequest): void {
    if (!shouldNotifySystem(target)) {
        return;
    }

    showNotification(
        event.title,
        truncateBody(event.message),
        BATCH_APPROVAL_NOTIFICATION_NAME,
        target,
    );
}

/**
 * Surface a system notification when a response finishes and the user can't
 * currently see the Beaver UI (working in another app, or Zotero focused but
 * the sidebar hidden). Clicking opens Beaver on the completed response.
 */
export function notifyRunComplete(target: NotificationTarget): void {
    if (getPref("enableResponseCompleteNotifications") !== true) {
        return;
    }

    // Only scenario C (Zotero in the background) is notified: in A the
    // response is on screen, and in B the run status popup reports it.
    if (getBeaverVisibility(target) !== "zotero-unfocused") {
        return;
    }

    showNotification(
        "Beaver finished",
        "Your response is ready. Click to open Beaver.",
        RUN_COMPLETE_NOTIFICATION_NAME,
        target,
    );
}
