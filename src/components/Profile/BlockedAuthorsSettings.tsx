import { useState, useEffect, useContext, useMemo } from 'react';
import { Box, Typography, Autocomplete, TextField, Chip, Button, CircularProgress, Alert, debounce } from '@mui/material';
import { User, usersCollection, authorsCollectionPublic, AuthContext } from '../../pocketbase/pocketbase';

interface BlockedAuthorsSettingsProps {
  blockedAuthorIds: string[];
  onBlockedAuthorsUpdate: () => void;
}

type AuthorOption = { id: string; name: string };

export default function BlockedAuthorsSettings({
  blockedAuthorIds,
  onBlockedAuthorsUpdate,
}: BlockedAuthorsSettingsProps) {
  const { user }: { user: User | null } = useContext(AuthContext);
  const [selected, setSelected] = useState<AuthorOption[]>([]);
  const [options, setOptions] = useState<AuthorOption[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [searching, setSearching] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Fetch names by id — the user record holds only ids (payload discipline: no expanding
  // blocked_authors on every authRefresh).
  useEffect(() => {
    if (blockedAuthorIds.length === 0) {
      setSelected([]);
      return;
    }
    let cancelled = false;
    const filter = blockedAuthorIds.map((id) => `id = "${id}"`).join(' || ');
    authorsCollectionPublic
      .getFullList({ filter, fields: 'id,name' })
      .then((res) => {
        if (cancelled) return;
        const byId = new Map(res.map((a) => [a.id, a.name as string]));
        setSelected(blockedAuthorIds.filter((id) => byId.has(id)).map((id) => ({ id, name: byId.get(id)! })));
      })
      .catch((err: Error) => {
        if (!cancelled) setError(`Failed to load blocked authors: ${err?.message || 'Unknown error'}`);
      });
    return () => {
      cancelled = true;
    };
  }, [blockedAuthorIds]);

  // Thousands of authors: server-side debounced search, not the full list.
  const fetchSuggestions = useMemo(
    () =>
      debounce(async (input: string, callback: (results: AuthorOption[]) => void) => {
        if (input.length < 2) {
          callback([]);
          return;
        }
        try {
          const q = input.replace(/"/g, '\\"');
          const result = await authorsCollectionPublic.getList(1, 10, {
            filter: `(name ~ "${q}" || aliases ~ "${q}")`,
            fields: 'id,name',
            skipTotal: true,
          });
          callback(result.items as unknown as AuthorOption[]);
        } catch {
          callback([]);
        }
      }, 300),
    [],
  );

  useEffect(() => {
    let active = true;
    if (inputValue.trim().length < 2) {
      setOptions([]);
      setSearching(false);
      return undefined;
    }
    setSearching(true);
    fetchSuggestions(inputValue.trim(), (results) => {
      if (!active) return;
      setOptions(results);
      setSearching(false);
    });
    return () => {
      active = false;
    };
  }, [inputValue, fetchSuggestions]);

  const handleSave = async () => {
    if (!user) {
      setError('User not logged in.');
      return;
    }
    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      await usersCollection.update(user.id, { blocked_authors: selected.map((a) => a.id) });
      setSuccess('Blocked authors updated successfully!');
      onBlockedAuthorsUpdate();
    } catch (err) {
      console.error('Error updating blocked authors:', err);
      setError(`Failed to update blocked authors: ${(err as Error)?.message || 'Unknown error'}`);
    } finally {
      setLoading(false);
      setTimeout(() => {
        setSuccess(null);
        setError(null);
      }, 3000);
    }
  };

  return (
    <Box sx={{ mt: 4 }}>
      <Typography variant="h6" gutterBottom>
        Blocked Authors Management
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Games by these authors will always be hidden from your catalog and search results. Only you
        see this list.
      </Typography>

      <Autocomplete
        multiple
        options={options}
        value={selected}
        // Options come pre-filtered from the server — no client filter, or MUI filters again by
        // label and the list collapses.
        filterOptions={(x) => x}
        getOptionLabel={(option) => option.name}
        isOptionEqualToValue={(option, value) => option.id === value.id}
        inputValue={inputValue}
        onInputChange={(_event, newInput) => setInputValue(newInput)}
        onChange={(_event, newValue) => {
          // The same author may come from search twice — dedupe.
          const seen = new Set<string>();
          setSelected(newValue.filter((a) => (seen.has(a.id) ? false : (seen.add(a.id), true))));
        }}
        loading={searching}
        noOptionsText={inputValue.trim().length < 2 ? 'Type at least 2 characters…' : 'No authors found'}
        renderInput={(params) => (
          <TextField
            {...params}
            variant="outlined"
            label="Select authors to block"
            placeholder={selected.length === 0 ? 'Search authors by name…' : ''}
            fullWidth
            InputProps={{
              ...params.InputProps,
              endAdornment: (
                <>
                  {searching ? <CircularProgress color="inherit" size={18} /> : null}
                  {params.InputProps.endAdornment}
                </>
              ),
            }}
          />
        )}
        renderTags={(value, getTagProps) =>
          value.map((option, index) => {
            const { key, ...tagProps } = getTagProps({ index });
            return <Chip key={key} label={option.name} variant="outlined" color="error" size="small" {...tagProps} />;
          })
        }
        disableCloseOnSelect
        sx={{ mb: 2 }}
      />

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <Button
          variant="contained"
          onClick={handleSave}
          disabled={loading}
          startIcon={loading ? <CircularProgress size={20} color="inherit" /> : null}
        >
          Save Blocked Authors
        </Button>
        {success && <Alert severity="success" sx={{ py: 0.5 }}>{success}</Alert>}
        {error && <Alert severity="error" sx={{ py: 0.5 }}>{error}</Alert>}
      </Box>
    </Box>
  );
}
