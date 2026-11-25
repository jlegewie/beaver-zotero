/**
 * OS notifications are decided for the window that shows the run: none while
 * its Beaver surface is in front of the user or Zotero is focused, one when
 * Zotero is in the background.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prefs, showAlert } = vi.hoisted(() => ({
    prefs: new Map<string, unknown>(),
    showAlert: vi.fn(),
}));

vi.mock('../../../src/utils/prefs', () => ({ getPref: (key: string) => prefs.get(key) }));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));
vi.mock('../../../src/ui/beaverWindowLookup', () => ({ findBeaverWindow: () => undefined }));

import { notifyApprovalRequest, notifyRunComplete, notifyUserQuestion, type NotificationTarget } from '../../../src/services/systemNotifications';

function target(focused: boolean, sidebarVisible: boolean): NotificationTarget {
    const hostWindow = { closed: false, document: { hasFocus: () => focused } } as unknown as Window;
    return { hostWindow: () => hostWindow, sidebarVisible: () => sidebarVisible };
}

const question = { questions: [{ question: 'Which year?' }] } as any;

beforeEach(() => {
    vi.clearAllMocks();
    prefs.set('enableSystemNotifications', true);
    prefs.set('enableResponseCompleteNotifications', true);
    (globalThis as any).Components = {
        classes: {
            '@mozilla.org/alerts-service;1': { getService: () => ({ showAlert, closeAlert: vi.fn() }) },
            '@mozilla.org/alert-notification;1': { createInstance: () => ({ init: vi.fn() }) },
        },
        interfaces: { nsIAlertsService: {}, nsIAlertNotification: {} },
    };
});

describe('notifications for the window that shows the run', () => {
    it('stay quiet while that window shows Beaver in front of the user', () => {
        notifyUserQuestion(target(true, true), question);
        notifyRunComplete(target(true, true));
        expect(showAlert).not.toHaveBeenCalled();
    });

    it('leave a focused Zotero with Beaver hidden to the run status popup', () => {
        notifyUserQuestion(target(true, false), question);
        notifyRunComplete(target(true, false));
        expect(showAlert).not.toHaveBeenCalled();
    });

    it('reach the user once when Zotero is in the background', () => {
        notifyUserQuestion(target(false, true), question);
        notifyRunComplete(target(false, false));
        expect(showAlert).toHaveBeenCalledTimes(2);
    });

    it('still reach the user in the background when no window shows the run', () => {
        const gone: NotificationTarget = { hostWindow: () => null, sidebarVisible: () => false };
        notifyRunComplete(gone);
        expect(showAlert).toHaveBeenCalledOnce();
    });

    it('coalesce a burst of approvals per window, never across windows', () => {
        vi.useFakeTimers();
        try {
            const first = target(false, false);
            const second = target(false, false);
            notifyApprovalRequest(first, { action_id: 'a1', action_type: 'edit_note' } as any);
            notifyApprovalRequest(first, { action_id: 'a2', action_type: 'edit_note' } as any);
            notifyApprovalRequest(second, { action_id: 'b1', action_type: 'edit_note' } as any);
            vi.advanceTimersByTime(1000);
            expect(showAlert).toHaveBeenCalledTimes(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it('drop queued approvals whose window closed before they were shown', () => {
        vi.useFakeTimers();
        try {
            let open = true;
            const closing: NotificationTarget = {
                hostWindow: () => (open ? ({ closed: false, document: { hasFocus: () => false } } as unknown as Window) : null),
                sidebarVisible: () => false,
            };
            notifyApprovalRequest(closing, { action_id: 'a1', action_type: 'edit_note' } as any);
            open = false;
            vi.advanceTimersByTime(1000);
            expect(showAlert).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });
});
