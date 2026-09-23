// Touch vs mouse screen — one answer for both chat composers (header drawer and /chat) so they
// don't diverge.

// No-mouse screen (phone, tablet): `hover: none` + `pointer: coarse` is what a finger gives;
// touchscreen laptops don't match (they have a mouse and a real keyboard). On phones Enter is the
// only way to insert a newline, and sending on it breaks thoughts mid-word. On laptops Enter sends,
// Shift+Enter breaks lines, like Discord. Computed once: a device doesn't turn from phone to laptop
// within a session; listening would needlessly jolt the composer.
export const TOUCH_ONLY =
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(hover: none) and (pointer: coarse)').matches;
