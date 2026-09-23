import { SvgIcon, SvgIconProps } from '@mui/material';

export function ImageSplitterIcon(props: SvgIconProps) {
  return (
    <SvgIcon {...props} viewBox="0 0 24 28">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M4 2C2.89543 2 2 2.89543 2 4V9C2 10.1046 2.89543 11 4 11H20C21.1046 11 22 10.1046 22 9V4C22 2.89543 21.1046 2 20 2H4ZM4 4H20V9H4V4ZM4 17C2.89543 17 2 17.8954 2 19V24C2 25.1046 2.89543 26 4 26H20C21.1046 26 22 25.1046 22 24V19C22 17.8954 21.1046 17 20 17H4ZM4 19H20V24H4V19ZM1 13H23V15H1V13Z"
      />
    </SvgIcon>
  );
}