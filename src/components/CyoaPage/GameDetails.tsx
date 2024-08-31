// src/components/CyoaPage/GameDetails.tsx
// v4.1
// Fixed TypeScript errors and improved type safety

import React, { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { Container, Typography, Box, CircularProgress, Grid, Paper, Theme } from '@mui/material'
import { useTheme } from '@mui/material/styles'
import TagDisplay from './TagDisplay'
import GameContent from './GameContent'
import SimpleComments from './SimpleComments'
import GameAdditionalInfo from './GameAdditionalInfo'

const API_URL = process.env.REACT_APP_API_URL || 'https://api.cyoa.cafe'

interface Author {
    attributes: {
        Name: string
    }
}

interface Tag {
    id: number
    attributes: {
        Name: string
        tag_category: {
            data: {
                attributes: {
                    Name: string
                }
            }
        }
    }
}

interface Image {
    data: {
        attributes: {
            url: string
        }
    }
}

interface GameAttributes {
    Title: string
    Description: Array<{ children: Array<{ text: string }> }>
    authors: { data: Author[] }
    tags: { data: Tag[] }
    Image: Image
    CYOA_pages: { data: any[] }
    Upvotes: string[]
    img_or_link: 'img' | 'link'
    iframe_url?: string
}

interface Game {
    id: string
    attributes: GameAttributes
}

interface CustomTheme extends Theme {
    custom?: {
        borderRadius?: string
        boxShadow?: string
        comments?: {
            backgroundColor?: string
            borderRadius?: string
        }
    }
}

function GameDetails() {
    const [game, setGame] = useState<Game | null>(null)
    const [loading, setLoading] = useState<boolean>(true)
    const [error, setError] = useState<string | null>(null)
    const [expanded, setExpanded] = useState<boolean>(false)
    const { id } = useParams<{ id: string }>()
    const theme = useTheme<CustomTheme>()

    useEffect(() => {
        const fetchGameDetails = async () => {
            try {
                const response = await fetch(
                    `${API_URL}/api/games/${id}?populate=*,tags.tag_category,authors,Image,CYOA_pages`,
                )
                if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`)
                const data = await response.json()
                setGame(data.data)
            } catch (error) {
                console.error('Error fetching game details:', error)
                setError((error as Error).message)
            } finally {
                setLoading(false)
            }
        }

        fetchGameDetails()
    }, [id])

    if (loading) return <CircularProgress />
    if (error) return <Typography color="error">Error: {error}</Typography>
    if (!game) return <Typography>Game not found</Typography>

    const { attributes } = game

    const handleExpand = () => {
        setExpanded(!expanded)
    }

    return (
        <Container maxWidth="lg" disableGutters>
            <Paper
                elevation={3}
                sx={{
                    p: 2,
                    mb: 0,
                    bgcolor: theme.palette.background.paper,
                    color: theme.palette.common.white,
                }}
            >
                <Box
                    sx={{
                        mb: 1,
                        display: 'flex',
                        justifyContent: 'center',
                        alignItems: 'flex-end',
                    }}
                >
                    <Typography variant="h4" component="h1" sx={{ mr: 1, color: theme.palette.text.primary }}>
                        {attributes.Title || 'Untitled Game'}
                    </Typography>
                    {attributes.authors?.data?.length > 0 && (
                        <Typography variant="subtitle1" sx={{ mb: '0.05em', color: theme.palette.text.primary }}>
                            by {attributes.authors.data.map((author) => author.attributes.Name).join(', ')}
                        </Typography>
                    )}
                </Box>

                <Grid container spacing={3}>
                    {/* Left Column - Image */}
                    <Grid item xs={12} md={6}>
                        {attributes.Image?.data && (
                            <Box
                                sx={{
                                    width: '100%',
                                    height: '100%',
                                    display: 'flex',
                                    justifyContent: 'center',
                                    alignItems: 'center',
                                }}
                            >
                                <img
                                    src={`${API_URL}${attributes.Image.data.attributes.url}`}
                                    alt={attributes.Title}
                                    style={{
                                        maxWidth: '60%',
                                        height: 'auto',
                                        objectFit: 'contain',
                                    }}
                                />
                            </Box>
                        )}
                    </Grid>

                    {/* Right Column - Game Info */}
                    <Grid item xs={12} md={6}>
                        {attributes.tags?.data?.length > 0 && (
                            <Box>
                                <TagDisplay
                                    tags={attributes.tags.data}
                                    chipProps={{
                                        size: 'small',
                                        sx: {
                                            bgcolor: theme.palette.grey[800],
                                            color: theme.palette.text.primary,
                                            '&:hover': {
                                                bgcolor: theme.palette.grey[700],
                                            },
                                        },
                                    }}
                                />
                            </Box>
                        )}

                        <GameAdditionalInfo
                            gameId={id}
                            upvotes={attributes.Upvotes}
                            expanded={expanded}
                            onExpand={handleExpand}
                        />
                    </Grid>
                </Grid>

                <Box sx={{ mt: 1 }}>
                    <Typography variant="h6" gutterBottom textAlign="center" sx={{ color: theme.palette.text.primary }}>
                        Description
                    </Typography>
                    <Typography variant="body1" sx={{ px: 12, color: theme.palette.text.primary }}>
                        {attributes.Description?.map((block, index) => (
                            <React.Fragment key={index}>
                                {block.children.map((child, childIndex) => (
                                    <span key={childIndex}>{child.text}</span>
                                ))}
                            </React.Fragment>
                        ))}
                    </Typography>
                </Box>
            </Paper>

            <Box
                sx={{
                    mb: 3,
                    mt: 3,
                    borderRadius: theme.custom?.borderRadius,
                    boxShadow: theme.custom?.boxShadow,
                    overflow: expanded ? 'visible' : 'hidden',
                    transition: 'all 0.3s ease',
                }}
            >
                <GameContent attributes={attributes} expanded={expanded} onExpand={handleExpand} />
            </Box>

            <Box sx={{}}>
                <SimpleComments gameId={id} />
            </Box>
        </Container>
    )
}

export default GameDetails
