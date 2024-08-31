// src/components/CyoaPage/TagDisplay.tsx
// v2.2
// Converted to TypeScript

import React from 'react'
import { Box, Chip, Typography } from '@mui/material'
import { useTheme } from '@mui/material/styles'

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
    'Narrative Structure',
    'Power Level',
    'Visual Style',
    'Language',
    'Kinks',
]

const CHIP_HEIGHT = '24px'
const CHIP_FONT_SIZE = '0.8125rem'
const CHIP_PADDING = '0 8px'
const CHIP_BORDER_RADIUS = '4px'
const GAP = 0.75 // Gap between chips
const CATEGORY_FONT_WEIGHT = '500'
const SECTION_GAP = 0.5 // Gap between sections

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

interface TagDisplayProps {
    tags: Tag[]
    chipProps?: {
        size?: 'small' | 'medium'
        sx?: React.CSSProperties
    }
}

const TagDisplay: React.FC<TagDisplayProps> = ({ tags, chipProps = {} }) => {
    const theme = useTheme()

    if (!tags || tags.length === 0) {
        return null
    }

    // Group tags by their category
    const groupedTags = tags.reduce<Record<string, Tag[]>>((acc, tag) => {
        if (!tag || !tag.attributes) return acc

        const categoryData = tag.attributes.tag_category && tag.attributes.tag_category.data
        const categoryName = categoryData && categoryData.attributes ? categoryData.attributes.Name : 'Uncategorized'

        if (!acc[categoryName]) {
            acc[categoryName] = []
        }
        acc[categoryName].push(tag)
        return acc
    }, {})

    // Sort categories based on CATEGORY_ORDER
    const sortedCategories = Object.keys(groupedTags).sort((a, b) => {
        const indexA = CATEGORY_ORDER.indexOf(a)
        const indexB = CATEGORY_ORDER.indexOf(b)
        if (indexA === -1 && indexB === -1) return 0
        if (indexA === -1) return 1
        if (indexB === -1) return -1
        return indexA - indexB
    })

    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: SECTION_GAP }}>
            {sortedCategories.map((category) => (
                <Box key={category} sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: GAP }}>
                    <Typography
                        variant="subtitle2"
                        sx={{
                            fontWeight: CATEGORY_FONT_WEIGHT,
                            display: 'inline-flex',
                            alignItems: 'center',
                            mr: 1,
                            minWidth: 'max-content',
                            color: theme.palette.text.primary,
                        }}
                    >
                        {category}:
                    </Typography>
                    {groupedTags[category].map((tag) => (
                        <Chip
                            key={tag.id}
                            label={tag.attributes.Name}
                            size="small"
                            sx={{
                                height: CHIP_HEIGHT,
                                borderRadius: CHIP_BORDER_RADIUS,
                                '& .MuiChip-label': {
                                    fontSize: CHIP_FONT_SIZE,
                                    padding: CHIP_PADDING,
                                },
                                ...chipProps.sx,
                            }}
                            {...chipProps}
                        />
                    ))}
                </Box>
            ))}
        </Box>
    )
}

export default TagDisplay
