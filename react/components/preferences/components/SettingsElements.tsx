import React from "react";


/** Section label displayed above a settings group */
export const SectionLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div role="heading" aria-level={2} className="text-lg font-color-primary font-bold" style={{ marginTop: '20px', marginBottom: '6px', paddingLeft: '2px' }}>
        {children}
    </div>
);

/** Card container for grouping related settings */
export const SettingsGroup: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = '' }) => (
    <div className={`display-flex flex-col rounded-lg border-quinary overflow-hidden ${className}`}>
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
            className={`display-flex flex-row items-center justify-between gap-4 ${hasBorder ? 'border-top-quinary' : ''} ${onClick && !disabled ? 'cursor-pointer' : ''} ${disabled ? 'opacity-60 cursor-not-allowed' : ''} ${className}`}
            style={{ padding: '8px 12px', minHeight: '38px' }}
            onClick={(e) => {
                if (disabled || !onClick) return;
                const target = e.target as HTMLElement;
                if (target.tagName === 'A' || target.closest('a')) return;
                onClick();
            }}
            title={tooltip}
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

export const DocLink: React.FC<{ path: string; children: React.ReactNode }> = ({ path, children }) => {
    const href = `${process.env.WEBAPP_BASE_URL}/docs/${path}`;
    return (
    <a
        href={href}
        onClick={(event) => {
            event.preventDefault();
            Zotero.launchURL(href);
        }}
        target="_blank"
        rel="noopener noreferrer"
        className="text-link"
    >
        {children}
    </a>
    );
};
