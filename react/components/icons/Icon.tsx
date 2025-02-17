import React from 'react';

interface IconProps {
    icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
    size?: number | string;
    color?: string;
    className?: string;
}

const Icon: React.FC<IconProps> = ({ 
    icon: IconComponent, 
    size = '1em',  // Default to 1em to scale with text
    color = 'currentColor',
    className = '',
    ...props 
}) => {
    // Remove the wrapper div and directly render the SVG
    return (
        <IconComponent
            width={size}
            height={size}
            color={color}
            className={`inline-block align-middle ${className}`}
            style={{ 
                // Fix vertical alignment
                // transform: 'translateY(0.125em)',
                // Ensure consistent sizing
                flexShrink: 0
            }}
            {...props}
        />
    );
};

export default Icon;