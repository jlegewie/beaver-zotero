import { getPref, setPref } from "./prefs";

const PENDING_NOTIFICATIONS_PREF = "pendingVersionNotifications" as const;

const parseNotificationList = (rawValue: string | null | undefined): string[] => {
    if (!rawValue) {
        return [];
    }

    try {
        const parsed = JSON.parse(rawValue);
        if (!Array.isArray(parsed)) {
            return [];
        }
        return parsed.filter((value): value is string => typeof value === "string");
    } catch (error) {
        if (typeof Zotero !== "undefined" && typeof Zotero.logError === "function") {
            Zotero.logError(error as Error);
        }
        return [];
    }
};

export const getPendingVersionNotifications = (): string[] => {
    const storedValue = getPref("pendingVersionNotifications");
    return parseNotificationList(storedValue);
};

export const addPendingVersionNotification = (version: string) => {
    const notifications = getPendingVersionNotifications();
    if (notifications.includes(version)) {
        return;
    }

    notifications.push(version);
    setPref("pendingVersionNotifications", JSON.stringify(notifications));
};

export const removePendingVersionNotification = (version: string) => {
    const notifications = getPendingVersionNotifications().filter(
        (pendingVersion) => pendingVersion !== version,
    );
    setPref("pendingVersionNotifications", JSON.stringify(notifications));
};

export const clearPendingVersionNotifications = () => {
    setPref(PENDING_NOTIFICATIONS_PREF, JSON.stringify([]));
};
