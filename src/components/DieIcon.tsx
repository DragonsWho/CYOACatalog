// The isometric six-pip die used on the in-game cheat FAB (cheat_shim.js
// DIE_SVG), reused as a React icon for the "Cheats" button so the entry point
// matches the tool it opens. Body + pips use currentColor; the three faces are
// painted `faceColor` (the FAB's red by default) so they read as cut-out panels.
import type { SVGProps } from 'react';

const FAB_RED = '#fc3447';

interface DieIconProps extends SVGProps<SVGSVGElement> {
  size?: number;
  faceColor?: string;
}

export default function DieIcon({ size = 22, faceColor = FAB_RED, ...props }: DieIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="30 32 140 140"
      fill="none"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <path
        d="M 91.34,40 Q 100,35 108.66,40 L 149.34,63.5 Q 158,68.5 158,78.5 L 158,125.5 Q 158,135.5 149.34,140.5 L 108.66,164 Q 100,169 91.34,164 L 50.66,140.5 Q 42,135.5 42,125.5 L 42,78.5 Q 42,68.5 50.66,63.5 Z"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth={2.5}
        strokeLinejoin="round"
      />
      <g transform="matrix(-0.58,-0.335,0,0.67,100,102)">
        <rect x="3" y="3" width="94" height="94" rx="10" ry="10" fill={faceColor} />
        <circle cx="22" cy="28" r="10" fill="currentColor" />
        <circle cx="50" cy="28" r="10" fill="currentColor" />
        <circle cx="78" cy="28" r="10" fill="currentColor" />
        <circle cx="22" cy="72" r="10" fill="currentColor" />
        <circle cx="50" cy="72" r="10" fill="currentColor" />
        <circle cx="78" cy="72" r="10" fill="currentColor" />
      </g>
      <g transform="matrix(0.58,-0.335,0,0.67,100,102)">
        <rect x="3" y="3" width="94" height="94" rx="10" ry="10" fill={faceColor} />
        <circle cx="28" cy="22" r="10" fill="currentColor" />
        <circle cx="28" cy="50" r="10" fill="currentColor" />
        <circle cx="28" cy="78" r="10" fill="currentColor" />
        <circle cx="72" cy="22" r="10" fill="currentColor" />
        <circle cx="72" cy="50" r="10" fill="currentColor" />
        <circle cx="72" cy="78" r="10" fill="currentColor" />
      </g>
      <g transform="matrix(-0.58,-0.335,0.58,-0.335,100,102)">
        <rect x="3" y="3" width="94" height="94" rx="10" ry="10" fill={faceColor} />
        <circle cx="28" cy="22" r="10" fill="currentColor" />
        <circle cx="28" cy="50" r="10" fill="currentColor" />
        <circle cx="28" cy="78" r="10" fill="currentColor" />
        <circle cx="72" cy="22" r="10" fill="currentColor" />
        <circle cx="72" cy="50" r="10" fill="currentColor" />
        <circle cx="72" cy="78" r="10" fill="currentColor" />
      </g>
    </svg>
  );
}
