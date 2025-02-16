import React, { forwardRef, type CSSProperties } from 'react'
import { getCSSItemTypeIcon, CSSItemTypeIcon, CSSIcon } from "./icons.jsx"

interface ContextItemProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: 'solid' | 'outline' | 'ghost' | 'dark'
    size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'
    colorScheme?: string
    icon?: string
    onRemove?: () => void
    tooltip?: string
}

const baseStyles: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
    whiteSpace: 'nowrap',
    verticalAlign: 'middle',
    cursor: 'pointer',
    userSelect: 'none',
    border: '1px solid transparent',
    borderRadius: '0.375rem',
    fontWeight: 500,
    lineHeight: 1.2,
    transition: 'all 0.2s'
}

const sizeStyles: Record<string, CSSProperties> = {
    xs: { height: '24px', padding: '0 0.625rem', fontSize: '0.75rem' },
    sm: { height: '32px', padding: '0 0.75rem', fontSize: '0.875rem' },
    md: { height: '40px', padding: '0 1rem', fontSize: '1rem' },
    lg: { height: '48px', padding: '0 1.5rem', fontSize: '1.125rem' },
    xl: { height: '56px', padding: '0 1.75rem', fontSize: '1.25rem' }
}

const removeButtonStyles: CSSProperties = {
    marginLeft: '0.25rem',
    padding: '0 0.0rem',
    paddingRight: '0 0rem',
    backgroundColor: 'transparent',
    border: 'none',
    color: 'inherit',
    cursor: 'pointer',
    opacity: 0.6,
    fontSize: '1.1em',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    transition: 'all 0.2s ease'
}

export const ContextItem = forwardRef<HTMLButtonElement, ContextItemProps>(
    function ContextItem(props, ref) {
        const {
            children,
            variant = 'solid',
            size = 'md',
            colorScheme = 'gray',
            disabled,
            style,
            icon,
            onRemove,
            tooltip,
            ...rest
        } = props
        
        const [isHovered, setIsHovered] = React.useState(false);
        const [isRemoveHovered, setIsRemoveHovered] = React.useState(false);
        
        const variantStyles: CSSProperties = React.useMemo(() => {
            switch (variant) {
                case 'ghost':
                    return {
                        border: '1px solid #666',
                        backgroundColor: '#444',
                        padding: '3px 4px',
                        borderRadius: '4px',
                        fontSize: '11px',
                        fontWeight: 400,
                        color: '#c3c3c3',
                        height: 'auto',
                        opacity: isHovered ? 0.7 : 0.4,
                        transition: 'opacity 0.2s'
                    }
                case 'dark':
                    return {
                        border: isHovered ? '1px solid #666' : '1px solid #555',
                        backgroundColor: '#444',
                        padding: '3px 4px',
                        borderRadius: '4px',
                        fontSize: '11px',
                        fontWeight: 400,
                        color: isHovered ? '#d3d3d3' : '#a3a3a3',
                        height: 'auto',
                        transition: 'opacity 0.2s'
                    }
                case 'outline':
                    return {
                        borderColor: `var(--${colorScheme}-500)`,
                        color: `var(--${colorScheme}-500)`,
                        backgroundColor: 'transparent'
                    }
                default:
                    return {
                        backgroundColor: `var(--${colorScheme}-500)`,
                        color: 'white'
                    }
            }
        }, [variant, colorScheme, isHovered])

        const iconElement = icon ? (
            <span style={{ marginRight: '0.3rem', display: 'inline-flex', alignItems: 'center' }}>
                <CSSItemTypeIcon
                    itemType={icon}
                    style={{ transform: 'scale(0.9)' }}
                />
            </span>
        ) : null

        return (
            <button
                ref={ref}
                disabled={disabled}
                onMouseEnter={() => setIsHovered(true)}
                onMouseLeave={() => setIsHovered(false)}
                title={tooltip}
                style={{
                    ...baseStyles,
                    ...sizeStyles[size],
                    ...variantStyles,
                    ...style,
                }}
                {...rest}
            >
                {iconElement}
                {children}
                {onRemove && (
                    <span 
                        role="button"
                        style={{
                            ...removeButtonStyles,
                            opacity: isRemoveHovered ? 1 : 0.6,
                            color: isRemoveHovered ? '#d3d3d3' : '#a3a3a3',
                        }}
                        onClick={(e) => {
                            e.stopPropagation()
                            onRemove()
                        }}
                        onMouseEnter={() => setIsRemoveHovered(true)}
                        onMouseLeave={() => setIsRemoveHovered(false)}
                    >
                        <CSSIcon name="x-8" className="icon-16" />
                    </span>
                )}
            </button>
        )
    }
)