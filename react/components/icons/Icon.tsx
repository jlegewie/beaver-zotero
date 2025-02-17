import React from 'react';

interface IconProps {
    icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
    size?: number;
    color?: string;
    className?: string;
}

const Icon: React.FC<IconProps> = ({ 
    icon: IconComponent, 
    size = 24, 
    color = 'currentColor',
    className = '',
    ...props 
}) => {
    return (
        <div 
            className={`inline-flex items-center justify-center ${className}`}
            style={{ width: size, height: size }}
        >
            <IconComponent
                width={size}
                height={size}
                color={color}
                {...props}
            />
        </div>
    );
};

export default Icon; 