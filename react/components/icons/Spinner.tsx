import React from 'react';

const Spinner = ({ size = 16, className = '' }) => {
    const spinnerStyle = {
        animation: 'spin 1s linear infinite',
    };
    
    return (
        <svg
            style={spinnerStyle}
            className={className}
            width={size}
            height={size}
            viewBox="0 0 24 24"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
        >
            <style>
                {`
                @keyframes spin {
                    from {
                    transform: rotate(0deg);
                    }
                    to {
                    transform: rotate(360deg);
                    }
                }
                `}
            </style>
            <circle
                style={{ opacity: 0.25 }}
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
                fill="none"
            />
            <path
                style={{ opacity: 0.75 }}
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
        </svg>
        );
    };
    
    export default Spinner;