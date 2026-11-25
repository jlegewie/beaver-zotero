import React from "react";

type GlobeIconProps = React.SVGProps<SVGSVGElement>;

const GlobeIcon: React.FC<GlobeIconProps> = ({ strokeWidth = "1.5", ...props }) => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" color="currentColor" fill="none" {...props}>
        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth={strokeWidth}></circle>
        <path d="M20 5.69899C19.0653 5.76636 17.8681 6.12824 17.0379 7.20277C15.5385 9.14361 14.039 9.30556 13.0394 8.65861C11.5399 7.6882 12.8 6.11636 11.0401 5.26215C9.89313 4.70542 9.73321 3.19045 10.3716 2" stroke="currentColor" strokeWidth={strokeWidth} strokeLinejoin="round"></path>
        <path d="M2 11C2.7625 11.6621 3.83046 12.2682 5.08874 12.2682C7.68843 12.2682 8.20837 12.7649 8.20837 14.7518C8.20837 16.7387 8.20837 16.7387 8.72831 18.2288C9.06651 19.1981 9.18472 20.1674 8.5106 21" stroke="currentColor" strokeWidth={strokeWidth} strokeLinejoin="round"></path>
        <path d="M22 13.3456C21.1129 12.8195 20 12.5 18.8574 12.9973C17.8 13.4573 17.4237 15.4473 16.4152 16.4173C15.5 17.2973 14.5 17.5 14.7 19.3973C14.8 20.3473 15.5 21 16 21.4" stroke="currentColor" strokeWidth={strokeWidth} strokeLinejoin="round"></path>
    </svg>
);

export default GlobeIcon;
