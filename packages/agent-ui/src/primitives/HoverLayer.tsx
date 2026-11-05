import React, {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from 'react';

/**
 * Hover layers a surface floats over its own content: a peek that covers the
 * hovered element and the rows below it, and a card or tip under a smaller
 * anchor. Unlike `Tooltip`, a layer stays open while the pointer is over it,
 * so a card can hold links and buttons.
 *
 * The layers render once, at the provider, rather than inside the element
 * they describe. A grid's cells sit in sticky headers and columns, each its
 * own stacking context, and a popup rendered inside one of them is painted
 * under the next. Rendered at the surface they paint over everything in it.
 * They are `position: fixed` and never portalled: a Zotero chrome document
 * need not have a `body` to portal into.
 */

/** Two slots: a peek, and a card that may be opened from inside it. */
export type HoverSlot = 'peek' | 'card';

/** How a layer is drawn and placed. */
export type HoverVariant =
    /** Covers the anchor from its top-left corner at its width, growing down. */
    | 'peek'
    /** A light card under the anchor. */
    | 'card'
    /** A dark one-paragraph tip under the anchor. */
    | 'tip';

interface OpenLayer {
    anchor: HTMLElement;
    render: () => React.ReactNode;
    variant: HoverVariant;
    /** Identifies what is shown, so re-hovering the same anchor keeps it. */
    id: string;
    width?: number;
}

export interface HoverLayerApi {
    /** Shows `render` for `anchor` in `slot` after the open delay. */
    hoverIn(slot: HoverSlot, layer: OpenLayer, delayMs?: number): void;
    /** Hides the slot shortly after, unless the pointer reaches the layer. */
    hoverOut(slot: HoverSlot): void;
    /** Hides a slot at once (a click on its anchor). */
    hide(slot?: HoverSlot): void;
    /** Whether `id` is the open layer of `slot`. */
    isOpen(slot: HoverSlot, id: string): boolean;
}

const HoverLayerContext = createContext<HoverLayerApi | null>(null);

/** The surface's hover layers, or null outside a {@link HoverLayerProvider}. */
export function useHoverLayer(): HoverLayerApi | null {
    return useContext(HoverLayerContext);
}

const OPEN_DELAY_MS = 320;
const CLOSE_DELAY_MS = 140;
const EDGE_PX = 8;
/**
 * How long after its last event a wheel gesture that began over a layer goes
 * on scrolling the content beneath: Gecko's wheel transaction timeout
 * (`mousewheel.transaction.timeout`).
 */
const WHEEL_GESTURE_MS = 1500;
/** Pointer travel that ends such a gesture, as it ends Gecko's transaction. */
const WHEEL_MOVE_PX = 4;

/**
 * Provides the hover layers to everything inside it and draws them. Put it
 * around a whole surface; nested providers each draw their own.
 */
export function HoverLayerProvider({ children }: { children: React.ReactNode }): React.ReactElement {
    const [layers, setLayers] = useState<Partial<Record<HoverSlot, OpenLayer>>>({});
    const layersRef = useRef(layers);
    layersRef.current = layers;
    const openTimers = useRef<Partial<Record<HoverSlot, ReturnType<typeof setTimeout>>>>({});
    const closeTimers = useRef<Partial<Record<HoverSlot, ReturnType<typeof setTimeout>>>>({});
    const peekRef = useRef<HTMLDivElement | null>(null);
    /** Ends the wheel gesture being passed to the content beneath, if any. */
    const wheelPass = useRef<(() => void) | null>(null);

    const clear = (timers: typeof openTimers, slot: HoverSlot) => {
        const timer = timers.current[slot];
        if (timer) clearTimeout(timer);
        delete timers.current[slot];
    };

    const hide = useCallback((slot?: HoverSlot) => {
        const slots: HoverSlot[] = slot ? [slot] : ['peek', 'card'];
        for (const s of slots) {
            clear(openTimers, s);
            clear(closeTimers, s);
        }
        setLayers((current) => {
            if (slots.every((s) => !current[s])) return current;
            const next = { ...current };
            for (const s of slots) delete next[s];
            // A card opened from inside the peek goes with it.
            if (slots.includes('peek') && next.card && peekRef.current?.contains(next.card.anchor)) delete next.card;
            return next;
        });
    }, []);

    const cancelClose = useCallback((slot: HoverSlot) => clear(closeTimers, slot), []);

    const hoverOut = useCallback(
        (slot: HoverSlot) => {
            clear(openTimers, slot);
            clear(closeTimers, slot);
            closeTimers.current[slot] = setTimeout(() => hide(slot), CLOSE_DELAY_MS);
        },
        [hide],
    );

    const hoverIn = useCallback(
        (slot: HoverSlot, layer: OpenLayer, delayMs = OPEN_DELAY_MS) => {
            clear(closeTimers, slot);
            clear(openTimers, slot);
            if (layersRef.current[slot]?.id === layer.id) return;
            // An anchor under the open peek is covered by it: its copy in the
            // peek opens the card instead.
            const peek = layersRef.current.peek;
            if (slot === 'card' && peek && peek.anchor !== layer.anchor && peek.anchor.contains(layer.anchor)) return;
            // With a layer already open in the slot, the next one follows at
            // once; not while the wheel scrolls beneath, which has just closed it.
            const delay = layersRef.current[slot] && !wheelPass.current ? 0 : delayMs;
            const open = () =>
                setLayers((current) => {
                    const next = { ...current, [slot]: layer };
                    // A peek covers the cards of what it covers.
                    if (slot === 'peek' && next.card && layer.anchor.contains(next.card.anchor)) delete next.card;
                    return next;
                });
            if (delay <= 0) open();
            else openTimers.current[slot] = setTimeout(open, delay);
        },
        [],
    );

    const isOpen = useCallback((slot: HoverSlot, id: string) => layersRef.current[slot]?.id === id, []);

    // A wheel over a layer scrolls what it covers and closes it; the rest of
    // the gesture follows (see `passWheelGesture`).
    const onLayerWheel = useCallback(
        (event: React.WheelEvent<HTMLElement>, anchor: HTMLElement) => {
            if (wheelPass.current) return;
            const scroller = scrollBeneath(event, anchor);
            if (!scroller) return;
            wheelPass.current = passWheelGesture(scroller, event, () => {
                wheelPass.current = null;
            });
            hide();
        },
        [hide],
    );

    useEffect(
        () => () => {
            for (const slot of ['peek', 'card'] as HoverSlot[]) {
                clear(openTimers, slot);
                clear(closeTimers, slot);
            }
            wheelPass.current?.();
        },
        [],
    );

    // A scroll moves the anchors out from under their layers: close them.
    const anyOpen = !!layers.peek || !!layers.card;
    const doc = (layers.peek ?? layers.card)?.anchor.ownerDocument;
    useEffect(() => {
        if (!anyOpen || !doc) return;
        const onScroll = (event: Event) => {
            const target = event.target as Node | null;
            // Scrolling inside a layer (a long passage) keeps it.
            if (target && target.nodeType === 1 && (target as Element).closest?.('.bt-hover-layer')) return;
            hide();
        };
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && !event.isComposing) hide();
        };
        doc.addEventListener('scroll', onScroll, true);
        doc.addEventListener('keydown', onKey, true);
        return () => {
            doc.removeEventListener('scroll', onScroll, true);
            doc.removeEventListener('keydown', onKey, true);
        };
    }, [anyOpen, doc, hide]);

    const api = useMemo<HoverLayerApi>(() => ({ hoverIn, hoverOut, hide, isOpen }), [hoverIn, hoverOut, hide, isOpen]);

    return (
        <HoverLayerContext.Provider value={api}>
            {children}
            {layers.peek ? (
                <PlacedLayer
                    key={`peek:${layers.peek.id}`}
                    layer={layers.peek}
                    elementRef={peekRef}
                    onEnter={() => cancelClose('peek')}
                    // A card opened from the peek stands clear of it, so the
                    // pointer crosses the peek to reach it: keep it meanwhile.
                    // Leaving the peek closes both, unless it enters the card.
                    onOver={() => {
                        const card = layersRef.current.card;
                        if (card && peekRef.current?.contains(card.anchor)) cancelClose('card');
                    }}
                    onLeave={() => hoverOut('peek')}
                    onWheel={onLayerWheel}
                />
            ) : null}
            {layers.card ? (
                <PlacedLayer
                    key={`card:${layers.card.id}`}
                    layer={layers.card}
                    clearOf={peekRef}
                    onEnter={() => {
                        cancelClose('card');
                        // The pointer left the peek for a card opened from it.
                        if (peekRef.current?.contains(layers.card!.anchor)) cancelClose('peek');
                    }}
                    onLeave={() => {
                        hoverOut('card');
                        if (peekRef.current?.contains(layers.card!.anchor)) hoverOut('peek');
                    }}
                    onWheel={onLayerWheel}
                />
            ) : null}
        </HoverLayerContext.Provider>
    );
}

/** One open layer, placed against its anchor once its own size is known. */
function PlacedLayer({
    layer,
    elementRef,
    clearOf,
    onEnter,
    onOver,
    onLeave,
    onWheel,
}: {
    layer: OpenLayer;
    elementRef?: React.MutableRefObject<HTMLDivElement | null>;
    /** A layer a card opened from inside must not cover (the peek it came from). */
    clearOf?: React.MutableRefObject<HTMLDivElement | null>;
    onEnter(): void;
    /** The pointer moved onto an element inside the layer. */
    onOver?(): void;
    onLeave(): void;
    onWheel(event: React.WheelEvent<HTMLElement>, anchor: HTMLElement): void;
}): React.ReactElement {
    const ref = useRef<HTMLDivElement | null>(null);
    const [position, setPosition] = useState<
        { left: number; top?: number; bottom?: number; width?: number; minHeight?: number; maxHeight?: number } | null
    >(null);

    useLayoutEffect(() => {
        const el = ref.current;
        const anchor = layer.anchor;
        const view = anchor.ownerDocument.defaultView;
        if (!el || !view || !anchor.isConnected) return;
        const rect = anchor.getBoundingClientRect();
        const peekWidth = Math.max(rect.width, layer.width ?? 0);
        // The peek's height depends on its width: measure it at that width.
        // It covers at least its anchor, so a short cell's peek hides the cell.
        if (layer.variant === 'peek') {
            el.style.width = `${peekWidth}px`;
            el.style.minHeight = `${rect.height}px`;
        }
        const box = el.getBoundingClientRect();
        const viewW = view.innerWidth;
        const viewH = view.innerHeight;
        if (layer.variant === 'peek') {
            const width = peekWidth;
            // Anchored to the cell's top-left and growing down over the rows
            // below; lifted only as far as the window's bottom edge requires.
            const top = Math.max(EDGE_PX, Math.min(rect.top, viewH - box.height - EDGE_PX));
            const left = Math.max(EDGE_PX, Math.min(rect.left, viewW - width - EDGE_PX));
            setPosition({ left, top, width, minHeight: rect.height });
            return;
        }
        // A card from a tag inside the peek keeps clear of the whole peek: the
        // tags follow the cell's text, and a card above the tag would hide it.
        const host = clearOf?.current;
        const clear = host && host !== el && host.contains(anchor) ? host.getBoundingClientRect() : undefined;
        const placement = placeCard(rect, box, { width: viewW, height: viewH }, clear);
        // A tip is one short paragraph and does not scroll: only a card is bounded.
        setPosition(layer.variant === 'card' ? placement : { ...placement, maxHeight: undefined });
    }, [layer]);

    return (
        <div
            ref={(el) => {
                ref.current = el;
                if (elementRef) elementRef.current = el;
            }}
            className={`bt-hover-layer bt-hover-${layer.variant}`}
            role={layer.variant === 'tip' ? 'tooltip' : 'dialog'}
            style={{
                position: 'fixed',
                left: position?.left ?? 0,
                top: position ? (position.top ?? 'auto') : 0,
                bottom: position?.bottom,
                width: layer.variant === 'peek' ? position?.width : layer.width,
                minHeight: position?.minHeight,
                maxHeight: position?.maxHeight,
                visibility: position ? 'visible' : 'hidden',
            }}
            onMouseEnter={onEnter}
            onMouseOver={onOver}
            onMouseLeave={onLeave}
            onWheel={(event) => onWheel(event, layer.anchor)}
        >
            {layer.render()}
        </div>
    );
}

/** Where a card or tip goes: `top` or `bottom` (the edge it grows from), in window coordinates. */
export interface CardPlacement {
    left: number;
    top?: number;
    bottom?: number;
    /** The room on the chosen side; a taller card scrolls within it. */
    maxHeight: number;
}

/** Gap between an anchor and its card. */
const CARD_GAP_PX = 4;
/** The least room above or below worth a card that scrolls; less, and it goes beside the anchor. */
const MIN_CARD_PX = 160;

/**
 * Places a card of `size` next to `anchor` without ever covering the anchor,
 * or `clear` when given (the peek the anchor sits in): below them, else above
 * them, else on the roomier of the two sides with its height bounded to that
 * room. Only when neither side has room for a usable card does it go beside
 * them. The card stays left-aligned with the anchor. A card above is held by
 * its bottom edge, so content that grows after placement (an expanded
 * passage) grows away from the anchor rather than over it.
 */
export function placeCard(
    anchor: { top: number; bottom: number; left: number; right: number },
    size: { width: number; height: number },
    view: { width: number; height: number },
    clear?: { top: number; bottom: number; left: number; right: number },
): CardPlacement {
    const keep = clear
        ? {
              top: Math.min(anchor.top, clear.top),
              bottom: Math.max(anchor.bottom, clear.bottom),
              left: Math.min(anchor.left, clear.left),
              right: Math.max(anchor.right, clear.right),
          }
        : anchor;
    const clampLeft = (left: number) => Math.max(EDGE_PX, Math.min(left, view.width - size.width - EDGE_PX));
    const below: CardPlacement = {
        left: clampLeft(anchor.left),
        top: keep.bottom + CARD_GAP_PX,
        maxHeight: Math.max(0, view.height - EDGE_PX - keep.bottom - CARD_GAP_PX),
    };
    const above: CardPlacement = {
        left: clampLeft(anchor.left),
        bottom: view.height - keep.top + CARD_GAP_PX,
        maxHeight: Math.max(0, keep.top - CARD_GAP_PX - EDGE_PX),
    };
    if (size.height <= below.maxHeight) return below;
    if (size.height <= above.maxHeight) return above;
    const roomier = above.maxHeight > below.maxHeight ? above : below;
    if (roomier.maxHeight >= MIN_CARD_PX) return roomier;
    // Too little room above and below: beside, level with the anchor's top.
    const right = keep.right + CARD_GAP_PX;
    const left = keep.left - CARD_GAP_PX - size.width;
    const fitsRight = right + size.width <= view.width - EDGE_PX;
    if (!fitsRight && left < EDGE_PX) return roomier;
    const fullHeight = Math.max(0, view.height - 2 * EDGE_PX);
    const top = Math.max(EDGE_PX, Math.min(anchor.top, view.height - EDGE_PX - Math.min(size.height, fullHeight)));
    return { left: fitsRight ? right : left, top, maxHeight: Math.max(0, view.height - EDGE_PX - top) };
}

/**
 * A layer floats over the content it belongs to, so a wheel over it would
 * scroll nothing: unless the layer itself scrolls that way, the wheel scrolls
 * the anchor's scroll container instead. Returns the container it scrolled.
 */
function scrollBeneath(event: React.WheelEvent<HTMLElement>, anchor: HTMLElement): HTMLElement | null {
    const { deltaX, deltaY } = event;
    for (let el = event.target as HTMLElement | null; el && el !== event.currentTarget.parentElement; el = el.parentElement) {
        if (canScroll(el, deltaX, deltaY)) return null;
    }
    let scroller = anchor.parentElement;
    while (scroller && !canScroll(scroller, deltaX, deltaY)) scroller = scroller.parentElement;
    if (scroller) scrollByWheel(scroller, event);
    return scroller;
}

/**
 * Scrolls `scroller` with the rest of a wheel gesture whose first event
 * reached it through a layer, until the wheel rests or the pointer moves.
 * Gecko keeps a gesture on the target its first event hit: the layer, which
 * scrolls nothing, and still does once the layer has closed. Each later event
 * over the scroller (or a layer) scrolls it here instead, cancelled so the
 * browser cannot scroll it a second time. Returns a function that ends it.
 */
function passWheelGesture(scroller: HTMLElement, first: React.WheelEvent<HTMLElement>, onEnd: () => void): () => void {
    const doc = scroller.ownerDocument;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ended = false;
    const moved = (event: MouseEvent) =>
        Math.abs(event.screenX - first.screenX) > WHEEL_MOVE_PX || Math.abs(event.screenY - first.screenY) > WHEEL_MOVE_PX;
    const onWheel = (event: WheelEvent) => {
        const target = event.target as Element | null;
        if (moved(event) || !target || !(scroller.contains(target) || target.closest?.('.bt-hover-layer'))) {
            end();
            return;
        }
        event.preventDefault();
        scrollByWheel(scroller, event);
        rest();
    };
    const onMove = (event: MouseEvent) => {
        if (moved(event)) end();
    };
    const rest = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(end, WHEEL_GESTURE_MS);
    };
    function end() {
        if (ended) return;
        ended = true;
        if (timer) clearTimeout(timer);
        doc.removeEventListener('wheel', onWheel, true);
        doc.removeEventListener('mousemove', onMove, true);
        onEnd();
    }
    doc.addEventListener('wheel', onWheel, { capture: true, passive: false });
    doc.addEventListener('mousemove', onMove, true);
    rest();
    return end;
}

/** Scrolls `scroller` by a wheel event's deltas. */
function scrollByWheel(scroller: HTMLElement, event: { deltaX: number; deltaY: number; deltaMode: number }): void {
    // Lines (a mouse wheel in some setups) and pages are not pixels.
    const page = event.deltaMode === 2;
    const line = event.deltaMode === 1 ? 16 : 1;
    scroller.scrollBy({
        left: event.deltaX * (page ? scroller.clientWidth : line),
        top: event.deltaY * (page ? scroller.clientHeight : line),
    });
}

/** Whether `el` scrolls and has room left to scroll by the wheel's deltas. */
function canScroll(el: HTMLElement, deltaX: number, deltaY: number): boolean {
    const view = el.ownerDocument.defaultView;
    const style = view?.getComputedStyle(el);
    if (!style) return false;
    const scrolls = (overflow: string) => overflow === 'auto' || overflow === 'scroll';
    if (deltaY && scrolls(style.overflowY)) {
        if (deltaY < 0 ? el.scrollTop > 0 : el.scrollTop + el.clientHeight < el.scrollHeight - 1) return true;
    }
    if (deltaX && scrolls(style.overflowX)) {
        if (deltaX < 0 ? el.scrollLeft > 0 : el.scrollLeft + el.clientWidth < el.scrollWidth - 1) return true;
    }
    return false;
}

let anchorSequence = 0;

/**
 * Hover and keyboard-focus wiring for an element that opens a layer. Spread
 * the returned handlers on the anchor element; `render` is called only while
 * the layer is open.
 */
export function useHoverAnchor({
    slot,
    variant,
    render,
    width,
    delayMs,
    disabled = false,
}: {
    slot: HoverSlot;
    variant: HoverVariant;
    render: () => React.ReactNode;
    width?: number;
    delayMs?: number;
    disabled?: boolean;
}): {
    onMouseEnter(event: React.MouseEvent<HTMLElement>): void;
    onMouseLeave(): void;
    onFocus(event: React.FocusEvent<HTMLElement>): void;
    onBlur(): void;
    onMouseDown(): void;
} {
    const api = useHoverLayer();
    const idRef = useRef<string>('');
    if (!idRef.current) idRef.current = `hover-${++anchorSequence}`;
    const renderRef = useRef(render);
    renderRef.current = render;
    const open = (anchor: HTMLElement) => {
        if (!api || disabled) return;
        api.hoverIn(slot, { anchor, variant, width, id: idRef.current, render: () => renderRef.current() }, delayMs);
    };
    return {
        onMouseEnter: (event) => open(event.currentTarget),
        onMouseLeave: () => api?.hoverOut(slot),
        onFocus: (event) => {
            // Only keyboard focus: a click focuses too, and must not reopen it.
            if (event.currentTarget.matches?.(':focus-visible')) open(event.currentTarget);
        },
        onBlur: () => api?.hoverOut(slot),
        onMouseDown: () => api?.hide(slot),
    };
}
