// src/components/GameCard.tsx
// v3.7
// Added comment count display and updated TypeScript types

import React, { useState, useEffect, useCallback, useMemo, memo } from 'react'
import { Card, CardContent, Typography, Chip, Box, Skeleton, useTheme } from '@mui/material'
import { useNavigate } from 'react-router-dom'
import { getCachedImage, cacheImage, cacheTagCategoryMap, getCachedTagCategoryMap } from '../services/cacheService'
import FavoriteIcon from '@mui/icons-material/Favorite'
import CommentIcon from '@mui/icons-material/Comment'

// Design variables
const CARD_ASPECT_RATIO = '133.33%' // 3:4 aspect ratio
const TITLE_FONT_SIZE = '1.5rem'
const DESCRIPTION_TOP = '60%'
const TAG_SECTION_HEIGHT = '80px'
const TAG_DISPLAY_LIMIT = 12
const OVERLAY_OPACITY = 0.5

// Spacing variables
const CARD_PADDING = 16 // Default padding of CardContent
const TITLE_MARGIN_BOTTOM = 8
const TAGS_MARGIN_BOTTOM = 8
const BOTTOM_INFO_MARGIN_TOP = 8
const BOTTOM_INFO_MARGIN_BOTTOM = 0

const MAX_CACHE_SIZE = 100 * 1024 * 1024
const MAX_CACHE_ITEMS = 500

const CATEGORY_ORDER = [
    'Rating',
    'Interactivity',
    'POV',
    'Player Sexual Role',
    'Playtime',
    'Status',
    'Genre',
    'Setting',
    'Tone',
    'Extra',
    'Kinks',
]

const CATEGORY_COLORS = {
    Rating: 'rgba(0, 0, 0, 0.4)',
    Interactivity: 'rgba(0, 0, 0, 0.4)',
    POV: 'rgba(0, 0, 0, 0.4)',
    'Player Sexual Role': 'rgba(0, 0, 0, 0.4)',
    Playtime: 'rgba(255, 140, 0, 0.4)',
    Status: 'rgba(0, 0, 0, 0.4)',
    Genre: 'rgba(138, 43, 226, 0.4)',
    Setting: 'rgba(0, 0, 0, 0.4)',
    Tone: 'rgba(0, 0, 0, 0.4)',
    Extra: 'rgba(0, 0, 0, 0.4)',
    Kinks: 'rgba(255, 69, 0, 0.4)',
}

interface Tag {
    id: number
    attributes: {
        Name: string
    }
}

interface Author {
    id: number
    name: string
}

interface Game {
    id: string
    title: string
    description: string | { children: { type: string; text: string }[] }
    image: string | null
    tags: Tag[]
    authors: Author[]
    Upvotes: any[]
    commentCount: number
}

interface TagCategory {
    attributes: {
        Name: string
        tags: {
            data: Tag[]
        }
    }
}

interface GameCardProps {
    game: Game
    tagCategories: TagCategory[]
}

const GameCard: React.FC<GameCardProps> = memo(({ game, tagCategories }) => {
    const theme = useTheme()
    const navigate = useNavigate()
    const [imageUrl, setImageUrl] = useState<string | null>(null)
    const [isLoading, setIsLoading] = useState(true)

    const loadImage = useCallback(async () => {
        if (game.image) {
            try {
                const cachedImage = await getCachedImage(game.image)
                if (cachedImage) {
                    setImageUrl(cachedImage)
                    setIsLoading(false)
                    return
                }

                const response = await fetch(game.image)
                const blob = await response.blob()
                if (blob.size <= MAX_CACHE_SIZE / MAX_CACHE_ITEMS) {
                    const reader = new FileReader()
                    reader.onloadend = () => {
                        const base64data = reader.result as string
                        cacheImage(game.image!, base64data)
                        setImageUrl(base64data)
                        setIsLoading(false)
                    }
                    reader.readAsDataURL(blob)
                } else {
                    setImageUrl(game.image)
                    setIsLoading(false)
                }
            } catch (error) {
                console.error('Error loading image:', error)
                setImageUrl('/img/placeholder.jpg')
                setIsLoading(false)
            }
        } else {
            setImageUrl('/img/placeholder.jpg')
            setIsLoading(false)
        }
    }, [game.image])

    useEffect(() => {
        loadImage()
    }, [loadImage])

    const getDescription = useCallback((description: string | { children: { type: string; text: string }[] }) => {
        if (typeof description === 'string') {
            return description
        }
        if (Array.isArray(description?.children)) {
            const textNode = description.children.find((child) => child.type === 'text')
            return textNode?.text || 'No description available'
        }
        return 'No description available'
    }, [])

    const sortedTags = useMemo(() => {
        if (!game.tags || !tagCategories) {
            return []
        }

        let tagCategoryMap = getCachedTagCategoryMap()

        if (!tagCategoryMap) {
            tagCategoryMap = new Map()
            tagCategories.forEach((category) => {
                category.attributes.tags.data.forEach((tag) => {
                    tagCategoryMap.set(tag.id, category.attributes.Name)
                })
            })
            cacheTagCategoryMap(Array.from(tagCategoryMap.entries()))
        } else {
            tagCategoryMap = new Map(tagCategoryMap)
        }

        const sortedAndFilteredTags = CATEGORY_ORDER.flatMap((categoryName) => {
            return game.tags.filter((tag) => tagCategoryMap.get(tag.id) === categoryName)
        })

        return sortedAndFilteredTags.slice(0, TAG_DISPLAY_LIMIT)
    }, [game.tags, tagCategories])

    const description = getDescription(game.description)
    const gameUpvotes = game.Upvotes || []
    const gameUpvoteCount = gameUpvotes.length

    const handleCardClick = useCallback(() => {
        navigate(`/game/${game.id}`)
    }, [navigate, game.id])

    return (
        <Card
            onClick={handleCardClick}
            sx={{
                cursor: 'pointer',
                transition: '0.3s',
                '&:hover': { transform: 'scale(1.03)' },
                position: 'relative',
                overflow: 'hidden',
                backgroundColor: theme.palette.background.paper,
                paddingTop: CARD_ASPECT_RATIO,
                boxShadow: theme.shadows[3],
            }}
        >
            {isLoading ? (
                <Skeleton
                    variant="rectangular"
                    sx={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        height: '100%',
                        backgroundColor: 'rgba(255, 255, 255, 0.1)',
                    }}
                />
            ) : (
                <Box
                    sx={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        height: '100%',
                        backgroundImage: `url(${imageUrl})`,
                        backgroundSize: 'cover',
                        backgroundPosition: 'center',
                        '&::after': {
                            content: '""',
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            width: '100%',
                            height: '100%',
                            backgroundColor: `rgba(0, 0, 0, ${OVERLAY_OPACITY})`,
                        },
                    }}
                />
            )}
            <CardContent
                sx={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: '100%',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'space-between',
                    p: `${CARD_PADDING}px`,
                    boxSizing: 'border-box',
                }}
            >
                <Typography
                    variant="h3"
                    component="div"
                    align="center"
                    sx={{
                        fontWeight: 'bold',
                        fontSize: TITLE_FONT_SIZE,
                        ...theme.custom.cardTitle,
                        mb: `${TITLE_MARGIN_BOTTOM}px`,
                    }}
                >
                    {game.title || 'Untitled'}
                </Typography>

                <Box sx={{ position: 'absolute', top: DESCRIPTION_TOP, left: CARD_PADDING, right: CARD_PADDING }}>
                    <Typography
                        variant="body2"
                        sx={{
                            display: '-webkit-box',
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: 'vertical',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            ...theme.custom.cardText,
                        }}
                    >
                        {description}
                    </Typography>
                </Box>

                <Box sx={{ mt: 'auto' }}>
                    <Box
                        sx={{
                            display: 'flex',
                            flexWrap: 'wrap',
                            gap: 0.5,
                            mb: `${TAGS_MARGIN_BOTTOM}px`,
                            height: TAG_SECTION_HEIGHT,
                            overflow: 'hidden',
                        }}
                    >
                        {sortedTags.map((tag, index) => {
                            const category = tagCategories.find((cat) =>
                                cat.attributes.tags.data.some((t) => t.id === tag.id),
                            )?.attributes.Name
                            return (
                                <Chip
                                    key={index}
                                    label={tag.attributes.Name}
                                    size="small"
                                    sx={{
                                        fontSize: '0.7rem',
                                        backgroundColor: `${CATEGORY_COLORS[category as keyof typeof CATEGORY_COLORS] || 'transparent'}`,
                                        color: theme.palette.text.primary,
                                        textShadow: '1px 1px 2px rgba(0,0,0,0.5)',
                                    }}
                                />
                            )
                        })}
                    </Box>

                    <Box
                        sx={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            mt: `${BOTTOM_INFO_MARGIN_TOP}px`,
                            mb: `${BOTTOM_INFO_MARGIN_BOTTOM}px`,
                        }}
                    >
                        <Typography
                            variant="body2"
                            sx={{
                                ...theme.custom.cardText,
                                textShadow: '1px 1px 3px rgba(3, 3, 3, 1)',
                            }}
                        >
                            {game.authors && game.authors.length > 0 ? game.authors[0].name : 'Anonymous'}
                        </Typography>
                        <Box
                            sx={{
                                display: 'flex',
                                alignItems: 'center',
                            }}
                        >
                            <CommentIcon sx={{ color: theme.palette.secondary.main, fontSize: '1rem', mr: 0.5 }} />
                            <Typography
                                variant="body2"
                                sx={{ color: 'white', fontWeight: 'bold', textShadow: '1px 1px 2px rgba(3,3,3,1)', mr: 1 }}
                            >
                                {game.commentCount}
                            </Typography>
                            <FavoriteIcon sx={{ color: theme.palette.secondary.main, fontSize: '1rem', mr: 0.5 }} />
                            <Typography
                                variant="body2"
                                sx={{ color: 'white', fontWeight: 'bold', textShadow: '1px 1px 2px rgba(3,3,3,1)' }}
                            >
                                {gameUpvoteCount}
                            </Typography>
                            
                        </Box>
                    </Box>
                </Box>
            </CardContent>
        </Card>
    )
})

GameCard.displayName = 'GameCard'

export default GameCard
