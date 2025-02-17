import React from "react";

type PlusSignIconProps = React.SVGProps<SVGSVGElement>;

const PlusSignIcon: React.FC<PlusSignIconProps> = (props) => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={24} height={24} color={"#000000"} fill={"none"} {...props}>
        <path d="M12 4V20M20 12H4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
);

export default PlusSignIcon;