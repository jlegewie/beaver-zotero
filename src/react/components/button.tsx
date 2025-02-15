import React, { forwardRef, type CSSProperties } from 'react'

interface ButtonLoadingProps {
    loading?: boolean
    loadingText?: React.ReactNode
    spinner?: React.ReactNode
    spinnerPlacement?: 'start' | 'end'
}

interface ButtonProps extends ButtonLoadingProps, React.ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: 'solid' | 'outline' | 'ghost'
    size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'
    colorScheme?: string
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

const Spinner: React.FC = () => (
    <svg
    style={{ animation: 'spin 1s linear infinite' }}
    width="1em"
    height="1em"
    viewBox="0 0 24 24"
    xmlns="http://www.w3.org/2000/svg"
    >
    <circle
    cx="12"
    cy="12"
    r="10"
    stroke="currentColor"
    strokeWidth="4"
    fill="none"
    opacity="0.25"
    />
    <circle
    cx="12"
    cy="12"
    r="10"
    stroke="currentColor"
    strokeWidth="4"
    fill="none"
    strokeDasharray="60"
    strokeDashoffset="60"
    strokeLinecap="round"
    />
    </svg>
)

interface SpinnerWrapperProps {
    children: React.ReactNode
    placement: 'start' | 'end'
}

const SpinnerWrapper: React.FC<SpinnerWrapperProps> = ({ children, placement }) => (
    <span style={{ margin: placement === 'start' ? '0 0.5rem 0 0' : '0 0 0 0.5rem' }}>
    {children}
    </span>
)

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
    function Button(props, ref) {
        const {
            children,
            loading = false,
            loadingText,
            spinner,
            spinnerPlacement = 'start',
            variant = 'solid',
            size = 'md',
            colorScheme = 'gray',
            disabled,
            style,
            ...rest
        } = props
        
        const variantStyles: CSSProperties = React.useMemo(() => {
            switch (variant) {
                case 'outline':
                return {
                    borderColor: `var(--${colorScheme}-500)`,
                    color: `var(--${colorScheme}-500)`,
                    backgroundColor: 'transparent'
                }
                case 'ghost':
                return {
                    color: `var(--${colorScheme}-500)`,
                    backgroundColor: 'transparent'
                }
                default:
                return {
                    backgroundColor: `var(--${colorScheme}-500)`,
                    color: 'white'
                }
            }
        }, [variant, colorScheme])
        
        const spinnerElement = spinner || <Spinner />
        
        return (
            <button
            ref={ref}
            disabled={disabled || loading}
            style={{
                ...baseStyles,
                ...sizeStyles[size],
                ...variantStyles,
                ...style,
            }}
            {...rest}
            >
            {loading && spinnerPlacement === 'start' && (
                <SpinnerWrapper placement="start">{spinnerElement}</SpinnerWrapper>
            )}
            {loading ? loadingText || children : children}
            {loading && spinnerPlacement === 'end' && (
                <SpinnerWrapper placement="end">{spinnerElement}</SpinnerWrapper>
            )}
            </button>
        )
    }
)