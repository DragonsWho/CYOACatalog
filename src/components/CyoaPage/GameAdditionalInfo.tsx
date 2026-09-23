import { useState, useEffect, useCallback, useContext } from 'react';
import { Box, Typography, CircularProgress, Tooltip, IconButton, Menu, MenuItem, ListItemText, Snackbar, Button } from '@mui/material';
import { DotLottieReact } from '@lottiefiles/dotlottie-react';
import { useTheme } from '@mui/material/styles';
import { AuthContext, authedFetch, gamesCollection, usersCollection, pb, GameRelationship } from '../../pocketbase/pocketbase';
import { analytics } from '../../utils/analytics';
import RelatedGamesList from './RelatedGamesList';
import { useNavigate } from 'react-router-dom';
import { MOD_KINDS } from '../Moderation/modKinds';

import FilterNoneIcon from '@mui/icons-material/FilterNone';
import PublicIcon from '@mui/icons-material/Public';
import FlagOutlinedIcon from '@mui/icons-material/FlagOutlined';
import LocalOfferOutlinedIcon from '@mui/icons-material/LocalOfferOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import CloudUploadOutlinedIcon from '@mui/icons-material/CloudUploadOutlined';
import KeyboardDoubleArrowUpIcon from '@mui/icons-material/KeyboardDoubleArrowUp';
import DieIcon from '../DieIcon';
import VisibilityOffOutlinedIcon from '@mui/icons-material/VisibilityOffOutlined';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import { BUMP_COOLDOWN_MS } from './GameEditDialog';
import BumpVoteWidget from './BumpVoteWidget';

const LOGIN_TOOLTIP = 'Login to upvote';

// One icon source by link host for BOTH buttons (iframe game and original_link). Hostings
// (neocities/nekoweb) → their STABLE brand icon (per-site favicons there are unreliable — a
// neocities site may inherit our favicon); our hosting → our logo; any other site → its own favicon
// (favicon service). Previously the iframe button always drew the cyoa.cafe logo (a lie for
// neocities links) and foreign original_links fell back to a generic globe.
type HostBadge = { src: string; alt: string; tooltip: string };
function hostBadge(url: string | undefined, verb: string): HostBadge | null {
  let host = '';
  try { host = new URL(url || '').hostname.toLowerCase(); } catch { return null; }
  if (!host) return null;
  const on = (suffix: string) => host === suffix || host.endsWith('.' + suffix);
  if (on('neocities.org')) return { src: '/icons/neocities.ico', alt: 'Neocities', tooltip: `${verb} — Neocities` };
  if (on('nekoweb.org'))  return { src: '/icons/nekoweb.ico',  alt: 'Nekoweb',  tooltip: `${verb} — Nekoweb` };
  if (on('cyoa.cafe'))    return { src: '/favicon.svg', alt: 'cyoa.cafe', tooltip: verb };
  // Other sites: their own favicon via DuckDuckGo's icon service (no keys/tracking).
  return { src: `https://icons.duckduckgo.com/ip3/${host}.ico`, alt: host, tooltip: `${verb} — ${host}` };
}

// Does the link point to OUR hosting? Update/re-upload scripts sometimes duplicate the cafe link
// into games.original_link, and then both buttons lead to us — don't draw a second identical icon.
function isInternalHost(url: string | undefined): boolean {
  let host = '';
  try { host = new URL(url || '').hostname.toLowerCase(); } catch { return false; }
  return host === 'cyoa.cafe' || host.endsWith('.cyoa.cafe');
}

// Fallback to a globe if the favicon fails (broken /favicon).
function HostIcon({ badge }: { badge: HostBadge }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <PublicIcon />;
  return (
    <Box
      component="img"
      src={badge.src}
      alt={badge.alt}
      onError={() => setFailed(true)}
      sx={{ width: 24, height: 24, objectFit: 'contain' }}
    />
  );
}

interface GameAdditionalInfoProps {
  gameId: string;
  upvoteCount: number;
  relatedGames: GameRelationship[];
  onUpvoteChange?: () => void;
  gameType?: 'img' | 'link';
  gameUrl?: string;
  originalLink?: string;
  canEditTags?: boolean;
  tagsEditing?: boolean;
  onToggleTagsEdit?: () => void;
  cheatsActive?: boolean;
  onToggleCheats?: () => void;
  cheatReady?: boolean;
  canManage?: boolean;
  bumpedAt?: string;
  onEditGame?: () => void;
  onBumpGame?: () => void;
  onReuploadGame?: () => void;
}

export default function GameAdditionalInfo({
  gameId,
  upvoteCount: initialUpvoteCount,
  relatedGames,
  onUpvoteChange,
  gameType,
  gameUrl,
  originalLink,
  canEditTags,
  tagsEditing,
  onToggleTagsEdit,
  cheatsActive,
  onToggleCheats,
  cheatReady,
  canManage,
  bumpedAt,
  onEditGame,
  onBumpGame,
  onReuploadGame,
}: GameAdditionalInfoProps) {
  const theme = useTheme();
  const navigate = useNavigate();
  const [isUpvoted, setIsUpvoted] = useState(false);
  const [localUpvoteCount, setLocalUpvoteCount] = useState(initialUpvoteCount || 0);
  const [isLoading, setIsLoading] = useState(false);
  const [showLoader, setShowLoader] = useState(false);
  const { user, blockedGameIds } = useContext(AuthContext);
  const userID = user?.id;

  const isHidden = blockedGameIds.includes(gameId);
  const [hideLoading, setHideLoading] = useState(false);
  const [snack, setSnack] = useState<{ open: boolean; msg: string; undo: (() => void) | null }>({
    open: false,
    msg: '',
    undo: null,
  });

  useEffect(() => {
    setLocalUpvoteCount(initialUpvoteCount || 0);
  }, [initialUpvoteCount]);

  // "Did I upvote?" — the `upvotes` array no longer ships with the game record
  // (GAME_DETAIL_FIELDS); resolved by a tiny id-only query. Anon users never upvoted.
  useEffect(() => {
    if (!userID) {
      setIsUpvoted(false);
      return;
    }
    let cancelled = false;
    gamesCollection
      .getList(1, 1, {
        filter: `id = "${gameId}" && upvotes ~ "${userID}"`,
        fields: 'id',
      })
      .then((res) => {
        if (!cancelled) setIsUpvoted(res.totalItems > 0);
      })
      .catch(() => {
        if (!cancelled) setIsUpvoted(false);
      });
    return () => {
      cancelled = true;
    };
  }, [userID, gameId]);

  const handleUpvote = useCallback(async () => {
    if (!userID || isLoading) return;

    setIsLoading(true);
    const loaderTimeout = setTimeout(() => setShowLoader(true), 200);

    const originalIsUpvoted = isUpvoted;
    const originalCount = localUpvoteCount;

    const newIsUpvoted = !isUpvoted;
    setIsUpvoted(newIsUpvoted);
    setLocalUpvoteCount((prevCount) => (newIsUpvoted ? prevCount + 1 : Math.max(0, prevCount - 1)));
    analytics.gameUpvote({ game_id: gameId, active: newIsUpvoted });

    try {
      const res = await authedFetch('/api/custom/upvotes/' + gameId, {
        method: 'POST',
      });
      if (!res.ok) throw new Error('Upvote failed');
      
      const resJSON = await res.json();
      if (resJSON.count !== undefined) setLocalUpvoteCount(resJSON.count);
      if (onUpvoteChange) onUpvoteChange();

    } catch(error) {
        console.error("Failed to upvote:", error);
        setIsUpvoted(originalIsUpvoted);
        setLocalUpvoteCount(originalCount);
    } finally {
      clearTimeout(loaderTimeout);
      setShowLoader(false);
      setIsLoading(false);
    }
  }, [gameId, isUpvoted, localUpvoteCount, onUpvoteChange, userID, isLoading]);

  // Hide/show in the personal blocklist via relation modifiers `+`/`-` (no full-array races);
  // authRefresh then recomputes blockedGameIds in App via authStore.onChange.
  const setBlacklisted = useCallback(
    async (hide: boolean) => {
      if (!userID || hideLoading) return;
      setHideLoading(true);
      try {
        await usersCollection.update(userID, hide ? { 'blocked_games+': gameId } : { 'blocked_games-': gameId });
        await pb.collection('users').authRefresh({ expand: 'blocked_tags' });
        setSnack({
          open: true,
          msg: hide ? 'Hidden from your feed' : 'Shown again',
          undo: () => setBlacklisted(!hide),
        });
      } catch (error) {
        console.error('Failed to update blocked games:', error);
        setSnack({ open: true, msg: 'Failed to update – try again', undo: null });
      } finally {
        setHideLoading(false);
      }
    },
    [userID, gameId, hideLoading],
  );

  const handleSimilarSearch = () => {
      navigate(`/search?similar=${gameId}`);
  };

  // "Call a moderator" category drops the user into comments with a guided @moderator template
  // (Comments.tsx ?call=mod).
  const [modAnchor, setModAnchor] = useState<null | HTMLElement>(null);
  const pickModKind = (kind: string) => {
    setModAnchor(null);
    navigate({ search: `?call=mod&kind=${kind}`, hash: '#comment-form' });
  };

  // Open buttons: 1) game on OUR hosting (iframe_url) in a new tab without cafe chrome; 2)
  // original_link where the game lives "in the wild".
  const handleOpenHosted = () => {
    if (gameUrl) {
      window.open(gameUrl, '_blank', 'noopener,noreferrer');
    }
  };
  const handleOpenOriginal = () => {
    if (originalLink) {
      window.open(originalLink, '_blank', 'noopener,noreferrer');
    }
  };

  const isInteractive = gameType === 'link' && gameUrl;

  const gameBadge = hostBadge(gameUrl, 'Open the game in a new tab');
  const originalBadge = hostBadge(originalLink, 'Open the original source');

  // Both links lead to our hosting → original_link duplicated the cafe link (re-upload artifact);
  // show only the hosting button.
  const originalDuplicatesHosted = isInternalHost(gameUrl) && isInternalHost(originalLink);

  const heartColor = theme.palette.secondary.main;

  return (
    <Box sx={{ mt: 2 }}>
      {/* The button row wraps on narrow screens, else the long moderator panel overflowed right. */}
      <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 2, minHeight: 40, mb: 1 }}>
        
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <Tooltip title={userID ? (isUpvoted ? 'Remove upvote' : 'Upvote') : LOGIN_TOOLTIP} arrow>
            <span>
                <IconButton
                onClick={handleUpvote}
                disabled={isLoading || !userID}
                size="small"
                sx={{
                    padding: 0,
                    width: 36,
                    height: 36,
                    opacity: !userID ? 0.6 : 1,
                    '&:hover': { backgroundColor: !userID || isLoading ? 'transparent' : 'rgba(255, 255, 255, 0.08)' },
                    display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative',
                }}
                >
                {showLoader && <CircularProgress size={24} color="inherit" sx={{ position: 'absolute', zIndex: 1 }} />}
                <Box sx={{ width: 72, height: 72, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: showLoader ? 0 : 1 }}>
                    <DotLottieReact key={isUpvoted ? 'upvoted' : 'not-upvoted'} src="/like.lottie" loop={false} autoplay={isUpvoted} style={{ width: '72px', height: '72px', color: heartColor }} />
                </Box>
                </IconButton>
            </span>
            </Tooltip>
            <Typography variant="body2" sx={{ color: 'white', fontWeight: 'bold', minWidth: 10, textAlign: 'left' }}>
                {localUpvoteCount}
            </Typography>
        </Box>

        <BumpVoteWidget gameId={gameId} />

        <Tooltip title="Find similar games" arrow>
            <IconButton 
                onClick={handleSimilarSearch}
                size="small"
                sx={{
                    width: 36, 
                    height: 36,
                    color: theme.palette.primary.light, 
                    '&:hover': {
                        backgroundColor: theme.palette.action.hover,
                        color: theme.palette.primary.main,
                        borderColor: theme.palette.primary.main
                    }
                }}
            >
                <FilterNoneIcon fontSize="small" />
            </IconButton>
        </Tooltip>

        {isInteractive && gameBadge && (
            <Tooltip title={gameBadge.tooltip} arrow>
                <IconButton
                    onClick={handleOpenHosted}
                    size="small"
                    sx={{
                        width: 36,
                        height: 36,
                        color: theme.palette.primary.light,
                        '&:hover': {
                            backgroundColor: theme.palette.action.hover,
                            color: theme.palette.primary.main,
                            borderColor: theme.palette.primary.main
                        }
                    }}
                >
                    <HostIcon badge={gameBadge} />
                </IconButton>
            </Tooltip>
        )}

        {originalLink && originalBadge && !originalDuplicatesHosted && (
            <Tooltip title={originalBadge.tooltip} arrow>
                <IconButton
                    onClick={handleOpenOriginal}
                    size="small"
                    sx={{
                        width: 36,
                        height: 36,
                        color: theme.palette.primary.light,
                        '&:hover': {
                            backgroundColor: theme.palette.action.hover,
                            color: theme.palette.primary.main,
                            borderColor: theme.palette.primary.main
                        }
                    }}
                >
                    <HostIcon badge={originalBadge} />
                </IconButton>
            </Tooltip>
        )}

        {/*
          "Cheats" switches the already-loaded saver shim into the cheat menu (postMessage, no
          reload). Shown once the shim announced itself (our hosting + supported engine).
        */}
        {cheatReady && onToggleCheats && (
          <Tooltip title={cheatsActive ? 'Hide cheats' : 'Cheats (post a build to unlock)'} arrow>
            <IconButton
              onClick={onToggleCheats}
              size="small"
              sx={{
                width: 36,
                height: 36,
                color: '#fff',
                backgroundColor: cheatsActive ? theme.palette.action.selected : 'transparent',
                '&:hover': { backgroundColor: theme.palette.action.hover },
              }}
            >
              <DieIcon size={22} />
            </IconButton>
          </Tooltip>
        )}

        <Tooltip title="Report a problem (call a moderator)" arrow>
          <IconButton
            onClick={(e) => setModAnchor(e.currentTarget)}
            size="small"
            sx={{
              width: 36,
              height: 36,
              color: 'text.disabled',
              '&:hover': { backgroundColor: theme.palette.action.hover, color: '#d25353' },
            }}
          >
            <FlagOutlinedIcon fontSize="small" />
          </IconButton>
        </Tooltip>

        {/*
          "Edit game" + "Bump" for uploader or moderator only. The bump tooltip says WHEN it's
          possible again.
        */}
        {canManage && onEditGame && (
          <Tooltip title="Edit game (title, description, images…)" arrow>
            <IconButton
              onClick={onEditGame}
              size="small"
              sx={{
                width: 36,
                height: 36,
                color: theme.palette.primary.light,
                '&:hover': { backgroundColor: theme.palette.action.hover, color: theme.palette.primary.main },
              }}
            >
              <EditOutlinedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
        {onReuploadGame && (
          <Tooltip title="Re-upload game files (new version on our hosting)" arrow>
            <IconButton
              onClick={onReuploadGame}
              size="small"
              sx={{
                width: 36,
                height: 36,
                color: theme.palette.primary.light,
                '&:hover': { backgroundColor: theme.palette.action.hover, color: theme.palette.primary.main },
              }}
            >
              <CloudUploadOutlinedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
        {canManage && onBumpGame && (() => {
          const nextBump = bumpedAt
            ? new Date(new Date(bumpedAt.replace(' ', 'T')).getTime() + BUMP_COOLDOWN_MS)
            : null;
          const onCooldown = nextBump !== null && nextBump.getTime() > Date.now();
          const tip = onCooldown
            ? `Update bump – next available ${nextBump!.toLocaleDateString()}`
            : 'Update bump – updated the game? Bump it to the top';
          return (
            <Tooltip title={tip} arrow>
              <IconButton
                onClick={onBumpGame}
                size="small"
                sx={{
                  width: 36,
                  height: 36,
                  color: onCooldown ? 'text.disabled' : theme.palette.primary.light,
                  '&:hover': { backgroundColor: theme.palette.action.hover, color: theme.palette.primary.main },
                }}
              >
                <KeyboardDoubleArrowUpIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          );
        })()}

        {userID && canEditTags && (
          <Tooltip title={tagsEditing ? 'Done editing tags' : 'Edit tags'} arrow>
            <IconButton
              onClick={onToggleTagsEdit}
              size="small"
              sx={{
                width: 36,
                height: 36,
                color: tagsEditing ? theme.palette.success.light : theme.palette.primary.light,
                backgroundColor: tagsEditing ? theme.palette.action.selected : 'transparent',
                '&:hover': {
                  backgroundColor: theme.palette.action.hover,
                  color: tagsEditing ? theme.palette.success.main : theme.palette.primary.main,
                },
              }}
            >
              <LocalOfferOutlinedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}

        {/*
          Personal silent blocklist (logged-in only): no counters, just removes the game from all
          this user's lists.
        */}
        {userID && (
          <Tooltip title={isHidden ? 'Show again in my feed' : 'Hide from my feed'} arrow>
            <span>
              <IconButton
                onClick={() => setBlacklisted(!isHidden)}
                disabled={hideLoading}
                size="small"
                sx={{
                  width: 36,
                  height: 36,
                  color: isHidden ? theme.palette.secondary.light : 'text.disabled',
                  '&:hover': { backgroundColor: theme.palette.action.hover, color: theme.palette.secondary.main },
                }}
              >
                {isHidden ? <VisibilityOutlinedIcon fontSize="small" /> : <VisibilityOffOutlinedIcon fontSize="small" />}
              </IconButton>
            </span>
          </Tooltip>
        )}

        <Menu
          anchorEl={modAnchor}
          open={Boolean(modAnchor)}
          onClose={() => setModAnchor(null)}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        >
          <MenuItem disabled sx={{ opacity: 0.7, fontSize: '0.8rem' }}>
            What’s wrong with this game?
          </MenuItem>
          {MOD_KINDS.map((k) => (
            <Tooltip key={k.kind} title={k.hint} placement="right" arrow>
              <MenuItem onClick={() => pickModKind(k.kind)}>
                <ListItemText primary={k.label} />
              </MenuItem>
            </Tooltip>
          ))}
        </Menu>

      </Box>

      <RelatedGamesList relationships={relatedGames} currentGameId={gameId} />

      <Snackbar
        open={snack.open}
        autoHideDuration={5000}
        onClose={() => setSnack((s) => ({ ...s, open: false }))}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        message={snack.msg}
        action={
          snack.undo ? (
            <Button
              color="secondary"
              size="small"
              onClick={() => {
                const fn = snack.undo;
                setSnack((s) => ({ ...s, open: false }));
                fn?.();
              }}
            >
              Undo
            </Button>
          ) : null
        }
      />
    </Box>
  );
}