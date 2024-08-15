// src/components/SimpleComments.jsx
// v3.31
// Added edit and delete functionality

import React, { useState, useEffect } from 'react';
import { Box, Typography } from '@mui/material';
import { CommentSection } from 'react-comments-section';
import 'react-comments-section/dist/index.css';
import { fetchComments, postComment, editComment, deleteComment } from '../../services/api';
import authService from '../../services/authService';

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


    const formatComments = (commentsData) => {
        const flattenComments = (comment, parentId = null, depth = 0) => {
            const formattedComment = {
                userId: comment.author?.id?.toString() || 'anonymous',
                comId: comment.id.toString(),
                fullName: comment.author?.name || 'Anonymous',
                avatarUrl: `https://ui-avatars.com/api/?name=${encodeURIComponent(comment.author?.name || 'Anonymous')}`,
                text: comment.content,
                replies: [],
                parentId: parentId
            };

            let result = [formattedComment];

            if (comment.children && comment.children.length > 0) {
                comment.children.forEach(childComment => {
                    if (depth === 0) {
                        // For top-level comments, keep one level of nesting
                        formattedComment.replies.push(...flattenComments(childComment, formattedComment.comId, depth + 1));
                    } else {
                        // For deeper levels, flatten the structure
                        result.push(...flattenComments(childComment, depth === 1 ? formattedComment.comId : parentId, depth + 1));
                    }
                });
            }

            return result;
        };

        return commentsData.flatMap(comment => flattenComments(comment));
    };

    const handleSubmitComment = async (data, parentCommentId = null) => {
        try {
            await postComment(gameId, data.text, parentCommentId);
            await loadComments();
        } catch (error) {
            console.error('Error posting comment:', error);
        }
    };

    const handleEditComment = async (data) => {
        try {
            await editComment(gameId, data.comId, data.text);
            await loadComments();
        } catch (error) {
            console.error('Error editing comment:', error);
        }
    };

    const handleDeleteComment = async (data) => {
        try {
            console.log('Attempting to delete comment:', data);
            await deleteComment(gameId, data.comId);
            console.log('Comment deleted successfully');
            await loadComments();
        } catch (error) {
            console.error('Error deleting comment:', error);
            if (error.response) {
                console.error('Error response:', error.response.data);
                console.error('Error status:', error.response.status);
            } else if (error.request) {
                console.error('Error request:', error.request);
            } else {
                console.error('Error message:', error.message);
            }
        }
    };

    return (
        <Box>
            {user ? (
                <CommentSection
                    currentUser={{
                        currentUserId: user.user.id.toString(),
                        currentUserImg: `https://ui-avatars.com/api/?name=${encodeURIComponent(user.user.username)}`,
                        currentUserFullName: user.user.username
                    }}
                    commentData={comments}
                    onSubmitAction={(data) => handleSubmitComment(data, data.parentId)}
                    onReplyAction={(data) => handleSubmitComment(data, data.repliedToCommentId)}
                    onEditAction={handleEditComment}
                    onDeleteAction={handleDeleteComment}
                />
            ) : (
                <>
                    <Typography variant="h6" gutterBottom>
                        Comments ({comments.length})
                    </Typography>
                    <Typography>Please log in to post comments.</Typography>
                </>
            )}
        </Box>
    );
};

export default SimpleComments;