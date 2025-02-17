import React from 'react'
import { CSSItemTypeIcon, CSSIcon } from "./icons"

interface ContextItemProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
    icon?: string
    onRemove?: () => void
    tooltip?: string
}

export const ContextItem = React.forwardRef<HTMLButtonElement, ContextItemProps>(
    function ContextItem(props, ref) {
        const {
            children,
            icon,
            onRemove,
            tooltip,
            className,
            ...rest
        } = props

        const iconElement = icon ? (
            <span className="beaver-context-item-icon">
                <CSSItemTypeIcon itemType={icon} />
            </span>
        ) : null

        return (
            <button
                ref={ref}
                title={tooltip}
                className={`beaver-context-item ${className || ''}`}
                {...rest}
            >
                {iconElement}
                {children}
                {onRemove && (
                    <span 
                        role="button"
                        className="beaver-context-item-remove"
                        onClick={(e) => {
                            e.stopPropagation()
                            onRemove()
                        }}
                    >
                        <CSSIcon name="x-8" className="icon-16" />
                    </span>
                )}
            </button>
        )
    }
)