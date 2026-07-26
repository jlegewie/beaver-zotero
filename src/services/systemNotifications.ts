/**
 * OS-native system notifications for events the user may miss while working
 * outside the Beaver UI.
 *
 * Three events are surfaced:
 *   - Deferred approval requests (note edit, metadata change, cost
 *     confirmation, ...): the approval UI only renders inside the Beaver
 *     sidebar, so if the user is elsewhere the task stalls waiting for a
 *     decision (see notifyApprovalRequest).
 *   - User questions (ask_user_question tool): the question panel only renders
 *     inside the sidebar, so the run stalls until the user answers and a user
 *     working elsewhere has no signal it is waiting (see notifyUserQuestion).
 *   - Completed responses: the reply only renders inside the sidebar, so a
 *     user working elsewhere has no signal it is ready (see notifyRunComplete).
 *
 * Both are gated on whether the user can currently see the Beaver UI. Three
 * visibility scenarios are handled (see getBeaverVisibility):
 *   A) Beaver UI is on screen and focused  -> no notification (user sees it).
 *   B) A Zotero window is focused but Beaver is not visible -> system
 *      notification for now. This is the intended seam for a future in-app
 *      Zotero notification; replace the SCENARIO_B branch when that exists.
 *   C) Zotero is in the background -> system notification (only way to reach
 *      the user).
 *
 * Clicking a notification focuses the Zotero/Beaver window and opens the
 * Beaver sidebar so the user lands directly on the pending approval or reply.
 */

import { config } from "../../package.json";
import { logger } from "../utils/logger";
import { getPref } from "../utils/prefs";
import { store } from "../../react/store";
import { isSidebarVisibleAtom } from "../../react/atoms/ui";
import { BeaverUIFactory } from "../ui/ui";
import { WSAskUserQuestionRequest, WSDeferredApprovalRequest } from "./agentProtocol";

type BeaverVisibility = "beaver-visible" | "zotero-focused" | "zotero-unfocused";

const NOTIFICATION_ICON = `chrome://${config.addonRef}/content/icons/beaver.png`;

// Stable alert names: a new notification with the same name replaces the
// previous one instead of stacking, so parallel approvals (or back-to-back
// responses) never pile up. Separate names keep approval and response-ready
// notifications from replacing each other.
const APPROVAL_NOTIFICATION_NAME = "beaver-approval";
const QUESTION_NOTIFICATION_NAME = "beaver-question";
const RUN_COMPLETE_NOTIFICATION_NAME = "beaver-run-complete";

// Parallel tool calls can queue several approvals in the same tick. Collect
// them for a short window and surface a single notification with a count.
const COALESCE_WINDOW_MS = 400;

let queuedApprovals: WSDeferredApprovalRequest[] = [];
let coalesceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Determine whether the user can currently see the Beaver UI.
 */
function getBeaverVisibility(): BeaverVisibility {
    let mainWindowFocused = false;
    try {
        const mainWindow = Zotero.getMainWindow();
        mainWindowFocused = mainWindow?.document?.hasFocus?.() === true;
    } catch {
        // Ignore — treat as not focused
    }

    let beaverWindowFocused = false;
    try {
        const beaverWindow = BeaverUIFactory.findBeaverWindow();
        beaverWindowFocused = beaverWindow != null && !beaverWindow.closed &&
            beaverWindow.document?.hasFocus?.() === true;
    } catch {
        // Ignore — treat as not focused
    }

    const sidebarVisible = store.get(isSidebarVisibleAtom) === true;

    // Scenario A: the approval UI is in front of the user.
    if (beaverWindowFocused || (mainWindowFocused && sidebarVisible)) {
        return "beaver-visible";
    }

    // Scenario B: a Zotero window is focused, but Beaver is not visible.
    if (mainWindowFocused) {
        return "zotero-focused";
    }

    // Scenario C: Zotero is in the background.
    return "zotero-unfocused";
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
function focusBeaver(): void {
    try {
        const beaverWindow = BeaverUIFactory.findBeaverWindow();
        if (beaverWindow && !beaverWindow.closed) {
            beaverWindow.focus();
            return;
        }

        const mainWindow = Zotero.getMainWindow();
        if (!mainWindow) return;
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
function showNotification(title: string, body: string, name: string): void {
    try {
        const alertsService = (Components.classes as any)["@mozilla.org/alerts-service;1"]
            .getService(Components.interfaces.nsIAlertsService);

        const listener = {
            observe(_subject: unknown, topic: string) {
                if (topic === "alertclickcallback") {
                    focusBeaver();
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

        alertsService.showAlertNotification(
            NOTIFICATION_ICON,
            title,
            body,
            true, // text clickable
            "", // cookie (unused — the click handler always focuses Beaver)
            listener,
            name, // shared name so notifications replace, never stack
        );
    } catch (error) {
        // System notifications are best-effort; the in-sidebar UI remains the
        // source of truth.
        logger(`systemNotifications: Failed to show notification: ${error}`, 1);
    }
}

/**
 * Show an OS-native notification for one or more pending approval requests.
 */
function showSystemNotification(events: WSDeferredApprovalRequest[]): void {
    if (events.length === 0) return;
    const { title, body } = describeApprovals(events);
    showNotification(title, body, APPROVAL_NOTIFICATION_NAME);
}

/**
 * Surface the approvals collected during the coalescing window as one
 * notification, then reset for the next batch.
 */
function flushQueuedApprovals(): void {
    coalesceTimer = null;
    const events = queuedApprovals;
    queuedApprovals = [];
    showSystemNotification(events);
}

/**
 * Decide whether to surface a system notification for a pending approval
 * request, based on whether the user can currently see the Beaver UI.
 */
export function notifyApprovalRequest(event: WSDeferredApprovalRequest): void {
    if (getPref("enableSystemNotifications") !== true) {
        return;
    }

    const visibility = getBeaverVisibility();

    switch (visibility) {
        case "beaver-visible":
            // Scenario A: the approval UI is already on screen — nothing to do.
            return;
        case "zotero-focused":
            // SCENARIO B: Zotero is focused but Beaver is not visible.
            // TODO: when an in-app Zotero notification exists, route this case
            // there instead of falling through to a system notification.
            break;
        case "zotero-unfocused":
            // Scenario C: Zotero is in the background.
            break;
    }

    // Coalesce a burst of parallel approvals into a single notification. The
    // window opens on the first queued request and flushes everything together.
    queuedApprovals.push(event);
    if (coalesceTimer === null) {
        coalesceTimer = setTimeout(flushQueuedApprovals, COALESCE_WINDOW_MS);
    }
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
export function notifyUserQuestion(event: WSAskUserQuestionRequest): void {
    if (getPref("enableSystemNotifications") !== true) {
        return;
    }

    const visibility = getBeaverVisibility();

    switch (visibility) {
        case "beaver-visible":
            // Scenario A: the question is already on screen — nothing to do.
            return;
        case "zotero-focused":
            // SCENARIO B: Zotero is focused but Beaver is not visible.
            // TODO: when an in-app Zotero notification exists, route this case
            // there instead of falling through to a system notification.
            break;
        case "zotero-unfocused":
            // Scenario C: Zotero is in the background.
            break;
    }

    const { title, body } = describeQuestions(event);
    showNotification(title, body, QUESTION_NOTIFICATION_NAME);
}

/**
 * Surface a system notification when a response finishes and the user can't
 * currently see the Beaver UI (working in another app, or Zotero focused but
 * the sidebar hidden). Clicking opens Beaver on the completed response.
 */
export function notifyRunComplete(): void {
    if (getPref("enableResponseCompleteNotifications") !== true) {
        return;
    }

    // Scenario A: the response is already on screen — nothing to do. Scenarios
    // B and C (Beaver hidden, or Zotero in the background) both get notified.
    if (getBeaverVisibility() === "beaver-visible") {
        return;
    }

    showNotification(
        "Beaver finished",
        "Your response is ready. Click to open Beaver.",
        RUN_COMPLETE_NOTIFICATION_NAME,
    );
}
