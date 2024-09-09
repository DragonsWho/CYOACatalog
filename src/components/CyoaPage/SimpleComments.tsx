// src/components/CyoaPage/SimpleComments.tsx
// v3.36
// Fixed TypeScript errors and improved type safety

import { useMemo } from 'react';
import { Box, Typography, useTheme, Theme } from '@mui/material';
import { CommentSection } from 'react-comments-section';
import 'react-comments-section/dist/index.css';
import { commentsCollection, Game, pb, useAuth } from '../../pocketbase/pocketbase';

interface FormattedComment {
  userId: string;
  comId: string;
  fullName: string;
  avatarUrl: string;
  text: string;
  replies: FormattedComment[];
  parentId: string | null;
}

interface CustomTheme extends Theme {
  custom?: {
    comments?: {
      backgroundColor?: string;
      borderRadius?: string;
      color?: string;
    };
  };
}

export default function SimpleComments({ game }: { game: Game }) {
  const { user } = useAuth();
  const theme = useTheme<CustomTheme>();

  const comments = useMemo(() => {
    const comments = game.expand?.comments;
    if (!comments) return [];

    const commentMap = new Map<string, FormattedComment>();
    for (const comment of comments) {
      commentMap.set(comment.id, {
        userId: comment.author,
        comId: comment.id,
        fullName: comment.expand?.author?.name || comment.expand?.author?.username || 'Anonymous',
        avatarUrl:
          comment.expand?.author?.avatar ||
          `https://ui-avatars.com/api/?name=${encodeURIComponent(comment.expand?.author?.name || comment.expand?.author?.username || 'Anonymous')}&background=1a1a1a&color=fc3447`,
        text: comment.content,
        replies: [],
        parentId: null,
      });
    }
    for (const comment of comments) {
      for (const childID of comment.children) {
        const child = commentMap.get(childID);
        if (child) {
          commentMap.get(comment.id)?.replies.push(child);
          child.parentId = comment.id;
        }
      }
    }
    return comments
      .map((comment) => commentMap.get(comment.id))
      .filter((x) => x !== undefined)
      .filter((x) => x.parentId === null);
  }, [game.expand?.comments]);

  async function handleSubmitComment(data: { text: string; parentId?: string }) {
    if (!user) return;
    await fetch('/api/custom/comments', {
      method: 'POST',
      body: JSON.stringify({ game_id: game.id, parent_id: data.parentId, content: data.text }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${pb.authStore.token}`,
      },
    });
  }

  async function handleEditComment(data: { comId: string; text: string }) {
    await commentsCollection.update(data.comId, { content: data.text });
  }

  async function handleDeleteComment(data: { comIdToDelete: string }) {
    if (!user) return;
    const comment = game.expand?.comments?.find((x) => x.id === data.comIdToDelete);
    if (user.id !== comment?.author)
      throw new Error(`You can only delete your own comments, ${user.id} is not ${comment?.author}`);
    await commentsCollection.delete(data.comIdToDelete);
  }

  const inputStyle = {
    color: '#dcdcdc',
  };

  return (
    <Box
      sx={{
        mt: 4,
        p: 2,
        backgroundColor: theme.custom?.comments?.backgroundColor,
        borderRadius: theme.custom?.comments?.borderRadius,
      }}
    >
      {user ? (
        <CommentSection
          currentUser={{
            currentUserId: user.id,
            currentUserImg:
              user.avatar ||
              `https://ui-avatars.com/api/?name=${encodeURIComponent(user.name || user.username)}&background=1a1a1a&color=fc3447`,
            currentUserFullName: user.name || user.username,
            currentUserProfile: '',
          }}
          commentData={comments}
          onSubmitAction={(data: { text: string; parentId?: string }) => handleSubmitComment(data)}
          onReplyAction={(data: { text: string; repliedToCommentId: string }) =>
            handleSubmitComment({ text: data.text, parentId: data.repliedToCommentId })
          }
          onEditAction={handleEditComment}
          onDeleteAction={handleDeleteComment}
          hrStyle={{ border: 'none' }}
          removeEmoji
          submitBtnStyle={{ border: '1px solid gray', backgroundColor: 'gray', color: 'black' }}
          cancelBtnStyle={{ border: '1px solid gray', backgroundColor: 'gray', color: 'black' }}
          titleStyle={{ color: 'gray' }}
          replyInputStyle={{ color: theme.palette.text.primary }}
          formStyle={{ backgroundColor: '#1e1e1e' }}
          inputStyle={inputStyle}
          // TODO: add actual login and signup links
          logIn={{ loginLink: '#', signupLink: '#' }}
        />
      ) : (
        <Typography sx={{ color: theme.custom?.comments?.color }}>Please log in to post comments.</Typography>
      )}
    </Box>
  );
}
