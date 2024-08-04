// src/components/CreateGame.jsx
// Version 1.5.0

import React, { useState, useEffect } from 'react';
import { TextField, Button, Box, Typography, CircularProgress, Select, MenuItem, InputLabel, FormControl } from '@mui/material';
import { createGame, getTags } from '../services/api';
import { useNavigate } from 'react-router-dom';
import TagSelector from './TagSelector';

function CreateGame() {
    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [cardImage, setCardImage] = useState(null);
    const [cyoaImages, setCyoaImages] = useState([]);
    const [imgOrLink, setImgOrLink] = useState('img');
    const [iframeUrl, setIframeUrl] = useState('');
    const [tags, setTags] = useState([]);
    const [availableTags, setAvailableTags] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const navigate = useNavigate();

    useEffect(() => {
        const fetchTags = async () => {
            try {
                const tagsData = await getTags();
                setAvailableTags(tagsData.map(tag => ({ id: tag.id, name: tag.attributes.Name })));
            } catch (error) {
                console.error('Error fetching tags:', error);
                setError('Failed to load tags. Please try again.');
            }
        };

        fetchTags();
    }, []);

    const handleCardImageChange = (e) => {
        if (e.target.files[0]) {
            setCardImage(e.target.files[0]);
        }
    };

    const handleCyoaImagesChange = (e) => {
        if (e.target.files) {
            setCyoaImages(Array.from(e.target.files));
        }
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);

        if (!title || !description || !cardImage) {
            setError('Please fill in all required fields and upload a card image.');
            setLoading(false);
            return;
        }

        if (imgOrLink === 'img' && cyoaImages.length === 0) {
            setError('Please upload at least one CYOA page image.');
            setLoading(false);
            return;
        }

        try {
            const formData = new FormData();

            // Prepare the Description field for Rich text (Blocks)
            const descriptionData = [
                {
                    type: 'paragraph',
                    children: [{ type: 'text', text: description }],
                },
            ];

            formData.append('data', JSON.stringify({
                Title: title,
                Description: descriptionData,
                img_or_link: imgOrLink,
                iframe_url: imgOrLink === 'link' ? iframeUrl : undefined,
                tags: tags.map(tag => tag.id)
            }));

            // Append the main card image
            formData.append('files.Image', cardImage);

            // Append CYOA page images if "img" is selected
            if (imgOrLink === 'img') {
                cyoaImages.forEach((image, index) => {
                    formData.append(`files.CYOA_pages`, image);
                });
            }

            console.log('Submitting game data:', Object.fromEntries(formData));
            const result = await createGame(formData);
            console.log('Created game:', result);
            navigate('/');
        } catch (error) {
            console.error('Error creating game:', error);
            if (error.response) {
                console.error('Error response:', error.response.data);
                setError(`Failed to create game. Server response: ${JSON.stringify(error.response.data)}`);
            } else {
                setError('Failed to create game. Please try again.');
            }
        } finally {
            setLoading(false);
        }
    };

    // Handler for updating available tags
    const handleTagsChange = (newTags) => {
        setAvailableTags(newTags);
    };

    return (
        <Box component="form" onSubmit={handleSubmit} sx={{ maxWidth: 600, margin: 'auto', mt: 4 }}>
            <Typography variant="h4" component="h1" gutterBottom>
                Create New Game
            </Typography>
            <TextField
                fullWidth
                label="Title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                margin="normal"
                required
            />
            <TextField
                fullWidth
                label="Description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                margin="normal"
                required
                multiline
                rows={4}
            />
            <FormControl fullWidth margin="normal">
                <InputLabel id="img-or-link-label">Image or Link</InputLabel>
                <Select
                    labelId="img-or-link-label"
                    value={imgOrLink}
                    onChange={(e) => setImgOrLink(e.target.value)}
                    label="Image or Link"
                >
                    <MenuItem value="img">Image</MenuItem>
                    <MenuItem value="link">Link</MenuItem>
                </Select>
            </FormControl>
            {imgOrLink === 'link' && (
                <TextField
                    fullWidth
                    label="iframe URL"
                    value={iframeUrl}
                    onChange={(e) => setIframeUrl(e.target.value)}
                    margin="normal"
                    required
                />
            )}
            <Box sx={{ mt: 2 }}>
                <TagSelector
                    value={tags}
                    onChange={setTags}
                    availableTags={availableTags}
                    onTagsChange={handleTagsChange}
                />
            </Box>
            <Box sx={{ mt: 2 }}>
                <input
                    accept="image/*"
                    id="card-image-upload"
                    type="file"
                    onChange={handleCardImageChange}
                    style={{ display: 'none' }}
                />
                <label htmlFor="card-image-upload">
                    <Button variant="contained" component="span">
                        Upload Card Image
                    </Button>
                </label>
                {cardImage && <Typography sx={{ mt: 1 }}>{cardImage.name}</Typography>}
            </Box>
            {imgOrLink === 'img' && (
                <Box sx={{ mt: 2 }}>
                    <input
                        accept="image/*"
                        id="cyoa-images-upload"
                        type="file"
                        multiple
                        onChange={handleCyoaImagesChange}
                        style={{ display: 'none' }}
                    />
                    <label htmlFor="cyoa-images-upload">
                        <Button variant="contained" component="span">
                            Upload CYOA Page Images
                        </Button>
                    </label>
                    {cyoaImages.length > 0 && (
                        <Typography sx={{ mt: 1 }}>
                            {cyoaImages.length} image(s) selected
                        </Typography>
                    )}
                </Box>
            )}
            <Button
                type="submit"
                variant="contained"
                color="primary"
                sx={{ mt: 3 }}
                disabled={loading}
            >
                {loading ? <CircularProgress size={24} /> : 'Create Game'}
            </Button>
            {error && (
                <Typography color="error" sx={{ mt: 2 }}>
                    {error}
                </Typography>
            )}
        </Box>
    );
}

export default CreateGame;