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
            // With a layer already open in the slot, the next one follows at once.
            const delay = layersRef.current[slot] ? 0 : delayMs;
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

    useEffect(
        () => () => {
            for (const slot of ['peek', 'card'] as HoverSlot[]) {
                clear(openTimers, slot);
                clear(closeTimers, slot);
            }
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
                    onLeave={() => hoverOut('peek')}
                />
            ) : null}
            {layers.card ? (
                <PlacedLayer
                    key={`card:${layers.card.id}`}
                    layer={layers.card}
                    onEnter={() => {
                        cancelClose('card');
                        // The pointer left the peek for a card opened from it.
                        if (peekRef.current?.contains(layers.card!.anchor)) cancelClose('peek');
                    }}
                    onLeave={() => {
                        hoverOut('card');
                        if (peekRef.current?.contains(layers.card!.anchor)) hoverOut('peek');
                    }}
                />
            ) : null}
        </HoverLayerContext.Provider>
    );
}

/** One open layer, placed against its anchor once its own size is known. */
function PlacedLayer({
    layer,
    elementRef,
    onEnter,
    onLeave,
}: {
    layer: OpenLayer;
    elementRef?: React.MutableRefObject<HTMLDivElement | null>;
    onEnter(): void;
    onLeave(): void;
}): React.ReactElement {
    const ref = useRef<HTMLDivElement | null>(null);
    const [position, setPosition] = useState<{ left: number; top: number; width?: number } | null>(null);

    useLayoutEffect(() => {
        const el = ref.current;
        const anchor = layer.anchor;
        const view = anchor.ownerDocument.defaultView;
        if (!el || !view || !anchor.isConnected) return;
        const rect = anchor.getBoundingClientRect();
        const peekWidth = Math.max(rect.width, layer.width ?? 0);
        // The peek's height depends on its width: measure it at that width.
        if (layer.variant === 'peek') el.style.width = `${peekWidth}px`;
        const box = el.getBoundingClientRect();
        const viewW = view.innerWidth;
        const viewH = view.innerHeight;
        if (layer.variant === 'peek') {
            const width = peekWidth;
            // Anchored to the cell's top-left and growing down over the rows
            // below; lifted only as far as the window's bottom edge requires.
            const top = Math.max(EDGE_PX, Math.min(rect.top, viewH - box.height - EDGE_PX));
            const left = Math.max(EDGE_PX, Math.min(rect.left, viewW - width - EDGE_PX));
            setPosition({ left, top, width });
            return;
        }
        // Below the anchor, else above it; a card that fits neither is held
        // inside the window and scrolls within its bounded height.
        const below = rect.bottom + 4;
        const above = rect.top - box.height - 4;
        const top = below + box.height <= viewH - EDGE_PX
            ? below
            : above >= EDGE_PX
              ? above
              : Math.max(EDGE_PX, viewH - box.height - EDGE_PX);
        const left = Math.max(EDGE_PX, Math.min(rect.left, viewW - box.width - EDGE_PX));
        setPosition({ left, top });
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
                top: position?.top ?? 0,
                width: layer.variant === 'peek' ? position?.width : layer.width,
                visibility: position ? 'visible' : 'hidden',
            }}
            onMouseEnter={onEnter}
            onMouseLeave={onLeave}
        >
            {layer.render()}
        </div>
    );
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
    shouldOpen,
}: {
    slot: HoverSlot;
    variant: HoverVariant;
    render: () => React.ReactNode;
    width?: number;
    delayMs?: number;
    disabled?: boolean;
    /** Checked when the pointer arrives; false keeps the layer closed (an untruncated cell). */
    shouldOpen?: (anchor: HTMLElement) => boolean;
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
        if (shouldOpen && !shouldOpen(anchor)) return;
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
