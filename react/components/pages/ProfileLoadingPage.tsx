import React from "react";
import { useAtomValue } from "jotai";
import { profileSyncStatusAtom } from "../../atoms/profile";
import { triggerProfileRefresh } from "../../hooks/useProfileSync";
import { Spinner } from "../icons/icons";
import Button from "../ui/Button";

/**
 * Rendered by Sidebar when the user is authenticated but the profile has not been
 * loaded yet (initial fetch in progress, offline, or fatal error). Replaces the
 * previous behavior of showing LoginPage in these states.
 *
 * Three visual states derived from profileSyncStatusAtom:
 *  - ok with no profile yet: spinner + "Connecting…".
 *  - transient (with offline flag): "You're offline" or "Reconnecting…" + manual retry.
 *  - fatal: error message + manual retry.
 */
const ProfileLoadingPage: React.FC = () => {
    const status = useAtomValue(profileSyncStatusAtom);

    const isFatal = status.kind === 'fatal';
    const isTransient = status.kind === 'transient';
    const isOffline = isTransient && status.offline;

    const heading = isFatal
        ? "Couldn't load your profile"
        : isOffline
            ? "You're offline"
            : isTransient
                ? "Reconnecting…"
                : "Connecting…";

    const subtext = isFatal
        ? status.message
        : isOffline
            ? "Beaver will reconnect automatically when your connection returns."
            : isTransient
                ? status.attempt >= 2
                    ? `Trying again… (attempt ${status.attempt + 1})`
                    : "Re-establishing connection to the Beaver service."
                : "Loading your profile…";

    return (
        <div
            id="profile-loading-page"
            className="display-flex flex-col flex-1 min-h-0 min-w-0 items-center justify-center p-4"
        >
            <div className="display-flex flex-col items-center gap-3 text-center webapp-max-w-md">
                {!isFatal && <Spinner size={22} />}
                <div className="font-color-primary font-semibold">{heading}</div>
                <div className="font-color-secondary">{subtext}</div>
                {(isFatal || isTransient) && (
                    <div className="mt-2">
                        <Button
                            variant="outline"
                            onClick={() => triggerProfileRefresh()}
                        >
                            Try again
                        </Button>
                    </div>
                )}
            </div>
        </div>
    );
};

export default ProfileLoadingPage;
