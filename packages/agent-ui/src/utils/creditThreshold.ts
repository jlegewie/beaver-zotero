/**
 * The credit limit's bounds and parsing, for a client's settings UI.
 *
 * They are defined in the core, so a client's run code reads the same bounds
 * without depending on the shared React layer.
 */

export {
    MAX_CREDIT_THRESHOLD,
    MIN_CREDIT_THRESHOLD,
    DEFAULT_CREDIT_THRESHOLD,
    clampCreditThreshold,
    parseCreditLimitEntry,
} from '@beaver/agent-core/protocol/creditThreshold';
export type { CreditLimitEntry } from '@beaver/agent-core/protocol/creditThreshold';
