// Carnival mask = "post anonymously". Custom because MUI only has `Masks` (medical — read as "I'm
// sick"). Chosen by the author. viewBox 250×250 is fine: SvgIcon scales by fontSize; currentColor
// takes the button color.

import SvgIcon, { type SvgIconProps } from '@mui/material/SvgIcon';

export default function AnonMaskIcon(props: SvgIconProps) {
  return (
    <SvgIcon viewBox="0 0 250 250" {...props}>
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M 7 63.5 C 23 72.5 48 80.5 79 84 C 94 89 114 117 123.5 118.6 C 133 117 153 89 168 84 C 199 80.5 224 72.5 240 63.5 C 243.6 62.6 244.9 64.6 244.6 68 C 244.2 90 237.5 113 230 132 C 225 148 211 180 173 185 C 152 181 135 171 123.5 159.5 C 112 171 95 181 74 185 C 36 180 22 148 17 132 C 9.5 113 2.8 90 2.4 68 C 2.1 64.6 3.4 62.6 7 63.5 Z M 38.7 132.5 C 44 125.5 58 119.4 67 119.4 C 78 119.4 94 129 101.5 140.5 C 97 146 80 155.3 70 155.3 C 62 155.3 45 146 38.7 132.5 Z M 208.3 132.5 C 203 125.5 189 119.4 180 119.4 C 169 119.4 153 129 145.5 140.5 C 150 146 167 155.3 177 155.3 C 185 155.3 202 146 208.3 132.5 Z"
      />
    </SvgIcon>
  );
}
