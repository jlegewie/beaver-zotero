/**
 * OS-native system notifications for agent actions that need user approval.
 *
 * When the agent requests a deferred approval (note edit, metadata change,
 * cost confirmation, ...) the approval UI only renders inside the Beaver
 * sidebar. If the user is working elsewhere they may never see it, and the
 * task stalls waiting for a decision. This module surfaces those requests as
 * system notifications via Mozilla's nsIAlertsService so the user stays
 * informed and can act in time.
 *
 * Three visibility scenarios are handled (see getApprovalVisibility):
 *   A) Beaver UI is on screen and focused  -> no notification (user sees it).
 *   B) A Zotero window is focused but Beaver is not visible -> system
 *      notification for now. This is the intended seam for a future in-app
 *      Zotero notification; replace the SCENARIO_B branch when that exists.
 *   C) Zotero is in the background -> system notification (only way to reach
 *      the user).
 *
 * Clicking a notification focuses the Zotero/Beaver window and opens the
 * Beaver sidebar so the user lands directly on the pending approval.
 */

import { config } from "../../package.json";
import { logger } from "../utils/logger";
import { getPref } from "../utils/prefs";
import { store } from "../../react/store";
import { isSidebarVisibleAtom } from "../../react/atoms/ui";
import { BeaverUIFactory } from "../ui/ui";
import { WSDeferredApprovalRequest } from "./agentProtocol";

type ApprovalVisibility = "beaver-visible" | "zotero-focused" | "zotero-unfocused";

const NOTIFICATION_ICON = `chrome://${config.addonRef}/content/icons/beaver.png`;

/**
 * Determine whether the user can currently see the Beaver approval UI.
 */
function getApprovalVisibility(): ApprovalVisibility {
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
            return { title, body: "Approve PDF text extraction to let the task continue." };
        case "confirm_external_search":
            return { title, body: "Approve an external literature search to let the task continue." };
        case "edit_note":
            return { title, body: "Review a note edit to let the task continue." };
        case "edit_metadata":
            return { title, body: "Review a metadata change to let the task continue." };
        default:
            return { title, body: "A task is waiting for your decision." };
    }
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
 * Show an OS-native notification for a pending approval request.
 */
function showSystemNotification(event: WSDeferredApprovalRequest): void {
    try {
        const alertsService = Components.classes["@mozilla.org/alerts-service;1"]
            .getService(Components.interfaces.nsIAlertsService);

        const { title, body } = describeApproval(event);

        const listener = {
            observe(_subject: unknown, topic: string) {
                if (topic === "alertclickcallback") {
                    focusBeaver();
                }
            },
        };

        alertsService.showAlertNotification(
            NOTIFICATION_ICON,
            title,
            body,
            true, // text clickable
            event.action_id, // cookie
            listener,
            `beaver-approval-${event.action_id}`, // name (unique per request)
        );
    } catch (error) {
        // System notifications are best-effort; the in-sidebar approval UI
        // remains the source of truth.
        logger(`systemNotifications: Failed to show notification: ${error}`, 1);
    }
}

/**
 * Decide whether to surface a system notification for a pending approval
 * request, based on whether the user can currently see the Beaver UI.
 */
export function notifyApprovalRequest(event: WSDeferredApprovalRequest): void {
    if (getPref("enableSystemNotifications") !== true) {
        return;
    }

    const visibility = getApprovalVisibility();

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

    showSystemNotification(event);
}
