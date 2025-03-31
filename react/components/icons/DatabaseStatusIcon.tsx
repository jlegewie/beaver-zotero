import React from "react";
// @ts-ignore no idea why this is needed
import { useEffect, useState } from "react";


const COLORS = {
    red: "#db2c3a",
    green: "#39bf68",
    yellow: "#faa700",
}

type DatabaseStatusIndicatorProps = React.SVGProps<SVGSVGElement> & {
    dotColor?: "red" | "green" | "yellow" | string;
    fading?: boolean;
    fadeDuration?: number; // in milliseconds
    hover?: boolean;
};

const DatabaseStatusIcon: React.FC<DatabaseStatusIndicatorProps> = ({
    dotColor = "green",
    fading = true,
    fadeDuration = 1000,
    hover = false,
    ...props
}) => {
    const [opacity, setOpacity] = useState(1);
    
    const color = dotColor in COLORS ? COLORS[dotColor as keyof typeof COLORS] : dotColor;
    
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
            <path fillRule="evenodd" clipRule="evenodd" d="M2.71527 3.08401C2.18749 3.55194 1.75 4.19711 1.75 5V9.98763C1.75 10.9324 1.90337 11.4637 2.70806 11.9907C3.03325 12.2037 3.39779 12.4055 3.8008 12.5952C5.76354 13.5188 8.3613 14 10.75 14C11.5557 14 12.3852 13.9453 13.206 13.8373C13.4536 13.8047 13.5774 13.7884 13.6934 13.7421C13.8095 13.6958 13.9491 13.5945 14.2283 13.3918C15.2173 12.6736 16.4342 12.25 17.75 12.25C18.2028 12.25 18.4044 12.2445 18.7919 11.9907C19.5966 11.4637 19.75 10.9324 19.75 9.98763V5C19.75 4.19711 19.3125 3.55194 18.7847 3.08401C18.2558 2.61504 17.5474 2.2384 16.758 1.94235C15.1717 1.34749 13.0473 1 10.75 1C8.45269 1 6.32833 1.34749 4.74202 1.94235C3.95256 2.2384 3.24422 2.61504 2.71527 3.08401ZM4.04209 5.41948C4.30524 5.65279 4.72883 5.9045 5.32313 6.13845C5.35413 6.15065 5.39043 6.16171 5.42851 6.17331C5.53644 6.20619 5.65859 6.24339 5.71414 6.32318C5.75 6.37469 5.75 6.44357 5.75 6.58134V8.5C5.75 9.05228 6.19772 9.5 6.75 9.5C7.30228 9.5 7.75 9.05228 7.75 8.5V7.23948C7.75 7.02246 7.75 6.91395 7.8182 6.8542C7.8864 6.79444 7.99582 6.80895 8.21467 6.83796C8.99969 6.94202 9.8529 7 10.75 7C12.871 7 14.7466 6.67591 16.0557 6.18499C16.714 5.93815 17.1772 5.66834 17.4579 5.41948C17.8146 5.10324 17.8146 4.89676 17.4579 4.58052C17.1772 4.33166 16.714 4.06185 16.0557 3.81501C14.7466 3.32409 12.871 3 10.75 3C8.62903 3 6.7534 3.32409 5.44427 3.81501C4.78602 4.06185 4.32279 4.33166 4.04209 4.58052C3.6854 4.89676 3.6854 5.10324 4.04209 5.41948Z" fill="currentColor" />
            <path d="M11.8842 15.9679C12.0286 15.9599 12.1009 15.9559 12.133 15.9987C12.1651 16.0415 12.1405 16.111 12.0914 16.25C11.8703 16.8755 11.75 17.5487 11.75 18.25C11.75 19.7466 12.298 21.1153 13.2042 22.1663C13.4589 22.4616 13.5862 22.6093 13.5414 22.722C13.4965 22.8347 13.3158 22.8531 12.9544 22.8899C12.2471 22.962 11.508 22.9998 10.75 22.9998C8.45269 22.9998 6.32833 22.6523 4.74202 22.0575C3.95256 21.7614 3.24422 21.3848 2.71527 20.9158C2.18749 20.4479 1.75 19.8027 1.75 18.9998V14.4765C1.75 14.1584 1.75 13.9993 1.84753 13.9412C1.94506 13.883 2.0892 13.9608 2.37747 14.1164C2.56512 14.2177 2.75604 14.3137 2.9492 14.4046C3.72353 14.769 4.56834 15.0695 5.44849 15.3076C5.59458 15.3471 5.66763 15.3669 5.70882 15.4207C5.75 15.4745 5.75 15.549 5.75 15.698V17.5C5.75 18.0523 6.19772 18.5 6.75 18.5C7.30228 18.5 7.75 18.0523 7.75 17.5V16.2431C7.75 16.0289 7.75 15.9218 7.81749 15.8621C7.88499 15.8024 7.99275 15.8157 8.20825 15.8422C9.0655 15.9477 9.92236 15.9998 10.75 15.9998C11.123 15.9998 11.502 15.9892 11.8842 15.9679Z" fill="currentColor" />
            {/* Dot with custom color and fade effect */}
            {!hover ? (
                <path
                    fillRule="evenodd" 
                    clipRule="evenodd" 
                    d="M22.25 18.25C22.25 20.7353 20.2353 22.75 17.75 22.75C15.2647 22.75 13.25 20.7353 13.25 18.25C13.25 15.7647 15.2647 13.75 17.75 13.75C20.2353 13.75 22.25 15.7647 22.25 18.25Z" 
                    fill={color}
                    opacity={fading ? opacity : 1}
                />
            ) : (
                <path
                    fillRule="evenodd"
                    clipRule="evenodd"
                    d="M19.2407 13.8425C19.1949 13.3548 19.5135 12.8952 20.0036 12.7777C20.5407 12.6491 21.0804 12.9802 21.2091 13.5173L21.7084 15.6016C21.803 15.9964 21.6495 16.4092 21.32 16.6463C20.9905 16.8834 20.5503 16.8978 20.2061 16.6827C19.4651 16.2197 18.6977 15.6014 17.7852 15.6014C16.3953 15.6014 15.2498 16.7436 15.2498 18.1758C15.2498 19.608 16.3953 20.7502 17.7852 20.7502C19.0024 20.7502 20.0322 19.8749 20.2694 18.6939C20.3781 18.1524 20.9052 17.8016 21.4467 17.9103C21.9881 18.019 22.339 18.5461 22.2302 19.0875C21.8122 21.1695 19.9887 22.7502 17.7852 22.7502C15.27 22.7502 13.2498 20.6918 13.2498 18.1758C13.2498 15.6598 15.27 13.6014 17.7852 13.6014C18.2941 13.6014 18.7838 13.6863 19.2407 13.8425Z"
                    fill={color}
                />
            )}
        </svg>
    );
};

export default DatabaseStatusIcon;
