/**
 * What the user has already been told, for the one-time feature tips.
 *
 * One JSON preference for every tip, keyed by tip id, so adding a tip is a
 * registry entry rather than a new preference — and so the tips can be paced
 * against each other: the newest one shown is what the gap between tips is
 * measured from. The pure functions take the state; the two wrappers at the
 * bottom read and write the preference.
 */
import { getPref, setPref } from '../../src/utils/prefs';

export interface FeatureTipState {
    /** When each tip was shown, by tip id, as ISO timestamps. */
    shown: Record<string, string>;
    /** When the newest tip of any kind was shown. */
    lastShownAt?: string;
    /** Earliest eligible time for each postponed tip, as ISO timestamps. */
    deferredUntil?: Record<string, string>;
}

/** The gap kept between two feature tips, whichever they are. */
export const FEATURE_TIP_GAP_MS = 4 * 60 * 60 * 1000;

const EMPTY_STATE: FeatureTipState = { shown: {} };

export function parseFeatureTipState(raw: unknown): FeatureTipState {
    if (typeof raw !== 'string' || !raw.trim()) return { shown: {} };
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return { shown: {} };
        const shown = parsed.shown && typeof parsed.shown === 'object' ? parsed.shown : {};
        const state: FeatureTipState = { shown: {} };
        for (const [id, at] of Object.entries(shown)) {
            if (typeof at === 'string') state.shown[id] = at;
        }
        if (typeof parsed.lastShownAt === 'string') state.lastShownAt = parsed.lastShownAt;
        if (parsed.deferredUntil && typeof parsed.deferredUntil === 'object') {
            state.deferredUntil = {};
            for (const [id, at] of Object.entries(parsed.deferredUntil)) {
                if (typeof at === 'string' && Number.isFinite(Date.parse(at))) state.deferredUntil[id] = at;
            }
        }
        return state;
    } catch {
        return { shown: {} };
    }
}

export function hasSeenFeatureTip(state: FeatureTipState, tipId: string): boolean {
    return tipId in state.shown;
}

export function isFeatureTipDeferred(state: FeatureTipState, tipId: string, now: number): boolean {
    const until = state.deferredUntil?.[tipId];
    return !!until && Date.parse(until) > now;
}

/** Postpones selected tips without marking them seen or delaying unrelated tips. */
export function deferFeatureTips(delays: Readonly<Record<string, number>>, now: number): void {
    const state = readFeatureTipState();
    const deferredUntil = { ...state.deferredUntil };
    for (const [id, delayMs] of Object.entries(delays)) {
        if (!Number.isFinite(delayMs) || delayMs <= 0) continue;
        const previous = Date.parse(deferredUntil[id] ?? '');
        deferredUntil[id] = new Date(Math.max(now + delayMs, Number.isFinite(previous) ? previous : 0)).toISOString();
    }
    writeFeatureTipState({ ...state, deferredUntil });
}

/**
 * Whether a tip shown now would come too soon after the last one.
 *
 * `otherShownAt` lets the caller count popups that are not feature tips but
 * compete for the same attention — the release notes, the welcome card — so a
 * tip does not land right after one of those either.
 */
export function isWithinFeatureTipGap(
    state: FeatureTipState,
    now: number,
    otherShownAt: readonly (string | null | undefined)[] = [],
    gapMs = FEATURE_TIP_GAP_MS,
): boolean {
    const stamps = [state.lastShownAt, ...otherShownAt];
    for (const stamp of stamps) {
        if (!stamp) continue;
        const at = new Date(stamp).getTime();
        if (!Number.isNaN(at) && now - at < gapMs) return true;
    }
    return false;
}

export function markFeatureTipShown(state: FeatureTipState, tipId: string, now: number): FeatureTipState {
    const at = new Date(now).toISOString();
    return { ...state, shown: { ...state.shown, [tipId]: at }, lastShownAt: at };
}

export function readFeatureTipState(): FeatureTipState {
    try {
        return parseFeatureTipState(getPref('featureTips'));
    } catch {
        return EMPTY_STATE;
    }
}

export function writeFeatureTipState(state: FeatureTipState): void {
    setPref('featureTips', JSON.stringify(state));
}
