// src/components/Add/CreateGameForm.tsx
// Version 1.0
// New component: Main form for creating a game

import React, { useState, useEffect, FormEvent } from 'react';
import {
    Box,
    Typography,
    Button,
    CircularProgress,
    Alert,
} from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { createGame, getAuthors, getTagCategories } from '../../services/api';
import axios from 'axios';
import GameBasicInfo from './GameBasicInfo';
import AuthorSelector from './AuthorSelector';
import GameTypeSelector from './GameTypeSelector';
import TagSelector from './TagSelector';
import ImageUploader from './ImageUploader';


interface Author {
    id: number;
    name: string;
}

interface TagCategory {
    id: number;
    attributes: {
        Name: string;
        MinTags: number;
        tags: {
            data: Array<{ id: number }>;
        };
    };
}

function CreateGameForm(): JSX.Element {
    const [title, setTitle] = useState<string>('');
    const [description, setDescription] = useState<string>('');
    const [cardImage, setCardImage] = useState<File | null>(null);
    const [cyoaImages, setCyoaImages] = useState<File[]>([]);
    const [imgOrLink, setImgOrLink] = useState<'img' | 'link'>('img');
    const [iframeUrl, setIframeUrl] = useState<string>('');
    const [authors, setAuthors] = useState<Author[]>([]);
    const [availableAuthors, setAvailableAuthors] = useState<Author[]>([]);
    const [loading, setLoading] = useState<boolean>(false);
    const [error, setError] = useState<string | null>(null);
    const [selectedTags, setSelectedTags] = useState<number[]>([]);
    const [tagCategories, setTagCategories] = useState<TagCategory[]>([]);
    const [initialDataLoading, setInitialDataLoading] = useState<boolean>(true);

    const navigate = useNavigate();

    useEffect(() => {
        const fetchInitialData = async () => {
            try {
                const [authorsData, categoriesData] = await Promise.all([getAuthors(), getTagCategories()]);
                setAvailableAuthors(
                    authorsData.map((author: any) => ({ id: author.id, name: author.attributes.Name }))
                );
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

    const validateForm = (): string[] => {
        const errors: string[] = [];
        if (!title.trim()) errors.push('Title is required.');
        if (!description.trim()) errors.push('Description is required.');
        if (!cardImage) errors.push('Please upload a card image.');
        if (imgOrLink === 'img' && cyoaImages.length === 0) errors.push('Please upload at least one CYOA page image.');
        if (imgOrLink === 'link' && !iframeUrl.trim()) errors.push('Please provide an iframe URL.');
        
        tagCategories.forEach((category) => {
            const categoryTags = selectedTags.filter((tagId) =>
                category.attributes.tags.data.some((tag) => tag.id === tagId)
            );
            if (categoryTags.length < category.attributes.MinTags) {
                errors.push(`${category.attributes.Name} requires at least ${category.attributes.MinTags} tag(s)`);
            }
        });

        return errors;
    };

    const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        setLoading(true);
        setError(null);

        const formErrors = validateForm();
        if (formErrors.length > 0) {
            setError(formErrors.join('\n'));
            setLoading(false);
            return;
        }

        try {
            const formData = new FormData();

            const descriptionData = [
                {
                    type: 'paragraph',
                    children: [{ type: 'text', text: description }],
                },
            ];

            formData.append(
                'data',
                JSON.stringify({
                    Title: title,
                    Description: descriptionData,
                    img_or_link: imgOrLink,
                    iframe_url: imgOrLink === 'link' ? iframeUrl : undefined,
                    authors: authors.map((author) => author.id),
                    tags: selectedTags,
                })
            );

            formData.append('files.Image', cardImage as File);

            if (imgOrLink === 'img') {
                for (let i = 0; i < cyoaImages.length; i++) {
                    formData.append('files.CYOA_pages', cyoaImages[i], `CYOA_page_${i + 1}`);
                    await new Promise((resolve) => setTimeout(resolve, 500));
                }
            }

            console.log('Submitting game data:', Object.fromEntries(formData));
            const result = await createGame(formData);
            console.log('Created game:', result);
            navigate('/');
        } catch (error) {
            console.error('Error creating game:', error);
            if (axios.isAxiosError(error) && error.response) {
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
                Add a New Cyoa!
            </Typography>
            
            <GameBasicInfo
                title={title}
                setTitle={setTitle}
                description={description}
                setDescription={setDescription}
            />

            <GameTypeSelector
                imgOrLink={imgOrLink}
                setImgOrLink={setImgOrLink}
                iframeUrl={iframeUrl}
                setIframeUrl={setIframeUrl}
            />

            <Box sx={{ mt: 2 }}>
                <AuthorSelector value={authors} onChange={setAuthors} availableAuthors={availableAuthors} />
            </Box>

            <TagSelector
                selectedTags={selectedTags}
                onTagsChange={setSelectedTags} 
            />

            <ImageUploader
                cardImage={cardImage}
                setCardImage={setCardImage}
                cyoaImages={cyoaImages}
                setCyoaImages={setCyoaImages}
                imgOrLink={imgOrLink}
            />

            <Button type="submit" variant="contained" color="primary" sx={{ mt: 3 }} disabled={loading}>
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

export default CreateGameForm;