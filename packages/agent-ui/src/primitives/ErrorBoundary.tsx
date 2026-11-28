import React from 'react';

/** What a fallback receives: the error, and a way to render the children again. */
export interface ErrorBoundaryFallbackProps {
    error: Error;
    reset: () => void;
}

export interface ErrorBoundaryProps {
    children?: React.ReactNode;
    /** Rendered in place of the children after one of them threw while rendering. */
    fallback: (props: ErrorBoundaryFallbackProps) => React.ReactNode;
    /** Called once per caught error, with React's component stack. */
    onError?: (error: Error, info: React.ErrorInfo) => void;
    /**
     * A value that clears a caught error when it changes (compared with
     * `Object.is`), so the children get another try with the new input — a
     * different thread, an updated message.
     */
    resetKey?: unknown;
}

interface ErrorBoundaryState {
    error: Error | null;
}

/** A thrown value as an Error. Code can throw anything, and a DOMException from another realm fails `instanceof Error`. */
function toError(value: unknown): Error {
    if (value instanceof Error) return value;
    if (value && typeof value === 'object' && typeof (value as { message?: unknown }).message === 'string') {
        const error = new Error((value as { message: string }).message);
        const name = (value as { name?: unknown }).name;
        if (typeof name === 'string' && name) error.name = name;
        return error;
    }
    return new Error(String(value));
}

/**
 * Catches an exception thrown while rendering its children and shows
 * `fallback` instead, so one broken component does not unmount the whole
 * React root around it.
 *
 * Renders its children as they are, with no element of its own, so wrapping a
 * tree does not change its markup. React's server renderers do not run error
 * boundaries, so a static render (note export) behaves exactly as it would
 * without one.
 */
export default class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
    state: ErrorBoundaryState = { error: null };

    static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
        return { error: toError(error) };
    }

    componentDidCatch(error: unknown, info: React.ErrorInfo): void {
        this.props.onError?.(toError(error), info);
    }

    componentDidUpdate(previousProps: ErrorBoundaryProps, previousState: ErrorBoundaryState): void {
        // Only an error that was already showing: the update that caught it
        // may be the same one that changed the key (a new message that throws),
        // and resetting then would render the throwing children again forever.
        if (
            this.state.error !== null
            && previousState.error !== null
            && !Object.is(previousProps.resetKey, this.props.resetKey)
        ) {
            this.reset();
        }
    }

    reset = (): void => {
        this.setState({ error: null });
    };

    render(): React.ReactNode {
        const { error } = this.state;
        if (error) return this.props.fallback({ error, reset: this.reset });
        return this.props.children;
    }
}
