import { useState, useEffect, useContext, useRef, useMemo } from 'react';
import { Box, Typography, Autocomplete, TextField, Chip, Button, CircularProgress, Alert } from '@mui/material';
import { Tag, User, pb, usersCollection } from '../../pocketbase/pocketbase';
import { AuthContext } from '../../pocketbase/pocketbase';

interface BlockedTagsSettingsProps {
  allTags: string[];
  initialBlockedTags: Tag[];
  onBlockedTagsUpdate: () => void;
}

const DEFAULT_BLOCKED_TAGS: string[] = ['scat', 'guro', 'diapers', 'vomit'];

export default function BlockedTagsSettings({
  allTags,
  initialBlockedTags,
  onBlockedTagsUpdate,
}: BlockedTagsSettingsProps) {
  const { user }: { user: User | null } = useContext(AuthContext);
  const [selectedBlockedTagNames, setSelectedBlockedTagNames] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const initialSetupDone = useRef(false);

  useEffect(() => {
    if (!user) return;

    if (!initialSetupDone.current) {
        if (!user.blocked_tags_customized && initialBlockedTags.length === 0) {
            const validDefaultTags = DEFAULT_BLOCKED_TAGS.filter(defaultTag =>
                allTags.some(existingTag => existingTag.toLowerCase() === defaultTag.toLowerCase())
            );
            const validDefaultTagsOriginalCase = validDefaultTags
                .map(defaultTag =>
                     allTags.find(existingTag => existingTag.toLowerCase() === defaultTag.toLowerCase())
                )
                .filter((tag): tag is string => tag !== undefined);

            console.log("Applying default blocked tags (initial, user hasn't customized):", validDefaultTagsOriginalCase);
            setSelectedBlockedTagNames(validDefaultTagsOriginalCase.sort());
        } else {
            const currentBlockedNames = initialBlockedTags.map(tag => tag.name);
            console.log("Setting initial state from saved tags (or user customized empty):", currentBlockedNames);
            setSelectedBlockedTagNames(currentBlockedNames.sort());
        }
        initialSetupDone.current = true;
    } else {
         const currentBlockedNames = initialBlockedTags.map(tag => tag.name).sort();
         // The spread copy is mandatory: .sort() on the state array sorted React state in place — a
         // mutation bypassing the setter.
         if (JSON.stringify([...selectedBlockedTagNames].sort()) !== JSON.stringify(currentBlockedNames)) {
            console.log("Syncing state with externally changed initialBlockedTags:", currentBlockedNames);
            setSelectedBlockedTagNames(currentBlockedNames);
         }
    }
  }, [initialBlockedTags, allTags, user]);

  // Copy before sorting: allTags is a parent prop and .sort() mutated it in place.
  const sortedAllTags = useMemo(() => [...allTags].sort(), [allTags]);

  const escapeQuotes = (str: string): string => str.replace(/"/g, '\\"');

  const handleSave = async () => {
    if (!user) { setError("User not logged in."); return; }
    setLoading(true); setError(null); setSuccess(null);
    try {
      let tagIdsToBlock: string[] = [];
      if (selectedBlockedTagNames.length > 0) {
        console.log("Getting IDs for selected names:", selectedBlockedTagNames);
        const filterString = selectedBlockedTagNames.map(name => `name = "${escapeQuotes(name)}"`).join(' || ');
        console.log("Generated filter string:", filterString);
        const fullTagObjects = await pb.collection('tags').getFullList({ filter: filterString, fields: 'id' });
        tagIdsToBlock = fullTagObjects.map(tag => tag.id);
        if (tagIdsToBlock.length !== selectedBlockedTagNames.length) {
             console.warn("Warning: Not all selected tag names were found in the database. Some might be invalid.");
        }
      } else {
        console.log("No blocked tags selected, saving empty array.");
      }
      console.log("Saving blocked tags. Final IDs to block:", tagIdsToBlock);

      await usersCollection.update(user.id, {
        blocked_tags: tagIdsToBlock,
        blocked_tags_customized: true,
      });

      setSuccess("Blocked tags updated successfully!");
      onBlockedTagsUpdate();

    } catch (err: any) {
      console.error("Error updating blocked tags:", err);
      console.error("PocketBase error details:", err.data);
      setError(`Failed to update blocked tags: ${err.message || 'Unknown error'}`);
    } finally {
      setLoading(false);
      setTimeout(() => { setSuccess(null); setError(null); }, 3000);
    }
  };

  return (
    <Box sx={{ mt: 3 }}>
      <Typography variant="h6" gutterBottom>
        Blocked Tags Management
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Games containing any of these tags will always be hidden. Some potentially disturbing tags might be blocked by default. You can remove any tags from this list and save your preferences.
      </Typography>

      <Autocomplete
        multiple
        options={sortedAllTags}
        value={selectedBlockedTagNames}
        onChange={(_event, newValue) => {
          console.log("Autocomplete onChange:", newValue);
          setSelectedBlockedTagNames(newValue.sort());
        }}
        renderInput={(params) => (
          <TextField
            {...params}
            variant="outlined"
            label="Select tags to block"
            placeholder={selectedBlockedTagNames.length === 0 ? 'Search and select tags...' : ''}
            fullWidth
          />
        )}
        renderTags={(value, getTagProps) =>
          value.map((option, index) => {
             const { key, ...tagProps } = getTagProps({ index });
             return (
                  <Chip
                    key={option}
                    label={option}
                    variant="outlined"
                    color="error"
                    size="small"
                    {...tagProps}
                 />
             );
         })
        }
        disableCloseOnSelect
        sx={{ mb: 2 }}
      />
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
         <Button variant="contained" onClick={handleSave} disabled={loading} startIcon={loading ? <CircularProgress size={20} color="inherit" /> : null} >
            Save Blocked Tags
         </Button>
         {success && <Alert severity="success" sx={{py: 0.5}}>{success}</Alert>}
         {error && <Alert severity="error" sx={{py: 0.5}}>{error}</Alert>}
      </Box>
    </Box>
  );
}