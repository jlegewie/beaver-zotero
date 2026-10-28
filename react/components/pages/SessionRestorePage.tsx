import React, { useState } from "react";
import { useAtomValue } from "jotai";
import { sessionRestoreAtom } from "../../atoms/auth";
import { Spinner } from "../icons/icons";
import Button from "@beaver/agent-ui/primitives/Button";

/**
 * Rendered by Sidebar while Beaver is still restoring the saved sign-in, in
 * place of the sign-in form: until the restore settles, Beaver does not know
 * whether the user is signed out, and a slow or unreachable server must not
 * look like one.
 *
 * Four states derived from sessionRestoreAtom:
 *  - no restore state yet: spinner + "Connecting…" (the usual, brief case).
 *  - attempt 0: the first restore is taking long; offers to sign in instead.
 *  - offline: waits for the connection; retry and sign-in offered.
 *  - failed attempts: retrying automatically; retry and sign-in offered.
 *
 * "Sign in again" only switches to the sign-in form. The saved session is kept
 * until a new sign-in replaces it, so a restore that succeeds meanwhile still
 * signs the user in.
 */
const SessionRestorePage: React.FC = () => {
    const restore = useAtomValue(sessionRestoreAtom);
    const [retrying, setRetrying] = useState(false);

    const failed = !!restore && restore.attempt > 0;
    const offline = !!restore?.offline;

    const heading = !restore
        ? "Connecting…"
        : offline
            ? "You're offline"
            : failed
                ? "Reconnecting…"
                : "Still connecting…";

    const subtext = !restore
        ? "Restoring your Beaver session…"
        : offline
            ? failed
                ? "You're still signed in. Beaver will reconnect automatically when your connection returns."
                : "Beaver will reconnect automatically when your connection returns."
            : failed
                ? restore.attempt >= 2
                    ? `You're still signed in, but Beaver can't reach its server right now. Trying again… (attempt ${restore.attempt})`
                    : "You're still signed in, but Beaver can't reach its server right now. Trying again automatically."
                : "Restoring your session is taking longer than usual.";

    const handleRetry = async () => {
        setRetrying(true);
        try {
            await Zotero.Beaver?.account?.retrySessionRestore();
        } finally {
            setRetrying(false);
        }
    };

    return (
        <div
            id="session-restore-page"
            className="display-flex flex-col flex-1 min-h-0 min-w-0 items-center justify-center p-4"
        >
            <div className="display-flex flex-col items-center gap-3 text-center webapp-max-w-md">
                <Spinner size={22} />
                <div className="font-color-primary font-semibold">{heading}</div>
                <div className="font-color-secondary">{subtext}</div>
                {restore && (
                    <div className="display-flex flex-col items-center gap-2 mt-2">
                        {failed && (
                            <Button
                                variant="outline"
                                loading={retrying}
                                disabled={retrying}
                                onClick={() => void handleRetry()}
                            >
                                Try again
                            </Button>
                        )}
                        <a
                            href="#"
                            className="text-link"
                            onClick={(e) => {
                                e.preventDefault();
                                Zotero.Beaver?.account?.abandonSessionRestore();
                            }}
                        >
                            Sign in again
                        </a>
                    </div>
                )}
            </div>
        </div>
    );
};

export default SessionRestorePage;
