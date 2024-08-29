// src/components/Footer/PatreonIcon.tsx
// Version: 1.2.0
// Description: Updated Patreon icon component with official logo, converted to TypeScript

import React from 'react';
import SvgIcon, { SvgIconProps } from '@mui/material/SvgIcon';

const PatreonIcon: React.FC<SvgIconProps> = (props) => (
  <SvgIcon {...props} viewBox="0 0 1080 1080">
    <path
      fill="currentColor"
      d="M1033.05,324.45c-0.19-137.9-107.59-250.92-233.6-291.7c-156.48-50.64-362.86-43.3-512.28,27.2C106.07,145.41,49.18,332.61,47.06,519.31c-1.74,153.5,13.58,557.79,241.62,560.67c169.44,2.15,194.67-216.18,273.07-321.33c55.78-74.81,127.6-95.94,216.01-117.82C929.71,603.22,1033.27,483.3,1033.05,324.45z"
    />
  </SvgIcon>
);

export default PatreonIcon;
