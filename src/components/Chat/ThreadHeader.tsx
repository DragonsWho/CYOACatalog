// Topic header: the OP of a user thread. The OP is a ROOM FIELD (op_text/op_image), not the first
// feed message. The reverse used to break three ways: the message could be deleted, a pin displaced
// it, and a fresh topic had no "first" yet so the first reply silently became the topic. A room
// field can't be overwritten — the whole class is closed by design.
// Two states:
// - expanded on room entry: read IMMEDIATELY and FULLY. It used to be capped at a third of the
// screen with internal scroll; now it's the FIRST FEED ITEM and scrolls with it — finish the post,
// comments follow in one motion.
// - collapsed once the reader moves the feed: exactly the topic-list row (avatar, title, two
// summary lines, caption, thumbnails) so people recognize what they clicked.
// Collapsing is decided by the SCREEN (ChatView) from scroll position: when the remaining tail
// equals the collapsed height it swaps (invisible, same height) and becomes a sticky strip; near
// the top it expands again like the topic's first message. Manual toggle via chevron or the author
// row ("skip to comments" / "show full post", which scrolls to its start).
// No title and no back arrow here on purpose: both are in the chat bar above (two different arrows
// side by side were indistinguishable). The author avatar takes the top-left slot.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Avatar, Box, IconButton, Stack, Tooltip, Typography } from '@mui/material';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import ShieldOutlinedIcon from '@mui/icons-material/ShieldOutlined';
import FavoriteIcon from '@mui/icons-material/Favorite';
import FavoriteBorderIcon from '@mui/icons-material/FavoriteBorder';
import ChatBubbleOutlineIcon from '@mui/icons-material/ChatBubbleOutline';
import { avatarUrlOf } from '../Shoutbox/shoutboxApi';
import {
  agoLabel,
  communityAuthor,
  opImageSize,
  opImageUrlAt,
  opImages,
  stripOpTokens,
  toggleCommunityLike,
  toggleCommunityOpReaction,
  topReacts,
  type CommunityRoom,
} from './communityApi';
import { OpReacts, TagWord } from './CommunityList';
import OpBody from './OpBody';
import AnonMaskIcon from './AnonMaskIcon';
import ReactionBar from '../Emoji/ReactionBar';
import type { ReactionMap } from '../Emoji/registry';
import HiddenImage from './HiddenImage';

type Props = {
  topic: CommunityRoom;
  collapsed: boolean;
  onCollapsed: (v: boolean) => void;
  // Header node exposed so the screen can measure the tail. Typed structurally, not RefObject: in
  // React 18 types `current` is read-only and assignment wouldn't compile (`tsc -b` from ship).
  nodeRef?: { current: HTMLDivElement | null };
  onEdit?: () => void;
  // Moderation separate from onEdit on purpose: the owner edits their post but not the title by
  // which it was found and remembered.
  onModerate?: () => void;
  // Heart shown but disabled for guests (the server refuses; a hidden button reads as "can't like
  // this").
  signedIn?: boolean;
  meId?: string;
  blurImages?: boolean;
};

// Thumb side in the collapsed header a bit smaller than the list's 64: it must stay a strip, not
// half the conversation.
const THUMB = 52;

// Thumbnail count from the header's own width (it sits between columns; the viewport lies).
function thumbsFor(width: number): number {
  if (width < 440) return 1;
  if (width < 560) return 2;
  return 3;
}

export default function ThreadHeader({
  topic, collapsed, onCollapsed, nodeRef, onEdit, onModerate, signedIn, meId, blurImages = false,
}: Props) {
  // Like in local state: the server returns the result; refetching the room would flash the whole
  // header.
  const [likes, setLikes] = useState(topic.likes);
  const [liked, setLiked] = useState(Boolean(topic.liked));
  useEffect(() => {
    setLikes(topic.likes);
    setLiked(Boolean(topic.liked));
  }, [topic.id, topic.likes, topic.liked]);

  const like = useCallback(async () => {
    if (!signedIn) return;
    try {
      const res = await toggleCommunityLike(topic.id);
      setLikes(res.likes);
      setLiked(res.liked);
    } catch { }
  }, [signedIn, topic.id]);

  // Reactions in local state for the same reason (server returns the full map). The map comes only
  // in /community/room, not in lists — a topic opened from an already-loaded row shows none until
  // the server answers. Not a bug: empty row looks the same as no reactions.
  const [reactions, setReactions] = useState<ReactionMap>(() => topic.op_reactions ?? {});
  useEffect(() => { setReactions(topic.op_reactions ?? {}); }, [topic.id, topic.op_reactions]);

  const react = useCallback(async (name: string) => {
    if (!signedIn) return;
    try {
      const res = await toggleCommunityOpReaction(topic.id, name);
      setReactions(res.reactions);
    } catch { }
  }, [signedIn, topic.id]);

  const boxRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = boxRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const tags = topic.tags ?? [];
  // description is a fallback for topics created before the OP moved into room fields (op_text
  // empty, short description present). For new topics description is derived from op_text, so there
  // are never two texts.
  const text = topic.op_text || topic.description || '';
  const names = opImages(topic);
  const views = names.map((_, i) => {
    const size = opImageSize(topic, i);
    return { url: opImageUrlAt(topic, i, '720x0') ?? '', w: size?.w, h: size?.h };
  }).filter((v) => v.url);
  // Permanent rooms have no owner (the site holds them; "someone" would read as "unknown author");
  // anonymous topics are signed by the mask (communityAuthor).
  const author = communityAuthor(topic);
  const owner = author.card;
  const byline = author.name;

  const thumbs = thumbsFor(width || 720);
  const shownThumbs = names.slice(0, thumbs);
  const extraThumbs = names.length - shownThumbs.length;

  // Nothing to show (no text, images or tags) → no strip. Except for whoever can edit (moderator in
  // a permanent room, owner in their topic): the strip is their only entry to editing, else there'd
  // be no way to create an OP.
  if (!text && !views.length && tags.length === 0 && !onEdit) return null;

  const collapseBtn = (
    <Tooltip title={collapsed ? 'Show the topic' : 'Collapse the topic'}>
      <IconButton
        size="small"
        onClick={(e) => { e.stopPropagation(); onCollapsed(!collapsed); }}
        aria-label={collapsed ? 'Show the topic' : 'Collapse the topic'}
        sx={{ flexShrink: 0 }}
      >
        {collapsed ? <ExpandMoreIcon sx={{ fontSize: 18 }} /> : <ExpandLessIcon sx={{ fontSize: 18 }} />}
      </IconButton>
    </Tooltip>
  );

  // 32px rounded square like feed avatars (the topic starter is the same person as in the
  // comments). `over` lifts the avatar into the gap above like the message plaque.
  const avatar = (size: number, over = false) => (
    <Avatar
      variant="rounded"
      src={avatarUrlOf(owner)}
      sx={{ width: size, height: size, flexShrink: 0, fontSize: size * 0.42, borderRadius: '30%', ...(over ? { mt: { xs: '-6px', md: '1px' } } : { mt: '1px' }) }}
    >
      {author.anon ? <AnonMaskIcon sx={{ fontSize: size * 0.62 }} /> : (owner?.name || '?')[0]}
    </Avatar>
  );

  return (
    <Box
      ref={(el: HTMLDivElement | null) => {
        boxRef.current = el;
        if (nodeRef) nodeRef.current = el;
      }}
      onClick={collapsed ? () => onCollapsed(false) : undefined}
      sx={{
        flexShrink: 0,
        mb: 1,
        // Collapsed header is sticky (the subject shouldn't scroll away); expanded scrolls
        // normally.
        ...(collapsed
          ? {
            position: 'sticky',
            top: 0,
            zIndex: 3,
            // Background must be OPAQUE: text scrolls under the sticky strip. The old translucent
            // white stays as a layer over a solid background.
            bgcolor: 'background.default',
            backgroundImage: 'linear-gradient(rgba(255,255,255,0.045), rgba(255,255,255,0.045))',
          }
          : { bgcolor: 'rgba(255,255,255,0.045)' }),
        // Same padding as a message row: the starter's avatar must align above reply avatars.
        px: { xs: 0.5, md: 1.25 },
        // Expanded header gets slightly more top padding for the protruding avatar; max 6px (unlike
        // a feed row, it has a top border).
        py: collapsed ? 0.6 : 1.25,
        borderBottom: 1,
        borderColor: 'divider',
        // Left stripe is not amber: amber means "pinned" in this chat.
        boxShadow: 'inset 3px 0 0 rgba(140,170,255,0.55)',
        cursor: collapsed ? 'pointer' : 'default',
        '&:hover': collapsed ? { bgcolor: 'rgba(255,255,255,0.07)' } : undefined,
      }}
    >
      {collapsed ? (
        // Collapsed = exactly the topic-list row, with title (here it's a recognizable list item,
        // not the screen title).
        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.25, minWidth: 0 }}>
          {avatar(32)}
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minWidth: 0 }}>
              <Typography sx={{
                fontSize: 14,
                fontWeight: 700,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                minWidth: 0,
              }}>
                {topic.title}
              </Typography>
              {tags.map((t) => <TagWord key={t} tag={t} />)}
            </Stack>

            {/*
              Summary two lines; markup deliberately not parsed (emoji are noise; [imgN] without
              images reads as a typo).
            */}
            {text && (
              <Typography sx={{
                mt: 0.25,
                fontSize: 12.5,
                lineHeight: 1.45,
                color: 'text.secondary',
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
                wordBreak: 'break-word',
              }}>
                {stripOpTokens(text)}
              </Typography>
            )}

            <Stack
              direction="row"
              spacing={0.75}
              alignItems="center"
              sx={{ mt: 0.35, fontSize: 11, color: 'text.disabled', flexWrap: 'wrap', rowGap: 0.25 }}
            >
              <Box component="span" sx={{ fontWeight: 700, color: author.color || 'text.secondary' }}>
                {byline}
              </Box>
              <Box component="span">· {agoLabel(topic.created)}</Box>
              <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.35, ml: 0.5 }}>
                <ChatBubbleOutlineIcon sx={{ fontSize: 12 }} />
                {topic.msgs}
              </Box>
              {likes > 0 && (
                <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.35 }}>
                  <FavoriteIcon sx={{ fontSize: 12, color: liked ? 'error.main' : 'inherit' }} />
                  {likes}
                </Box>
              )}
              {/*
                Same reaction summary as the list row. Computed from our local map, not
                topic.op_top: op_top came before the click, so a just-added reaction would vanish
                on collapse.
              */}
              <OpReacts top={topReacts(reactions, meId ?? '')} />
            </Stack>
          </Box>

          {/* Thumbnails as in the list; "+N" on the last tile. */}
          {shownThumbs.length > 0 && (
            <Box sx={{ display: 'flex', gap: 0.5, flexShrink: 0, mt: 0.25 }}>
              {shownThumbs.map((_, i) => (
                <Box key={i} sx={{ position: 'relative', width: THUMB, height: THUMB, flexShrink: 0 }}>
                  <HiddenImage
                    src={opImageUrlAt(topic, i, '160x160') ?? ''}
                    revealKey={`thread-thumb:${topic.id}:${i}`}
                    alt=""
                    loading="lazy"
                    blurUntilClicked={blurImages}
                    sx={{
                      display: 'block',
                      width: '100%',
                      height: '100%',
                      objectFit: 'cover',
                      borderRadius: 1,
                      border: 1,
                      borderColor: 'divider',
                    }}
                  />
                  {i === shownThumbs.length - 1 && extraThumbs > 0 && (
                    <Box sx={{
                      position: 'absolute',
                      inset: 0,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderRadius: 1,
                      bgcolor: 'rgba(0,0,0,0.55)',
                      color: '#fff',
                      fontSize: 12,
                      fontWeight: 800,
                    }}>
                      +{extraThumbs}
                    </Box>
                  )}
                </Box>
              ))}
            </Box>
          )}

          {collapseBtn}
        </Box>
      ) : (
        <Box sx={{ minWidth: 0 }}>
          <Box sx={{ minWidth: 0 }}>
            {/*
              Author row first and bold (people identify the topic by person before tags). Post
              text spans full width below (images are the content; don't lose 42 px to an avatar
              column). Click toggles ONLY on this row — not the whole post (text selection, links,
              images live there).
            */}
            <Stack
              direction="row"
              spacing={0.75}
              alignItems="center"
              onClick={() => onCollapsed(true)}
              sx={{
                minWidth: 0,
                cursor: 'pointer',
                borderRadius: 1,
                '&:hover': { bgcolor: 'rgba(255,255,255,0.05)' },
              }}
            >
              {avatar(32, true)}
              <Typography sx={{ fontSize: 14, fontWeight: 800, flexShrink: 0, color: author.color || undefined }}>
                {byline}
              </Typography>
              <Tooltip title={new Date(topic.created * 1000).toLocaleString()} disableInteractive>
                <Typography sx={{ fontSize: 11.5, color: 'text.disabled', flexShrink: 0 }}>
                  {agoLabel(topic.created)}
                </Typography>
              </Tooltip>
              <Stack direction="row" spacing={0.5} sx={{ minWidth: 0, overflow: 'hidden' }}>
                {tags.map((t) => <TagWord key={t} tag={t} />)}
              </Stack>
              <Box sx={{ flex: 1 }} />
              {onEdit && (
                <Tooltip title="Edit the opening post">
                  <IconButton
                    size="small"
                    onClick={(e) => { e.stopPropagation(); onEdit(); }}
                    sx={{ flexShrink: 0 }}
                  >
                    <EditOutlinedIcon sx={{ fontSize: 16 }} />
                  </IconButton>
                </Tooltip>
              )}
              {onModerate && (
                <Tooltip title="Moderate: title, tags, hide">
                  <IconButton
                    size="small"
                    onClick={(e) => { e.stopPropagation(); onModerate(); }}
                    sx={{ flexShrink: 0 }}
                  >
                    <ShieldOutlinedIcon sx={{ fontSize: 16 }} />
                  </IconButton>
                </Tooltip>
              )}
              {collapseBtn}
            </Stack>

            <Box
              sx={{
                mt: 0.5,
                // No max-height or internal scroll: the post shows fully and scrolls with the feed
                // (internal scroll cut the text and stole the wheel). OP text larger than the feed
                // on wide screens.
                fontSize: { xs: 14, sm: 15 },
                lineHeight: 1.5,
                wordBreak: 'break-word',
              }}
            >
              <OpBody
                text={text}
                images={views}
                blurImages={blurImages}
                // No lightbox in the header: it lives in the feed and pages its images; the topic
                // isn't in that sequence. Full size opens in a tab.
                onImageClick={(i) => {
                  const full = opImageUrlAt(topic, i);
                  if (full) window.open(full, '_blank', 'noopener');
                }}
              />
            </Box>

            {/*
              Footer (like, date, reply count, reactions) at the bottom: read after finishing the
              post.
            */}
            <Stack
              direction="row"
              spacing={1.25}
              alignItems="center"
              sx={{ mt: 0.75, pt: 0.5, borderTop: 1, borderColor: 'divider', flexWrap: 'wrap', rowGap: 0.5 }}
            >
              <Tooltip title={signedIn ? (liked ? 'Remove like' : 'Like this thread') : 'Sign in to like'}>
                <Box
                  component="button"
                  type="button"
                  aria-label={liked ? 'Remove like' : 'Like'}
                  aria-pressed={liked}
                  onClick={() => void like()}
                  disabled={!signedIn}
                  sx={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 0.4,
                    px: 0.75,
                    py: 0.25,
                    ml: -0.75,
                    border: 0,
                    borderRadius: 999,
                    bgcolor: 'transparent',
                    color: liked ? 'error.main' : 'text.disabled',
                    fontFamily: 'inherit',
                    fontSize: 12,
                    fontWeight: 700,
                    cursor: signedIn ? 'pointer' : 'default',
                    '&:hover': signedIn ? { bgcolor: 'rgba(255,255,255,0.07)' } : {},
                  }}
                >
                  {liked ? <FavoriteIcon sx={{ fontSize: 15 }} /> : <FavoriteBorderIcon sx={{ fontSize: 15 }} />}
                  {likes || ''}
                </Box>
              </Tooltip>

              <Box sx={{
                display: 'inline-flex', alignItems: 'center', gap: 0.4,
                fontSize: 12, fontWeight: 700, color: 'text.disabled',
              }}>
                <ChatBubbleOutlineIcon sx={{ fontSize: 14 }} />
                {topic.msgs}
              </Box>

              <Tooltip title={new Date(topic.created * 1000).toLocaleString()} disableInteractive>
                <Box component="span" sx={{ fontSize: 11.5, color: 'text.disabled' }}>
                  {new Date(topic.created * 1000).toLocaleDateString()}
                </Box>
              </Tooltip>

              {/*
                Reactions as the same pill row as feed messages, in the footer (a separate row with
                a lone "+" wasted a line; wraps only when many). Like ≠ reaction: one like per
                topic drives "Top" sort; reactions are opinions and sort nothing. "+" ALWAYS shown
                (showAdd) — someone must add the first. Not for guests (server refuses).
              */}
              <ReactionBar
                inline
                reactions={reactions}
                meId={meId}
                onToggle={(name) => void react(name)}
                showAdd={Boolean(signedIn)}
              />
            </Stack>
          </Box>
        </Box>
      )}
    </Box>
  );
}
