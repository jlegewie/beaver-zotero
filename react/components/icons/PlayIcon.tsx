import React from "react";

type PlayIconProps = React.SVGProps<SVGSVGElement>;

const PlayIcon: React.FC<PlayIconProps> = (props) => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" color="#000000" fill="none" {...props}>
        <path d="M7.5241 19.0621C6.85783 19.4721 6 18.9928 6 18.2104V5.78956C6 5.00724 6.85783 4.52789 7.5241 4.93791L17.6161 11.1483C18.2506 11.5388 18.2506 12.4612 17.6161 12.8517L7.5241 19.0621Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"></path>
    </svg>
);

export default PlayIcon;