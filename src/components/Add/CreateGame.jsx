// src/components/Add/CreateGame.jsx
// Version 1.8.0
// Updated to use CyoaImageUploader component

import React, { useState, useEffect } from 'react';
import { TextField, Button, Box, Typography, CircularProgress, Select, MenuItem, InputLabel, FormControl, Alert } from '@mui/material';
import { createGame, getAuthors, getTagCategories } from '../../services/api';
import { useNavigate } from 'react-router-dom';
import AuthorSelector from './AuthorSelector';
import TagSelector from './TagSelector';
import CyoaImageUploader from './CyoaImageUploader';

/**
 * CreateGame component for creating a new game entry
 * @returns {JSX.Element} The CreateGame form
 */
function CreateGame() {
    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [cardImage, setCardImage] = useState(null);
    const [cyoaImages, setCyoaImages] = useState([]);
    const [imgOrLink, setImgOrLink] = useState('img');
    const [iframeUrl, setIframeUrl] = useState('');
    const [authors, setAuthors] = useState([]);
    const [availableAuthors, setAvailableAuthors] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [selectedTags, setSelectedTags] = useState([]);
    const [tagsLoaded, setTagsLoaded] = useState(false);
    const [tagCategories, setTagCategories] = useState([]);
    const [initialDataLoading, setInitialDataLoading] = useState(true);

    const navigate = useNavigate();

    useEffect(() => {
        const fetchInitialData = async () => {
            try {
                const [authorsData, categoriesData] = await Promise.all([
                    getAuthors(),
                    getTagCategories()
                ]);
                setAvailableAuthors(authorsData.map(author => ({ id: author.id, name: author.attributes.Name })));
                setTagCategories(categoriesData);
            } catch (error) {
                console.error('Error fetching initial data:', error);
                setError('Failed to load necessary data. Please refresh the page and try again.');
            } finally {
                setInitialDataLoading(false);
            }
        };

        fetchInitialData();
    }, []);

    const handleCardImageChange = (e) => {
        if (e.target.files[0]) {
            setCardImage(e.target.files[0]);
        }
    };

    const handleCyoaImagesChange = (newImages) => {
        setCyoaImages(newImages);
    };

    /**
     * Validates the selected tags against the minimum required for each category
     * @returns {string[]} Array of error messages, empty if no errors
     */
    const validateTags = () => {
        const errors = [];
        tagCategories.forEach(category => {
            const categoryTags = selectedTags.filter(tagId =>
                category.attributes.tags.data.some(tag => tag.id === tagId)
            );
            if (categoryTags.length < category.attributes.MinTags) {
                errors.push(`${category.attributes.Name} requires at least ${category.attributes.MinTags} tag(s)`);
            }
        });
        return errors;
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);

        // Form validation
        if (!title.trim()) {
            setError('Title is required.');
            setLoading(false);
            return;
        }

        if (!description.trim()) {
            setError('Description is required.');
            setLoading(false);
            return;
        }

        if (!cardImage) {
            setError('Please upload a card image.');
            setLoading(false);
            return;
        }

        if (imgOrLink === 'img' && cyoaImages.length === 0) {
            setError('Please upload at least one CYOA page image.');
            setLoading(false);
            return;
        }

        if (imgOrLink === 'link' && !iframeUrl.trim()) {
            setError('Please provide an iframe URL.');
            setLoading(false);
            return;
        }

        const tagErrors = validateTags();
        if (tagErrors.length > 0) {
            setError(`Tag selection errors:\n${tagErrors.join('\n')}`);
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
                authors: authors.map(author => author.id),
                tags: selectedTags
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

    if (initialDataLoading) {
        return <CircularProgress />;
    }

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
                <AuthorSelector
                    value={authors}
                    onChange={setAuthors}
                    availableAuthors={availableAuthors}
                />
            </Box>

            <Box sx={{ mt: 2 }}>
                <Typography variant="h6">Select Tags</Typography>
                <TagSelector
                    selectedTags={selectedTags}
                    onTagsChange={setSelectedTags}
                    onLoad={() => setTagsLoaded(true)}
                    tagCategories={tagCategories}
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
                    <CyoaImageUploader onImagesChange={handleCyoaImagesChange} />
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
                <Alert severity="error" sx={{ mt: 2 }}>
                    {error}
                </Alert>
            )}
        </Box>
    );
}

export default CreateGame;