// External community links. Per the header design, these leave the site so they
// don't earn a spot in the main nav row — signed-in users find them in UserMenu,
// guests in the header's ⋮ menu.
export const FORUM_URL = 'https://forum.cyoa.cafe';
// For signed-in users: enter the forum through the OIDC login route so the
// PocketBase session they already have is adopted silently and they arrive
// logged in (no forum-side login step). Guests keep FORUM_URL so they can
// browse without being bounced into a login flow.
export const FORUM_SSO_URL = 'https://forum.cyoa.cafe/auth/oidc?provider=cyoa&display=page';
export const DISCORD_INVITE_URL = 'https://discord.gg/9stHNfEskG';
