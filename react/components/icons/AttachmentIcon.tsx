import React from "react";

type AttachmentIconProps = React.SVGProps<SVGSVGElement>;

const AttachmentIcon: React.FC<AttachmentIconProps> = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={24} height={24} color={"#000000"} fill={"none"} {...props}>
    <path fillRule="evenodd" clipRule="evenodd" d="M12 3C10.3431 3 9 4.34315 9 6V8C9 8.55228 8.55228 9 8 9C7.44772 9 7 8.55228 7 8V6C7 3.23858 9.23858 1 12 1C14.7614 1 17 3.23858 17 6V18C17 20.7614 14.7614 23 12 23C9.23858 23 7 20.7614 7 18V13.5C7 11.567 8.567 10 10.5 10C12.433 10 14 11.567 14 13.5V16C14 16.5523 13.5523 17 13 17C12.4477 17 12 16.5523 12 16V13.5C12 12.6716 11.3284 12 10.5 12C9.67157 12 9 12.6716 9 13.5V18C9 19.6569 10.3431 21 12 21C13.6569 21 15 19.6569 15 18V6C15 4.34315 13.6569 3 12 3Z" fill="currentColor" />
  </svg>
);

export default AttachmentIcon;