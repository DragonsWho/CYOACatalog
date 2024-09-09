// src/components/Add/TagSelector.tsx
// Version 1.9.3
// Changes: Updated to use new Chip variants from theme

import React, { useState, useEffect, useMemo } from 'react';
import { Box, Chip, TextField, Typography, CircularProgress, Tooltip } from '@mui/material';
import { pb } from '../../services/api';

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
];

const TAG_GROUPS: { [key: string]: number[][] } = {
  Rating: [[4]],
  Playtime: [[4]],
  Interactivity: [[4]],
  Status: [[3]],
  'Player Sexual Role': [[6]],
  Tone: [[7]],
  Kinks: [[7], [6], [5], [3], [4], [5], [5], [4], [6], [7], [3], [6], [6], [5], [5], [6], [99]],
};
const TOOLTIP_DELAY = 1000; // 1 second delay for tooltips
const CHIP_HEIGHT = '24px';
const CHIP_FONT_SIZE = '0.8125rem';
const CHIP_PADDING = '0 8px';
const CHIP_BORDER_RADIUS = '4px';
const GAP = 0.75; // Gap between chips
const CATEGORY_TITLE_MARGIN_BOTTOM = 0;
const CATEGORY_TITLE_FONT_WEIGHT = '500';
const SECTION_GAP = 0.5; // Gap between sections

interface TagCategory {
  id: string;
  name: string;
  description: string;
  min_tags: number;
  max_tags: number;
  allow_new_tags: boolean;
  tags: { id: string }[];
}

interface Category {
  id: string;
  name: string;
  description: string;
  min_tags: number;
  max_tags: number;
  allow_new_tags: boolean;
  tags: {
    id: string;
    name: string;
    games: string[];
    description: string;
    tag_category: string;
  }[];
}

interface TagSelectorProps {
  selectedTags: string[];
  onTagsChange: (tags: string[]) => void;
  onLoad: () => void;
}

interface DelayedTooltipProps {
  title: string;
  children: React.ReactElement;
  placement?: 'bottom' | 'bottom-start';
}

const DelayedTooltip: React.FC<DelayedTooltipProps> = ({ title, children, placement = 'bottom' }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [timer, setTimer] = useState<number | null>(null);

  const handleMouseEnter = () => {
    const newTimer = setTimeout(() => {
      setIsOpen(true);
    }, TOOLTIP_DELAY);
    setTimer(newTimer as unknown as number);
  };

  const handleMouseLeave = () => {
    if (timer) {
      clearTimeout(timer);
    }
    setIsOpen(false);
  };

  return (
    <Tooltip title={title} open={isOpen} onClose={handleMouseLeave} placement={placement} arrow>
      <span onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave}>
        {children}
      </span>
    </Tooltip>
  );
};

const TagSelector: React.FC<TagSelectorProps> = ({ selectedTags, onTagsChange, onLoad }) => {
  const [tagCategories, setTagCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchTagData = async () => {
      try {
        const [tagsData, categoriesData] = await Promise.all([
          pb.collection('tags').getFullList<Category['tags'][0]>(),
          pb.collection('tag_categories').getFullList<TagCategory>({ expand: 'tags' }),
        ]);
        const categoriesWithTags = categoriesData.map((category) => ({
          ...category,
          tags: tagsData.filter((tag) => tag.tag_category === category.id),
        }));
        setTagCategories(categoriesWithTags);
        onLoad();
      } catch (error) {
        console.error('Error fetching tag data:', error);
        setError('Failed to load tags. Please try again.');
      } finally {
        setLoading(false);
      }
    };

    fetchTagData();
  }, [onLoad]);

  const sortedCategories = useMemo(() => {
    return tagCategories.sort((a, b) => {
      const indexA = CATEGORY_ORDER.indexOf(a.name);
      const indexB = CATEGORY_ORDER.indexOf(b.name);
      if (indexA === -1 && indexB === -1) return 0;
      if (indexA === -1) return 1;
      if (indexB === -1) return -1;
      return indexA - indexB;
    });
  }, [tagCategories]);

  const handleTagToggle = (tagId: string, categoryId: string) => {
    const category = tagCategories.find((cat) => cat.id === categoryId);
    if (!category) return;

    const categoryTags = selectedTags.filter((id) => category.tags.some((tag) => tag.id === id));

    if (selectedTags.includes(tagId)) {
      onTagsChange(selectedTags.filter((id) => id !== tagId));
    } else {
      if (categoryTags.length < category.max_tags) {
        onTagsChange([...selectedTags, tagId]);
      }
    }
  };

  const handleAddTag = (categoryId: string, newTagName: string) => {
    console.log(`Add new tag "${newTagName}" to category ${categoryId}`);
  };

  const renderTagGroups = (category: Category, groupConfig: number[][] | undefined) => {
    if (!groupConfig || groupConfig.length === 0) {
      groupConfig = [[category.tags.length]]; // Default to all tags in one row
    }

    return groupConfig.map((row, rowIndex) => (
      <Box
        key={rowIndex}
        sx={{ display: 'flex', flexWrap: 'wrap', gap: GAP, mb: rowIndex < groupConfig!.length - 1 ? GAP : 0 }}
      >
        {row.map((groupSize, groupIndex) => {
          const startIndex =
            groupConfig!
              .slice(0, rowIndex)
              .flat()
              .reduce((sum, size) => sum + size, 0) + row.slice(0, groupIndex).reduce((sum, size) => sum + size, 0);
          const groupTags = category.tags.slice(startIndex, startIndex + groupSize);

          return groupTags.map((tag) => {
            const isSelected = selectedTags.includes(tag.id);
            const isDisabled =
              !isSelected &&
              selectedTags.filter((id) => category.tags.some((catTag) => catTag.id === id)).length >= category.max_tags;

            return (
              <DelayedTooltip key={tag.id} title={tag.description || 'No description available'}>
                <Chip
                  label={tag.name}
                  onClick={() => handleTagToggle(tag.id, category.id)}
                  // @ts-expect-error - MuiChip variant prop is not typed
                  variant={isSelected ? 'selected' : isDisabled ? 'inactive' : undefined}
                  size="small"
                  sx={{
                    height: CHIP_HEIGHT,
                    borderRadius: CHIP_BORDER_RADIUS,
                    '& .MuiChip-label': {
                      fontSize: CHIP_FONT_SIZE,
                      padding: CHIP_PADDING,
                    },
                  }}
                  disabled={isDisabled}
                />
              </DelayedTooltip>
            );
          });
        })}
      </Box>
    ));
  };

  const isMinimumTagsSelected = (category: Category) => {
    const selectedTagsInCategory = selectedTags.filter((id) => category.tags.some((tag) => tag.id === id)).length;
    return selectedTagsInCategory >= category.min_tags;
  };

  if (loading) return <CircularProgress size={24} />;
  if (error)
    return (
      <Typography color="error" variant="body2">
        {error}
      </Typography>
    );

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: SECTION_GAP }}>
      {sortedCategories.map((category) => {
        const canAddMore =
          selectedTags.filter((id) => category.tags.some((tag) => tag.id === id)).length < category.max_tags;

        return (
          <Box key={category.id}>
            <DelayedTooltip title={category.description || 'No description available'} placement="bottom-start">
              <Typography
                variant="subtitle1"
                sx={{
                  mb: CATEGORY_TITLE_MARGIN_BOTTOM,
                  fontWeight: CATEGORY_TITLE_FONT_WEIGHT,
                  display: 'inline-flex',
                  alignItems: 'center',
                }}
              >
                {category.name}
                {!isMinimumTagsSelected(category) && <span style={{ color: 'red', marginLeft: '4px' }}>*</span>}
              </Typography>
            </DelayedTooltip>
            {renderTagGroups(category, TAG_GROUPS[category.name])}
            {category.allow_new_tags && canAddMore && (
              <TextField
                size="small"
                placeholder="Add a tag..."
                onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
                  if (e.key === 'Enter') {
                    handleAddTag(category.id, (e.target as HTMLInputElement).value);
                    (e.target as HTMLInputElement).value = '';
                  }
                }}
                sx={{
                  mt: GAP,
                  '& .MuiInputBase-root': {
                    height: CHIP_HEIGHT,
                    fontSize: CHIP_FONT_SIZE,
                  },
                }}
              />
            )}
          </Box>
        );
      })}
    </Box>
  );
};

export default TagSelector;
