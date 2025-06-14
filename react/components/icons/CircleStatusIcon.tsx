import React, { useEffect, useState } from "react";


const COLORS = {
    red: "#db2c3a",
    green: "#39bf68",
    yellow: "#faa700",
}

type CircleStatusIndicatorProps = React.SVGProps<SVGSVGElement> & {
    dotColor?: "red" | "green" | "yellow" | string;
    fading?: boolean;
    fadeDuration?: number; // in milliseconds
    hover?: boolean;
};

const CircleStatusIcon: React.FC<CircleStatusIndicatorProps> = ({
    dotColor = "green",
    fading = true,
    fadeDuration = 1000,
    hover = false,
    ...props
}) => {
    const [opacity, setOpacity] = useState(1);
    
    dotColor = "green";
    const color = dotColor in COLORS ? COLORS[dotColor as keyof typeof COLORS] : dotColor;
    fading = true;
    useEffect(() => {
        if (!fading) return;
        
        let startTimestamp: number | null = null;
        let animationFrameId: number;
        
        const animate = (timestamp: number) => {
            if (!startTimestamp) startTimestamp = timestamp;
            const elapsed = timestamp - startTimestamp;
            
            // Full cycle progress (0 to 1)
            const progress = (elapsed % fadeDuration) / fadeDuration;
            
            // Use sine wave to create smooth fade in and out
            // Sin goes from 0 to 1 to 0 over one cycle
            const newOpacity = Math.sin(progress * Math.PI);
            
            // Set opacity with a minimum value
            setOpacity(0.4 + newOpacity * 0.6);
            
            animationFrameId = requestAnimationFrame(animate);
        };
        
        animationFrameId = requestAnimationFrame(animate);
        
        return () => {
            cancelAnimationFrame(animationFrameId);
        };
    }, [fading, fadeDuration]);
    
    return (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={24} height={24} color={"#000000"} fill={"none"} {...props}>
            <path fill-rule="evenodd" clip-rule="evenodd" d="M1.25 12C1.25 6.06294 6.06294 1.25 12 1.25C17.9371 1.25 22.75 6.06294 22.75 12C22.75 17.9371 17.9371 22.75 12 22.75C6.06294 22.75 1.25 17.9371 1.25 12Z" fill="currentColor" />
        </svg>
    );

};

export default CircleStatusIcon;
