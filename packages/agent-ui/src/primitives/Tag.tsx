import React, {
  createContext,
  useContext,
  useCallback,
  useMemo,
  forwardRef,
  HTMLAttributes,
  ButtonHTMLAttributes,
  PropsWithChildren,
  MouseEvent,
  KeyboardEvent,
} from "react";

// 1) ----------------- TYPES & CONTEXT ------------------
interface TagContextValue {
  onClose?: () => void;
  clickable?: boolean;
  onClick?: (event: MouseEvent<HTMLElement>) => void;
  closable: boolean;
}

const TagContext = createContext<TagContextValue | null>(null);

function useTagContext() {
  const ctx = useContext(TagContext);
  if (!ctx) {
    throw new Error("Use Tag sub-components within <TagRoot>.");
  }
  return ctx;
}

// 2) --------------- TAG ROOT COMPONENT -----------------
export interface TagRootProps extends HTMLAttributes<HTMLSpanElement> {
  /** Whether the Tag can be clicked (acts like a button). */
  clickable?: boolean;
  /** Callback triggered when close trigger is clicked. */
  onClose?: () => void;
  /** Whether to display a close trigger. Defaults to true if onClose is present. */
  closable?: boolean;
}

/**
 * The outer container of the Tag. Renders as a <span> by default.
 */
export const TagRoot = forwardRef<HTMLSpanElement, PropsWithChildren<TagRootProps>>(
  function TagRoot(props, ref) {
    const {
      children,
      onClose,
      closable = !!onClose,
      clickable = false,
      onClick,
      style,
      ...rest
    } = props;

    // Provide Tag props via context
    const contextValue = useMemo<TagContextValue>(
      () => ({
        onClose,
        clickable,
        onClick,
        closable,
      }),
      [onClose, clickable, onClick, closable]
    );

    // Keyboard accessibility if TagRoot is clickable but not a native button
    const handleKeyDown = useCallback(
      (event: KeyboardEvent<HTMLSpanElement>) => {
        if (!clickable) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onClick?.(event as unknown as MouseEvent<HTMLSpanElement>);
        }
      },
      [clickable, onClick]
    );

    return (
      <TagContext.Provider value={contextValue}>
        <span
          ref={ref}
          role={clickable ? "button" : undefined}
          tabIndex={clickable ? 0 : undefined}
          onClick={clickable ? onClick : undefined}
          onKeyDown={handleKeyDown}
          // Minimal styling, adjust to taste
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "4px",
            padding: "4px 8px",
            borderRadius: "4px",
            backgroundColor: "#f3f3f3",
            border: "1px solid #ccc",
            cursor: clickable ? "pointer" : "default",
            ...style,
          }}
          {...rest}
        >
          {children}
        </span>
      </TagContext.Provider>
    );
  }
);

// 3) -------------- TAG LABEL COMPONENT -----------------
export type TagLabelProps = HTMLAttributes<HTMLSpanElement>;

/**
 * Text label for the Tag
 */
export const TagLabel = forwardRef<HTMLSpanElement, TagLabelProps>(
  function TagLabel({ children, style, ...rest }, ref) {
    // You can read context if needed, or just skip it if the label doesn't need anything.
    useTagContext();

    return (
      <span
        ref={ref}
        style={{
          // minimal styling
          fontSize: "0.875rem",
          ...style,
        }}
        {...rest}
      >
        {children}
      </span>
    );
  }
);

// 4) -------- TAG START ELEMENT COMPONENT --------------
export type TagStartElementProps = HTMLAttributes<HTMLSpanElement>;

/**
 * An element (e.g., an icon) to appear on the left side of the Tag.
 */
export const TagStartElement = forwardRef<HTMLSpanElement, TagStartElementProps>(
  function TagStartElement({ children, style, ...rest }, ref) {
    useTagContext();
    return (
      <span
        ref={ref}
        style={{
          display: "inline-flex",
          alignItems: "center",
          fontSize: "1.1rem",
          ...style,
        }}
        {...rest}
      >
        {children}
      </span>
    );
  }
);

// 5) -------- TAG END ELEMENT COMPONENT ---------------
export type TagEndElementProps = HTMLAttributes<HTMLSpanElement>;

/**
 * An element (e.g., an icon) to appear on the right side of the Tag.
 */
export const TagEndElement = forwardRef<HTMLSpanElement, TagEndElementProps>(
  function TagEndElement({ children, style, ...rest }, ref) {
    useTagContext();
    return (
      <span
        ref={ref}
        style={{
          display: "inline-flex",
          alignItems: "center",
          ...style,
        }}
        {...rest}
      >
        {children}
      </span>
    );
  }
);

// 6) ---------- TAG CLOSE TRIGGER COMPONENT -----------
export interface TagCloseTriggerProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** A custom icon or text to display for the close trigger (e.g., an "X"). */
  icon?: React.ReactNode;
}

/**
 * A dedicated close button for the Tag. Displays "×" by default.
 */
export const TagCloseTrigger = forwardRef<HTMLButtonElement, TagCloseTriggerProps>(
  function TagCloseTrigger(props, ref) {
    const { onClose, closable } = useTagContext();
    const { icon, onClick, ...rest } = props;

    if (!closable) {
      return null;
    }

    const handleClick = useCallback(
      (e: MouseEvent<HTMLButtonElement>) => {
        onClick?.(e);
        onClose?.();
      },
      [onClick, onClose]
    );

    return (
      <button
        type="button"
        ref={ref}
        onClick={handleClick}
        aria-label="Close tag"
        style={{
          cursor: "pointer",
          background: "transparent",
          border: "none",
          padding: 0,
          display: "inline-flex",
          alignItems: "center",
          fontSize: "1rem",
        }}
        {...rest}
      >
        {icon ?? "×"}
      </button>
    );
  }
);
