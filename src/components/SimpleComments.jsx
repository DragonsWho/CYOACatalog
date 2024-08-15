// src/components/SimpleComments.jsx
// v3.3
// Added support for nested comments

import React, { useState, useEffect } from 'react';
import { Box, Typography } from '@mui/material';
import { CommentSection } from 'react-comments-section';
import 'react-comments-section/dist/index.css';
import { fetchComments, postComment } from '../services/api';
import authService from '../services/authService';

const SimpleComments = ({ gameId }) => {
    const [comments, setComments] = useState([]);
    const [user, setUser] = useState(null);

    useEffect(() => {
        loadComments();
        const currentUser = authService.getCurrentUser();
        setUser(currentUser);
    }, [gameId]);

    const loadComments = async () => {
        try {
            const fetchedComments = await fetchComments(gameId);
            console.log('Fetched comments:', fetchedComments);
            const formattedComments = formatComments(fetchedComments);
            console.log('Formatted comments:', formattedComments);
            setComments(formattedComments);
        } catch (error) {
            console.error('Error loading comments:', error);
        }
    };

    const formatComments = (comments) => {
        const commentMap = new Map();
        const rootComments = [];

        comments.forEach(comment => {
            const formattedComment = {
                userId: comment.author?.id || 'anonymous',
                comId: comment.id,
                fullName: comment.author?.name || 'Anonymous',
                avatarUrl: `https://ui-avatars.com/api/?name=${encodeURIComponent(comment.author?.name || 'Anonymous')}`,
                text: comment.content,
                replies: []
            };

            commentMap.set(comment.id, formattedComment);

            if (comment.threadOf) {
                const parentComment = commentMap.get(comment.threadOf);
                if (parentComment) {
                    parentComment.replies.push(formattedComment);
                }
            } else {
                rootComments.push(formattedComment);
            }
        });

        return rootComments;
    };

    const handleSubmitComment = async (data, parentCommentId = null) => {
        try {
            await postComment(gameId, data.text, parentCommentId);
            loadComments();
        } catch (error) {
            console.error('Error posting comment:', error);
        }
    };

    return (
        <Box>
            <Typography variant="h6" gutterBottom>
                Comments ({comments.length})
            </Typography>
            {user ? (
                <CommentSection
                    currentUser={{
                        currentUserId: user.user.id,
                        currentUserImg: `https://ui-avatars.com/api/?name=${encodeURIComponent(user.user.username)}`,
                        currentUserFullName: user.user.username
                    }}
                    commentData={comments}
                    onSubmitAction={(data) => handleSubmitComment(data)}
                    onReplyAction={(data) => handleSubmitComment(data, data.parentOfRepliedCommentId)}
                    logIn={{
                        loginLink: '/login',
                        signupLink: '/signup'
                    }}
                />
            ) : (
                <Typography>Please log in to post comments.</Typography>
            )}
        </Box>
    );
};

export default SimpleComments;