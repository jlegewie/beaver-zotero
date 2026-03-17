import React from "react";


/** Section label displayed above a settings group */
export const SectionLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div className="text-lg font-color-primary font-bold" style={{ marginTop: '20px', marginBottom: '6px', paddingLeft: '2px' }}>
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

/** Individual setting row with title, description, and optional control */
export const SettingsRow: React.FC<SettingsRowProps> = ({
    title, description, control, onClick, disabled, tooltip, hasBorder = false, className = ''
}) => (
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
            <div className="font-color-primary text-base font-medium">{title}</div>
            {description && (
                <div className="font-color-secondary text-base">{description}</div>
            )}
        </div>
        {control && (
            <div className="display-flex flex-row items-center flex-shrink-0">
                {control}
            </div>
        )}
    </div>
);

export const DocLink: React.FC<{ path: string; children: React.ReactNode }> = ({ path, children }) => (
    <a
        onClick={() => Zotero.launchURL(`${process.env.WEBAPP_BASE_URL}/docs/${path}`)}
        target="_blank"
        rel="noopener noreferrer"
        className="text-link"
    >
        {children}
    </a>
);