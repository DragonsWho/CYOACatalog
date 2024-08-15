// src/components/SimpleComments.jsx
// v1.1
// Updated to use authenticated user data

import React, { useState, useEffect } from 'react';
import { Box, TextField, Button, List, ListItem, ListItemText, Typography } from '@mui/material';
import { fetchComments, postComment } from '../services/api';
import authService from '../services/authService';

const SimpleComments = ({ gameId }) => {
    const [comments, setComments] = useState([]);
    const [newComment, setNewComment] = useState('');
    const [user, setUser] = useState(null);

    useEffect(() => {
        loadComments();
        const currentUser = authService.getCurrentUser();
        setUser(currentUser);
    }, [gameId]);

    const loadComments = async () => {
        try {
            const fetchedComments = await fetchComments(gameId);
            setComments(fetchedComments);
        } catch (error) {
            console.error('Error loading comments:', error);
        }
    };

    const handleSubmitComment = async (e) => {
        e.preventDefault();
        if (!newComment.trim()) return;

        try {
            await postComment(gameId, newComment);
            setNewComment('');
            loadComments();
        } catch (error) {
            console.error('Error posting comment:', error);
            if (error.response) {
                console.error('Full error response:', error.response);
            }
        }
    };

    return (
        <Box>
            <Typography variant="h6" gutterBottom>
                Comments
            </Typography>
            <List>
                {comments.map((comment) => (
                    <ListItem key={comment.id}>
                        <ListItemText
                            primary={comment.author?.name || 'Anonymous'}
                            secondary={comment.content}
                        />
                    </ListItem>
                ))}
            </List>
            {user ? (
                <form onSubmit={handleSubmitComment}>
                    <TextField
                        fullWidth
                        variant="outlined"
                        label="Add a comment"
                        value={newComment}
                        onChange={(e) => setNewComment(e.target.value)}
                        margin="normal"
                    />
                    <Button type="submit" variant="contained" color="primary">
                        Post Comment
                    </Button>
                </form>
            ) : (
                <Typography>Please log in to post comments.</Typography>
            )}
        </Box>
    );
};

export default SimpleComments;