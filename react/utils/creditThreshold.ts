/**
 * The credit limit preference, sanitized on the way out.
 *
 * The bounds and the parsing are shared with the other clients; only the
 * preference read below is Zotero's own. They are re-exported here so a caller
 * reaches the whole setting through one module.
 */

import { getPref } from '../../src/utils/prefs';
import { clampCreditThreshold } from '@beaver/agent-ui/utils/creditThreshold';

export {
    MAX_CREDIT_THRESHOLD,
    MIN_CREDIT_THRESHOLD,
    DEFAULT_CREDIT_THRESHOLD,
    clampCreditThreshold,
    parseCreditLimitEntry,
} from '@beaver/agent-ui/utils/creditThreshold';
export type { CreditLimitEntry } from '@beaver/agent-ui/utils/creditThreshold';

/** The stored credit limit, bounded. */
export function readCreditThreshold(): number {
    return clampCreditThreshold(Number(getPref('creditConfirmThreshold')));
}
