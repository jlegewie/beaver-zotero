import React from "react";

type LinkBackwardIconProps = React.SVGProps<SVGSVGElement>;

const LinkBackwardIcon: React.FC<LinkBackwardIconProps> = (props) => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" color="currentColor" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
        <path d="M11 8.5H10.5V4.69635C10.5 4.31176 10.1882 4 9.80365 4C9.61003 4 9.42509 4.08062 9.29336 4.22252L3.34016 10.6336C3.12146 10.8691 3 11.1786 3 11.5C3 11.8214 3.12146 12.1309 3.34016 12.3664L9.29336 18.7775C9.42509 18.9194 9.61003 19 9.80365 19C10.1882 19 10.5 18.6882 10.5 18.3037V14.5C16.0545 14.5 19.0531 18.5162 19.808 19.6847C19.9326 19.8776 20.1429 20 20.3725 20C20.7191 20 21 19.7191 21 19.3725V18.5C21 12.9772 16.5228 8.5 11 8.5Z" />
    </svg>
);

export default LinkBackwardIcon;
