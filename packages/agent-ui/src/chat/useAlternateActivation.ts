import { useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { isMacPlatform } from '../utils/platform';

/**
 * How long the modifier must be held before the alternate state engages.
 *
 * The accelerator is pressed constantly for unrelated shortcuts, and every
 * citation on screen restyles when the state flips, so reacting instantly would
 * flash the whole transcript on each Cmd-C. A brief hold separates "I am holding
 * this to see what it does" from "I am typing a chord".
 */
export const HOLD_DELAY_MS = 250;

/** Keys that are themselves modifiers, and so don't make a keypress a chord. */
const MODIFIER_KEYS = new Set(['Meta', 'Control', 'Shift', 'Alt', 'AltGraph', 'OS', 'CapsLock']);

/**
 * Whether an event carries the alternate-activation modifier: the platform
 * accelerator, Cmd on macOS and Ctrl everywhere else.
 *
 * It has to be the accelerator rather than Shift or Alt, because a citation sits
 * inside selectable prose in a chrome document:
 *
 * - Shift-click extends the text selection. That happens on *mousedown*, so a
 *   `preventDefault()` on the click cannot undo it — the user gets a selection
 *   and an activation at once.
 * - A bare Alt keydown activates Gecko's menu bar on Windows and Linux, which
 *   would fire while the user is merely holding the key down.
 *
 * Neither accelerator chord has a default action over a plain `<span>`, and
 * mapping macOS to Cmd keeps Ctrl-click free for the context menu there.
 *
 * @param navigator - The navigator of the window the event was delivered to
 */
export function hasAlternateModifier(
    event: { metaKey: boolean; ctrlKey: boolean },
    navigator: Navigator | undefined | null,
): boolean {
    return navigator && isMacPlatform(navigator) ? event.metaKey : event.ctrlKey;
}

type Subscriber = (held: boolean) => void;

interface DocumentTracker {
    subscribers: Set<Subscriber>;
    isHeld: () => boolean;
    teardown: () => void;
}

/**
 * One tracker per document, shared by every citation in it. Keyed weakly so a
 * closed window's entry goes away with the window; timers are scheduled on that
 * window, so they die with it rather than firing into a dead realm.
 */
const trackers = new WeakMap<Document, DocumentTracker>();

function createTracker(doc: Document): DocumentTracker {
    const win = doc.defaultView;
    const subscribers = new Set<Subscriber>();
    let held = false;
    let timer: number | null = null;
    // Set once a non-modifier key is pressed with the accelerator down: the user
    // is typing a chord, so the alternate state stays off until they let go.
    let chording = false;

    const publish = (next: boolean) => {
        if (next === held) return;
        held = next;
        subscribers.forEach((notify) => notify(next));
    };

    const cancelPending = () => {
        if (timer === null) return;
        win?.clearTimeout(timer);
        timer = null;
    };

    const release = () => {
        cancelPending();
        chording = false;
        publish(false);
    };

    const onKey = (event: KeyboardEvent) => {
        if (!hasAlternateModifier(event, win?.navigator)) {
            release();
            return;
        }
        if (event.type === 'keydown' && !MODIFIER_KEYS.has(event.key)) {
            chording = true;
            cancelPending();
            publish(false);
            return;
        }
        if (chording || held || timer !== null) return;
        timer = win?.setTimeout(() => {
            timer = null;
            publish(true);
        }, HOLD_DELAY_MS) ?? null;
    };

    // Capture phase: a citation can render inside surfaces that stop key events
    // on their way up (the composer, the reader).
    doc.addEventListener('keydown', onKey, true);
    doc.addEventListener('keyup', onKey, true);
    // Focus can leave the window while the key is still down, in which case the
    // keyup is delivered elsewhere and the state would stay stuck on. On macOS
    // that includes Cmd-Tab, which is exactly this chord.
    win?.addEventListener('blur', release);

    return {
        subscribers,
        isHeld: () => held,
        teardown: () => {
            cancelPending();
            doc.removeEventListener('keydown', onKey, true);
            doc.removeEventListener('keyup', onKey, true);
            win?.removeEventListener('blur', release);
        },
    };
}

function subscribe(doc: Document, notify: Subscriber): () => void {
    let tracker = trackers.get(doc);
    if (!tracker) {
        tracker = createTracker(doc);
        trackers.set(doc, tracker);
    }
    const active = tracker;
    active.subscribers.add(notify);
    // Adopt whatever the state already is — a citation can mount (or a thread
    // can re-render) while the key is down.
    notify(active.isHeld());

    return () => {
        active.subscribers.delete(notify);
        if (active.subscribers.size === 0) {
            active.teardown();
            trackers.delete(doc);
        }
    };
}

/** What {@link useAlternateActivation} hands back to a citation. */
export interface AlternateActivation {
    /** Whether the modifier is currently held. */
    isAlternate: boolean;
    /** Attach to the rendered element, so the hook can find its document. */
    ref: MutableRefObject<HTMLSpanElement | null>;
}

/**
 * Tracks whether the alternate-activation modifier is being held.
 *
 * A citation names two things at once: the passage it cites and the work the
 * passage comes from. The default hover/click acts on the passage; holding the
 * modifier acts on the work. See {@link hasAlternateModifier} for which key that
 * is and why.
 *
 * The state is document-wide rather than per-hover, so holding the key restyles
 * every citation at once and reads as a mode — which is also the only thing that
 * makes the gesture discoverable. Listeners are shared across all citations in a
 * document and torn down with the last one, and each citation tracks the
 * document it actually renders in, so a second window follows its own keyboard.
 */
export function useAlternateActivation(): AlternateActivation {
    const ref = useRef<HTMLSpanElement | null>(null);
    const [isAlternate, setIsAlternate] = useState(false);

    useEffect(() => {
        // Effects run after mount, so the element (and its document) is present.
        // A citation never moves between documents, so this subscribes once.
        const doc = ref.current?.ownerDocument;
        if (!doc) return;
        return subscribe(doc, setIsAlternate);
    }, []);

    return { isAlternate, ref };
}
