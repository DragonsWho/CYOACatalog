// src/components/Add/TagSelector.tsx
// Version 1.9.6
// Changes: Added null check for onLoad function and improved error handling

import React, { useState, useEffect, useMemo, memo } from 'react';
import { Box, Chip, TextField, Typography, CircularProgress, Tooltip } from '@mui/material';
import { tagCategoriesCollection, TagCategory } from '../../pocketbase/pocketbase';

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

function DelayedTooltip({
  title,
  children,
  placement = 'bottom',
}: {
  title: string;
  children: React.ReactElement;
  placement?: 'bottom' | 'bottom-start';
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [timer, setTimer] = useState<NodeJS.Timeout | null>(null);

  function handleMouseEnter() {
    const newTimer = setTimeout(() => {
      setIsOpen(true);
    }, TOOLTIP_DELAY);
    setTimer(newTimer);
  }

  function handleMouseLeave() {
    if (timer) {
      clearTimeout(timer);
    }
    setIsOpen(false);
  }

  return (
    <Tooltip title={title} open={isOpen} onClose={handleMouseLeave} placement={placement} arrow>
      <span onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave}>
        {children}
      </span>
    </Tooltip>
  );
}

// memoize this as it was a major performance issue
const TagSelector = memo(function TagSelector({
  selectedTags,
  onTagsChange,
  onLoad,
}: {
  selectedTags: string[];
  onTagsChange: (tags: string[]) => void;
  onLoad?: () => void;
}) {
  const [tagCategories, setTagCategories] = useState<TagCategory[]>([]);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    (async () => {
      const categories = await tagCategoriesCollection.getFullList({ expand: 'tags' });
      setTagCategories(categories);
      onLoad?.();
      setLoading(false);
    })();
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

  function handleTagToggle(tagID: string, categoryID: string) {
    const category = tagCategories.find((cat) => cat.id === categoryID);
    if (!category) return;
    const categoryTags = selectedTags.filter((id) => category.tags.some((tag) => tag === id));
    if (selectedTags.includes(tagID)) onTagsChange(selectedTags.filter((id) => id !== tagID));
    else if (categoryTags.length < category.max_tags) onTagsChange([...selectedTags, tagID]);
  }

  function handleAddTag(categoryID: string, newTagName: string) {
    console.log(`Add new tag "${newTagName}" to category ${categoryID}`);
  }

  function renderTagGroups(category: TagCategory, groupConfig: number[][] | undefined) {
    if (!groupConfig || groupConfig.length === 0) groupConfig = [[category.tags.length]]; // Default to all tags in one row

    return groupConfig.map((row, rowIndex) => (
      <Box
        key={rowIndex}
        sx={{ display: 'flex', flexWrap: 'wrap', gap: GAP, mb: rowIndex < groupConfig!.length - 1 ? GAP : 0 }}
      >
        {row.map((groupSize, groupIndex) => {
          const startIndex =
            groupConfig
              .slice(0, rowIndex)
              .flat()
              .reduce((sum, size) => sum + size, 0) + row.slice(0, groupIndex).reduce((sum, size) => sum + size, 0);
          const groupTags = category.tags.slice(startIndex, startIndex + groupSize);

          return groupTags.map((tag) => {
            const isSelected = selectedTags.includes(tag);
            const isDisabled =
              !isSelected &&
              selectedTags.filter((id) => category.tags.some((catTag) => catTag === id)).length >= category.max_tags;
            const catTag = category.expand?.tags?.find((catTag) => catTag.id === tag);

            return (
              <DelayedTooltip key={tag} title={catTag?.description ?? 'No description available'}>
                <Chip
                  label={catTag?.name ?? 'Unknown'}
                  onClick={() => handleTagToggle(tag, category.id)}
                  // @ts-expect-error - MuiChip props
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
  }

  function isMinimumTagsSelected(category: TagCategory) {
    const selectedTagsInCategory = selectedTags.filter((id) => category.tags.some((tag) => tag === id)).length;
    return selectedTagsInCategory >= category.min_tags;
  }

  if (loading) return <CircularProgress size={24} />;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: SECTION_GAP }}>
      {sortedCategories.map((category) => {
        const canAddMore =
          selectedTags.filter((id) => category.tags.some((tag) => tag === id)).length < category.max_tags;

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
                onKeyDown={(e) => {
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
});

export default TagSelector;
