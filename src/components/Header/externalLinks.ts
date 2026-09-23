// External community links: not in the main nav row — signed-in users find them in UserMenu, guests
// in the header ⋮ menu.

export const FORUM_URL = 'https://forum.cyoa.cafe';
// Signed-in users enter the forum through the OIDC login route, so their PocketBase session is
// adopted silently and they arrive logged in. Guests keep FORUM_URL to browse without a login
// bounce.
export const FORUM_SSO_URL = 'https://forum.cyoa.cafe/auth/oidc?provider=cyoa&display=page'; 
