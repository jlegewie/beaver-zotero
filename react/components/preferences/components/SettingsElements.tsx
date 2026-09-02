import React from "react";
import DocsLink from "@beaver/agent-ui/primitives/DocsLink";
import { getHost } from "@beaver/agent-ui/host";

/**
 * Third-party benchmark cited as the rule of thumb for whether a custom model
 * is capable enough to drive Beaver. Referenced from more than one settings
 * surface, so it lives with the shared settings elements.
 */
export const INTELLIGENCE_INDEX_URL =
    'https://artificialanalysis.ai/evaluations/artificial-analysis-intelligence-index';


/** Section label displayed above a settings group */
export const SectionLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div role="heading" aria-level={2} className="text-lg font-color-primary font-bold" style={{ marginTop: '20px', marginBottom: '6px', paddingLeft: '2px' }}>
        {children}
    </div>
);

export const SectionHeader: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div role="heading" aria-level={2} className="text-xl font-color-primary font-bold" style={{ marginTop: '8px', marginBottom: '6px', paddingLeft: '4px' }}>
        {children}
    </div>
);

export const SectionDescription: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div className="display-flex flex-col gap-05 flex-1 min-w-0 py-1 mb-2" style={{ paddingLeft: '4px' }}>
        <div className="font-color-secondary text-base">
            {children}
        </div>
    </div>
);

/** Card container for grouping related settings */
export const SettingsGroup: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = '' }) => (
    <div className={`display-flex flex-col rounded-card border-card overflow-hidden ${className}`}>
        {children}
    </div>
);

interface SettingsRowProps {
    title: string;
    description?: React.ReactNode;
    control?: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    tooltip?: string;
    hasBorder?: boolean;
    className?: string;
}

function hasInteractiveContent(node: React.ReactNode): boolean {
    return React.Children.toArray(node).some((child) => {
        if (!React.isValidElement(child)) {
            return false;
        }

        const type = child.type;
        if (typeof type === 'string' && ['a', 'button', 'input', 'select', 'textarea'].includes(type)) {
            return true;
        }
        if (typeof type !== 'string' && 'path' in (child.props as Record<string, unknown>)) {
            return true;
        }

        return hasInteractiveContent((child.props as { children?: React.ReactNode }).children);
    });
}

/** Individual setting row with title, description, and optional control */
export const SettingsRow: React.FC<SettingsRowProps> = ({
    title, description, control, onClick, disabled, tooltip, hasBorder = false, className = ''
}) => {
    const titleId = React.useId();
    const descId = React.useId();

    // Give the control an accessible name from the visible title so screen
    // readers announce what each checkbox/select/etc. controls. Avoid attaching
    // the full row description by default because it makes keyboard navigation noisy.
    const controlProps = React.isValidElement(control) ? (control.props as Record<string, unknown>) : null;
    const controlHasLabel = !!controlProps && (controlProps['aria-label'] != null || controlProps['aria-labelledby'] != null || controlProps.ariaLabel != null);
    const labelledControl = React.isValidElement(control) && !controlHasLabel
        ? React.cloneElement(control as React.ReactElement<Record<string, unknown>>, {
            'aria-labelledby': titleId,
        })
        : control;
    const hideDescriptionFromScreenReaders = !!control && !!description && !hasInteractiveContent(description);

    return (
        <div
            className={`
                display-flex flex-row items-center justify-between gap-4
                ${hasBorder ? 'border-top-quinary' : ''}
                ${onClick && !disabled ? 'cursor-pointer' : ''}
                ${disabled ? 'opacity-60 cursor-not-allowed' : ''}
                ${className}
            `}
            style={{ padding: '8px 12px', minHeight: '38px' }}
            onClick={(e) => {
                if (disabled || !onClick) return;
                const target = e.target as HTMLElement;
                if (target.tagName === 'A' || target.closest('a')) return;
                onClick();
            }}
        >
            <div className="display-flex flex-col gap-05 flex-1 min-w-0">
                <div id={titleId} className="font-color-primary text-base font-medium">{title}</div>
                {description && (
                    <div
                        id={descId}
                        className="font-color-secondary text-base"
                        aria-hidden={hideDescriptionFromScreenReaders ? true : undefined}
                    >
                        {description}
                    </div>
                )}
            </div>
            {control && (
                <div className="display-flex flex-row items-center flex-shrink-0">
                    {labelledControl}
                </div>
            )}
        </div>
    );
};

/**
 * Link to a documentation page, given a path relative to the docs site root.
 *
 * Delegates to the shared {@link DocsLink}, which resolves the base URL and
 * opens the URL through the host registry: the preferences and every shared
 * surface that links to the docs then behave identically, and there is one
 * implementation to change when either half moves.
 */
export const DocLink: React.FC<{ path: string; children: React.ReactNode }> = ({ path, children }) => (
    <DocsLink path={path}>{children}</DocsLink>
);

/**
 * Link to a page outside the Beaver documentation site.
 *
 * A chrome window may not navigate itself, so the click is routed through the
 * host's navigation slice exactly as {@link DocLink} does; only the href is
 * absolute here rather than resolved from a docs base URL.
 */
export const ExternalLink: React.FC<{ href: string; children: React.ReactNode; className?: string }> = ({
    href,
    children,
    className,
}) => (
    <a
        href={href}
        onClick={(event) => {
            const navigation = getHost().navigation;
            if (!navigation) return;
            event.preventDefault();
            navigation.openExternalUrl(href);
        }}
        target="_blank"
        rel="noopener noreferrer"
        className={className ? `text-link ${className}` : 'text-link'}
    >
        {children}
    </a>
);
