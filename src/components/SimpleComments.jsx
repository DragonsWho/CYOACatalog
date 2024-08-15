// src/components/SimpleComments.jsx
// v1.0
// New component for handling comments

import React, { useState, useEffect } from 'react';
import { Box, TextField, Button, List, ListItem, ListItemText, Typography } from '@mui/material';
import { fetchComments, postComment } from '../services/api';

const SimpleComments = ({ gameId }) => {
    const [comments, setComments] = useState([]);
    const [newComment, setNewComment] = useState('');

    useEffect(() => {
        loadComments();
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
            const author = {
                id: "207ccfdc-94ba-45eb-979c-790f6f49c392",
                name: "Anonymous User",
                email: "anonymous@example.com",
            };
            await postComment(gameId, newComment, author);
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
                            primary={comment.author.name}
                            secondary={comment.content}
                        />
                    </ListItem>
                ))}
            </List>
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
        </Box>
    );
};

export default SimpleComments;