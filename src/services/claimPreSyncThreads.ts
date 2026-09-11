import { logger } from "@beaver/agent-core/platform/logger";
import { threadService } from "@beaver/agent-core/transport/threadService";
import { getZoteroUserIdentifier } from "../utils/zoteroInstanceIdentity";
import { getPref, setPref } from "../utils/prefs";

/** Claim this install's older threads only while its originating account is current. */
export async function claimPreSyncThreads(
    userId: string,
    isCurrent: () => boolean,
): Promise<void> {
    if (!isCurrent()) return;
    try {
        const { userID: zoteroUserId, localUserKey } =
            getZoteroUserIdentifier();
        if (!zoteroUserId) {
            if (getPref("threadsClaimKey")) setPref("threadsClaimKey", "");
            return;
        }
        const claimKey = `${userId}:${zoteroUserId}:${localUserKey}`;
        if (getPref("threadsClaimKey") === claimKey) return;
        await threadService.claimThreads(
            { zoteroUserId, zoteroLocalId: localUserKey },
            userId,
        );
        if (isCurrent()) setPref("threadsClaimKey", claimKey);
    } catch (error) {
        logger(`Unable to claim pre-sync threads: ${error}`, 2);
    }
}
