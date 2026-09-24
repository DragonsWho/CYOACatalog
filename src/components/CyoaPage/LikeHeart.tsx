import { Box, keyframes } from '@mui/material';

// The like-button heart, redrawn from public/like.lottie (300×300 comp, 30 fps) as SVG + CSS: the
// same path, colour, scale curve and burst ring. It replaces @lottiefiles/dotlottie-react, which put
// ~420 KB of JS into the game page chunk and fetched a ~500 KB wasm renderer from jsdelivr on every
// game page — for one 1-second animation.
//
// Frame → time: 1 frame = 1/30 s. Heart: frames 0–19; ring: frames 2–14.

const PINK = '#eb5181';
// Lottie heart path, centred on (0,0); the comp places it at (150,150).
const HEART_D =
  'M11.176 -20.5C6.301 -20.5 2.068 -17.976 0 -14.302C-2.067 -17.976 -6.301 -20.5 -11.175 -20.5C-18.577 -20.5 -23 -14.04 -23 -7.795C-23 6.995 -1.588 19.778 -0.676 20.315C-0.467 20.439 -0.234 20.5 0 20.5C0.234 20.5 0.467 20.439 0.676 20.315C1.588 19.778 23 6.995 23 -7.795C23 -14.04 18.577 -20.5 11.176 -20.5Z';
const REST_SCALE = 2.027;

const at = (s: number) => `translate(150px, 150px) scale(${s})`;

// Per-segment easing = the lottie keyframe's out/in tangents.
const heartPop = keyframes`
  0% { transform: ${at(2.027)}; animation-timing-function: cubic-bezier(0.333, 0.115, 0.48, 1); }
  5.263% { transform: ${at(1.4975)}; animation-timing-function: cubic-bezier(0.167, 0.167, 0.833, 0.833); }
  10.526% { transform: ${at(1.2162)}; animation-timing-function: cubic-bezier(0.264, 0, 0.516, 1); }
  36.842% { transform: ${at(2.6351)}; animation-timing-function: cubic-bezier(0.373, 0, 0.605, 1.005); }
  57.895% { transform: ${at(2.027)}; animation-timing-function: cubic-bezier(0.32, 0, 0.663, 0.978); }
  73.684% { transform: ${at(2.1284)}; animation-timing-function: cubic-bezier(0.29, 0.002, 0.64, 0.973); }
  100% { transform: ${at(REST_SCALE)}; }
`;

const ringGrow = keyframes`
  from { transform: translate(150px, 150px) scale(0); }
  to { transform: translate(150px, 150px) scale(0.4865); }
`;

const ringThin = keyframes`
  from { stroke-width: 240; }
  to { stroke-width: 0; }
`;

interface Props {
  liked: boolean;
  // Play the pop + burst (on the transition to liked); otherwise the static end frame is shown.
  animate: boolean;
  size?: number;
}

export default function LikeHeart({ liked, animate, size = 72 }: Props) {
  const play = liked && animate;
  return (
    <Box component="svg" viewBox="0 0 300 300" aria-hidden="true" sx={{ width: size, height: size, display: 'block', overflow: 'visible' }}>
      {play && (
        <Box
          component="circle"
          r={183.6}
          fill="none"
          stroke={PINK}
          sx={{
            transform: 'translate(150px, 150px) scale(0)',
            animation: `${ringGrow} 400ms cubic-bezier(1, 0, 0, 1.002) 66.7ms both, ${ringThin} 400ms cubic-bezier(0.588, 0, 0.297, 1) 66.7ms both`,
          }}
        />
      )}
      <Box
        component="path"
        d={HEART_D}
        stroke={PINK}
        strokeWidth={3.6}
        fill={PINK}
        sx={{
          transform: at(REST_SCALE),
          // The fill switches on within the first frame of the pop (lottie: opacity 0 → 100, frames 0–1).
          fillOpacity: liked ? 1 : 0,
          transition: play ? 'fill-opacity 33ms' : 'none',
          ...(play ? { animation: `${heartPop} 633ms both` } : null),
        }}
      />
    </Box>
  );
}
