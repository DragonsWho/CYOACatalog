// A single comment plus its recursively rendered replies: collapse/expand, inline reply/edit,
// delete, tombstones.

import { memo, useEffect, useState } from 'react';
import { Avatar, Box, IconButton, Stack, Tooltip, Typography } from '@mui/material';
import PushPinIcon from '@mui/icons-material/PushPin';
import PushPinOutlinedIcon from '@mui/icons-material/PushPinOutlined';
import FavoriteIcon from '@mui/icons-material/Favorite';
import FavoriteBorderIcon from '@mui/icons-material/FavoriteBorder';
import ReplyIcon from '@mui/icons-material/Reply';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import CheckIcon from '@mui/icons-material/Check';
import CloseIcon from '@mui/icons-material/Close';
import CommentBody from './CommentBody';
import CommentForm from './CommentForm';
import { hasCommentDraft } from './commentDrafts';
import { absoluteTime, relativeTime, wasEdited } from './relativeTime';
import {
  avatarColor,
  avatarUrl,
  CommentNodeData,
  displayName,
  initials,
  isTombstone,
  toggleCommentLike,
} from './commentsApi';

const MUTED = 'rgba(255,255,255,0.42)';
// Moderators keep the old avatar look (dark circle, red initials) to stand apart from color-coded
// users.
const MOD_RED = '#e8484e';

interface Props {
  node: CommentNodeData;
  depth: number;
  rawDepth: number;
  currentUserId: string | null;
  isModerator: boolean;
  // Ancestor ids of a deep-linked comment that must stay expanded so the target renders (overrides
  // auto-collapse).
  expandPath?: Set<string>;
  // Ids the viewer liked — fetched once per game and threaded down instead of a `likes` array per
  // node.
  likedIds?: Set<string>;
  onReply: (parentId: string, text: string) => Promise<void>;
  onEdit: (id: string, text: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onPin: (id: string, pinned: boolean) => Promise<void>;
}

const MAX_INDENT_DEPTH = 6;
// Deeply nested branches start collapsed (Reddit "continue this thread").
const AUTO_COLLAPSE_DEPTH = 4;

// Popular threads mount hundreds of these. memo works because Comments.tsx memoizes buildThread()
// (stable node identity), handlers are useCallback'd, and likedIds/expandPath are stable Sets —
// shallow memo suffices.
function CommentNode({
  node,
  depth,
  rawDepth,
  currentUserId,
  isModerator,
  expandPath,
  likedIds,
  onReply,
  onEdit,
  onDelete,
  onPin,
}: Props) {
  // If a reply/edit draft survives reload, open the form immediately — otherwise the text sits
  // invisibly in storage and seems lost.
  const replyDraftKey = `reply.${node.id}`;
  const editDraftKey = `edit.${node.id}`;
  const [replying, setReplying] = useState(() => hasCommentDraft(replyDraftKey));
  const [editing, setEditing] = useState(() => hasCommentDraft(editDraftKey));

  const [collapsed, setCollapsed] = useState(
    () =>
      rawDepth >= AUTO_COLLAPSE_DEPTH &&
      node.replies.length > 0 &&
      !expandPath?.has(node.id) &&
      // A collapsed branch would hide the restored form with its text.
      !hasCommentDraft(replyDraftKey) &&
      !hasCommentDraft(editDraftKey),
  );

  // Force-open when on the path to a deep-linked comment (root paged in after mount, or another
  // notification clicked).
  useEffect(() => {
    if (expandPath?.has(node.id)) setCollapsed(false);
  }, [expandPath, node.id]);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // In-flight guard (double tap = two concurrent deletes) plus failure flag: onDelete can reject
  // (network/403/already gone) and the confirm row used to sit there without feedback.
  const [deleting, setDeleting] = useState(false);
  const [deleteFailed, setDeleteFailed] = useState(false);
  const [pinning, setPinning] = useState(false);

  // Likes: optimistic local state, re-synced when the server value or viewer changes.
  const [liked, setLiked] = useState(false);
  const [likeCount, setLikeCount] = useState(0);
  const [likeBusy, setLikeBusy] = useState(false);
  useEffect(() => {
    setLiked(!!likedIds?.has(node.id));
    setLikeCount(node.likes_count ?? 0);
  }, [node.id, node.likes_count, likedIds]);

  const handleLike = async () => {
    if (!currentUserId || likeBusy) return;
    setLikeBusy(true);
    const prevLiked = liked;
    const prevCount = likeCount;
    setLiked(!prevLiked);
    setLikeCount((n) => Math.max(0, n + (prevLiked ? -1 : 1)));
    try {
      const { state, count } = await toggleCommentLike(node.id);
      setLiked(state);
      setLikeCount(count);
    } catch {
      setLiked(prevLiked);
      setLikeCount(prevCount);
    } finally {
      setLikeBusy(false);
    }
  };

  const author = node.expand?.author;
  const tombstone = isTombstone(node);
  const authorIsMod = !tombstone && !!author?.isModerator;
  const isOwner = !!currentUserId && node.author === currentUserId;
  const canEdit = isOwner && !tombstone;
  const canDelete = (isOwner || isModerator) && !tombstone;
  const canReply = !!currentUserId;
  // Only top-level comments can be pinned, by moderators.
  const canPin = isModerator && rawDepth === 0 && !tombstone;
  const replyCount = node.replies.length;

  const headerLine = (
    <Stack direction="row" alignItems="center" spacing={1} sx={{ minHeight: 28 }}>
      <Box
        component="button"
        onClick={() => setCollapsed((c) => !c)}
        aria-label={collapsed ? 'Expand thread' : 'Collapse thread'}
        sx={{
          all: 'unset',
          cursor: 'pointer',
          color: MUTED,
          fontSize: '0.8rem',
          width: 16,
          textAlign: 'center',
          '&:hover': { color: 'text.primary' },
        }}
      >
        {collapsed ? '+' : '–'}
      </Box>
      <Avatar
        src={tombstone ? undefined : avatarUrl(author)}
        sx={{
          width: 24,
          height: 24,
          fontSize: '0.68rem',
          fontWeight: 700,
          bgcolor: 'rgba(255,255,255,0.06)',
          color: tombstone ? MUTED : authorIsMod ? MOD_RED : avatarColor(author),
        }}
      >
        <Box
          component="span"
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '100%',
            height: '100%',
            lineHeight: 1,
          }}
        >
          {tombstone ? '?' : initials(author)}
        </Box>
      </Avatar>
      <Tooltip title={!tombstone && author?.username ? `@${author.username}` : ''} arrow>
        <Typography
          variant="body2"
          sx={{
            fontWeight: 600,
            color: tombstone ? MUTED : 'text.primary',
            cursor: !tombstone && author?.username ? 'help' : 'default',
          }}
        >
          {tombstone ? '[deleted]' : displayName(author)}
        </Typography>
      </Tooltip>
      {isOwner && !tombstone && (
        <Typography
          component="span"
          sx={{ fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.06em', color: '#d25353' }}
        >
          YOU
        </Typography>
      )}
      {authorIsMod && (
        <Tooltip title="Moderator">
          <Typography
            component="span"
            sx={{ fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.06em', color: MUTED }}
          >
            MOD
          </Typography>
        </Tooltip>
      )}
      {node.pinned && (
        <Tooltip title={node.kind === 'changelog' ? 'Update history of this game' : 'Pinned by a moderator'}>
          <Stack direction="row" alignItems="center" spacing={0.25} sx={{ color: MUTED }}>
            <PushPinIcon sx={{ fontSize: '0.85rem' }} />
            <Typography variant="caption">
              {node.kind === 'changelog' ? 'Changelog' : 'Pinned'}
            </Typography>
          </Stack>
        </Tooltip>
      )}
      <Tooltip title={absoluteTime(node.created)}>
        <Typography variant="caption" sx={{ color: MUTED }}>
          {relativeTime(node.created)}
        </Typography>
      </Tooltip>
      {!tombstone && wasEdited(node.created, node.updated) && (
        <Tooltip title={absoluteTime(node.updated)}>
          <Typography variant="caption" sx={{ color: MUTED, fontStyle: 'italic' }}>
            (edited)
          </Typography>
        </Tooltip>
      )}
      {collapsed && replyCount > 0 && (
        <Typography variant="caption" sx={{ color: MUTED }}>
          · {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
        </Typography>
      )}
    </Stack>
  );

  const iconBtnSx = {
    p: 0.5,
    color: MUTED,
    '&:hover': { color: 'text.primary', bgcolor: 'transparent' },
  } as const;
  const ICON = { fontSize: '1rem' } as const;

  return (
    <Box id={`comment-${node.id}`} sx={{ mt: depth === 0 ? 2 : 1.5 }} data-testid="comment" data-comment-id={node.id}>
      {headerLine}

      {!collapsed && (
        <Box
          sx={{
            ml: '11px',
            pl: 2,
            borderLeft: depth === 0 ? 'none' : '2px solid',
            borderColor: 'rgba(255,255,255,0.08)',
          }}
        >
          <Box sx={{ mt: 0.5 }}>
            {editing ? (
              <CommentForm
                initialValue={node.content}
                submitLabel="Save"
                autoFocus
                draftKey={editDraftKey}
                onCancel={() => setEditing(false)}
                onSubmit={async (text) => {
                  await onEdit(node.id, text);
                  setEditing(false);
                }}
              />
            ) : tombstone ? (
              <Typography variant="body2" sx={{ color: 'text.secondary', fontStyle: 'italic' }}>
                [comment deleted]
              </Typography>
            ) : (
              <CommentBody content={node.content} loadable mine={isOwner} />
            )}
          </Box>

          {!editing && (
            <Stack direction="row" spacing={0.5} sx={{ mt: 0.5 }} alignItems="center">
              {!tombstone && (
                <Stack direction="row" spacing={0.25} alignItems="center">
                  <Tooltip title={currentUserId ? (liked ? 'Unlike' : 'Like') : 'Log in to like'} arrow>
                    <span>
                      <IconButton
                        size="small"
                        aria-label={liked ? 'Unlike comment' : 'Like comment'}
                        sx={{ ...iconBtnSx, color: liked ? MOD_RED : MUTED, '&:hover': { color: liked ? MOD_RED : 'text.primary', bgcolor: 'transparent' } }}
                        disabled={!currentUserId || likeBusy}
                        onClick={handleLike}
                      >
                        {liked ? <FavoriteIcon sx={ICON} /> : <FavoriteBorderIcon sx={ICON} />}
                      </IconButton>
                    </span>
                  </Tooltip>
                  {likeCount > 0 && (
                    <Typography variant="caption" sx={{ color: liked ? MOD_RED : MUTED, minWidth: 8 }}>
                      {likeCount}
                    </Typography>
                  )}
                </Stack>
              )}
              {canReply && (
                <Tooltip title="Reply" arrow>
                  <IconButton size="small" aria-label="Reply" sx={iconBtnSx} onClick={() => setReplying((r) => !r)}>
                    <ReplyIcon sx={ICON} />
                  </IconButton>
                </Tooltip>
              )}
              {canEdit && (
                <Tooltip title="Edit" arrow>
                  <IconButton size="small" aria-label="Edit comment" sx={iconBtnSx} onClick={() => setEditing(true)}>
                    <EditOutlinedIcon sx={ICON} />
                  </IconButton>
                </Tooltip>
              )}
              {canDelete &&
                (confirmingDelete ? (
                  <Stack direction="row" spacing={0.25} alignItems="center">
                    <Typography variant="caption" sx={{ color: deleteFailed ? 'error.main' : 'text.secondary' }}>
                      {deleteFailed ? 'Failed — retry?' : 'Delete?'}
                    </Typography>
                    <Tooltip title="Confirm delete" arrow>
                      <span>
                        <IconButton
                          size="small"
                          aria-label="Confirm delete"
                          disabled={deleting}
                          sx={{ ...iconBtnSx, color: 'error.main', '&:hover': { color: 'error.main', bgcolor: 'transparent' } }}
                          onClick={async () => {
                            setDeleting(true);
                            setDeleteFailed(false);
                            try {
                              await onDelete(node.id);
                              setConfirmingDelete(false);
                            } catch {
                              // Stay in the confirm row and say so instead of silently doing
                              // nothing on rejection.
                              setDeleteFailed(true);
                            } finally {
                              setDeleting(false);
                            }
                          }}
                        >
                          <CheckIcon sx={ICON} />
                        </IconButton>
                      </span>
                    </Tooltip>
                    <Tooltip title="Cancel" arrow>
                      <IconButton
                        size="small"
                        aria-label="Cancel delete"
                        sx={iconBtnSx}
                        disabled={deleting}
                        onClick={() => {
                          setConfirmingDelete(false);
                          setDeleteFailed(false);
                        }}
                      >
                        <CloseIcon sx={ICON} />
                      </IconButton>
                    </Tooltip>
                  </Stack>
                ) : (
                  <Tooltip title="Delete" arrow>
                    <IconButton size="small" aria-label="Delete comment" sx={iconBtnSx} onClick={() => setConfirmingDelete(true)}>
                      <DeleteOutlineIcon sx={ICON} />
                    </IconButton>
                  </Tooltip>
                ))}
              {canPin && (
                <Tooltip title={node.pinned ? 'Unpin' : 'Pin'} arrow>
                  <span>
                    <IconButton
                      size="small"
                      aria-label={node.pinned ? 'Unpin comment' : 'Pin comment'}
                      sx={iconBtnSx}
                      disabled={pinning}
                      onClick={async () => {
                        setPinning(true);
                        try {
                          await onPin(node.id, !node.pinned);
                        } finally {
                          setPinning(false);
                        }
                      }}
                    >
                      {node.pinned ? <PushPinIcon sx={ICON} /> : <PushPinOutlinedIcon sx={ICON} />}
                    </IconButton>
                  </span>
                </Tooltip>
              )}
            </Stack>
          )}

          {replying && (
            <Box sx={{ mt: 1.5 }}>
              <CommentForm
                placeholder="Write a reply…"
                submitLabel="Reply"
                autoFocus
                draftKey={replyDraftKey}
                onCancel={() => setReplying(false)}
                onSubmit={async (text) => {
                  await onReply(node.id, text);
                  setReplying(false);
                }}
              />
            </Box>
          )}

          {node.replies.map((child) => (
            <CommentNode
              key={child.id}
              node={child}
              depth={Math.min(depth + 1, MAX_INDENT_DEPTH)}
              rawDepth={rawDepth + 1}
              currentUserId={currentUserId}
              isModerator={isModerator}
              expandPath={expandPath}
              likedIds={likedIds}
              onReply={onReply}
              onEdit={onEdit}
              onDelete={onDelete}
              onPin={onPin}
            />
          ))}
        </Box>
      )}
    </Box>
  );
}

export default memo(CommentNode);
