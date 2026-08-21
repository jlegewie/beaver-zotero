import React from "react";

type TextAlignLeftIconProps = React.SVGProps<SVGSVGElement>;

const TextAlignLeftIcon: React.FC<TextAlignLeftIconProps> = (props) => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={24} height={24} color={"#000000"} fill={"none"} {...props}>
        <path fillRule="evenodd" clipRule="evenodd" d="M2 3C2 2.44772 2.44772 2 3 2H21C21.5523 2 22 2.44772 22 3C22 3.55228 21.5523 4 21 4H3C2.44772 4 2 3.55228 2 3Z" fill="currentColor" />
        <path fillRule="evenodd" clipRule="evenodd" d="M2 9C2 8.44772 2.44772 8 3 8H11C11.5523 8 12 8.44772 12 9C12 9.55228 11.5523 10 11 10H3C2.44772 10 2 9.55228 2 9Z" fill="currentColor" />
        <path fillRule="evenodd" clipRule="evenodd" d="M2 15C2 14.4477 2.44772 14 3 14H21C21.5523 14 22 14.4477 22 15C22 15.5523 21.5523 16 21 16H3C2.44772 16 2 15.5523 2 15Z" fill="currentColor" />
        <path fillRule="evenodd" clipRule="evenodd" d="M2 21C2 20.4477 2.44772 20 3 20H11C11.5523 20 12 20.4477 12 21C12 21.5523 11.5523 22 11 22H3C2.44772 22 2 21.5523 2 21Z" fill="currentColor" />
    </svg>
);

export default TextAlignLeftIcon;
