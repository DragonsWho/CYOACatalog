// /moderator/access — per-moderator permissions. Backend: mod_perms.go (`mod_permissions`
// collection, /api/custom/mod/perms). Requires the `perms` right (by default the site owner only).
// "Full access (legacy)" = no permission row yet, full access as before this page existed;
// unchecking anything and saving makes the list explicit.

import React, { useCallback, useEffect, useState } from 'react';
import {
  Container, Typography, Paper, Box, Button, CircularProgress, Alert, Chip,
  Checkbox, FormControlLabel, Snackbar, Divider, Tooltip,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import { styled } from '@mui/material/styles';
import {
  fetchModPerms, saveModPerms, ModCapability, ModPermKey, ModPermsRow,
} from '../../utils/modPerms';

const StyledPaper = styled(Paper)(({ theme }) => ({
  padding: theme.spacing(3),
  margin: theme.spacing(3, 0),
  backgroundColor: '#2e2e2e',
  color: '#e0e0e0',
  borderRadius: 8,
}));

// Expand "*" into concrete keys so checkboxes render uniformly.
const expand = (perms: ModPermKey[], caps: ModCapability[]): ModPermKey[] =>
  perms.includes('*') ? caps.map((c) => c.key) : perms;

const ModAccessPanel: React.FC = () => {
  const [caps, setCaps] = useState<ModCapability[]>([]);
  const [rows, setRows] = useState<ModPermsRow[]>([]);
  const [draft, setDraft] = useState<Record<string, ModPermKey[]>>({});
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchModPerms();
      setCaps(data.capabilities);
      setRows(data.moderators);
      const d: Record<string, ModPermKey[]> = {};
      data.moderators.forEach((m) => {
        // A legacy user formally has no row but in practice everything is open — show that honestly
        // with all boxes checked.
        d[m.user_id] = m.legacy
          ? data.capabilities.map((c) => c.key)
          : expand(m.perms, data.capabilities);
      });
      setDraft(d);
    } catch (e: any) {
      setError(e?.message || 'Failed to load permissions');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = (userId: string, key: ModPermKey) => {
    setDraft((prev) => {
      const cur = prev[userId] || [];
      return {
        ...prev,
        [userId]: cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key],
      };
    });
  };

  const save = async (row: ModPermsRow) => {
    setSavingId(row.user_id);
    setError(null);
    try {
      await saveModPerms(row.user_id, draft[row.user_id] || []);
      setToast(`Saved permissions for ${row.username}`);
      await load();
    } catch (e: any) {
      setError(e?.message || 'Failed to save');
    } finally {
      setSavingId(null);
    }
  };

  const dirty = (row: ModPermsRow): boolean => {
    const now = (draft[row.user_id] || []).slice().sort().join(',');
    const was = (row.legacy ? caps.map((c) => c.key) : expand(row.perms, caps))
      .slice().sort().join(',');
    return now !== was || row.legacy;
  };

  return (
    <Container maxWidth="md">
      <StyledPaper elevation={3}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
          <Typography variant="h5">Moderator access</Typography>
          <Button
            onClick={load}
            disabled={loading}
            startIcon={loading ? <CircularProgress size={16} color="inherit" /> : <RefreshIcon />}
            sx={{ color: '#e0e0e0' }}
          >
            Refresh
          </Button>
        </Box>
        <Typography variant="body2" sx={{ color: '#aaa', mb: 2 }}>
          What each moderator is allowed to do. Unchecking a box hides the page
          from their menu and makes the matching API endpoints refuse them.
          Who is a moderator at all is still the <code>isModerator</code> flag in
          the PocketBase admin — this page only narrows what that role means.
        </Typography>

        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

        {loading && rows.length === 0 ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress />
          </Box>
        ) : (
          rows.map((row) => (
            <Box key={row.user_id} sx={{ mb: 3 }}>
              <Divider sx={{ borderColor: '#444', mb: 2 }} />
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                <Typography variant="h6" sx={{ color: '#e0e0e0' }}>{row.username}</Typography>
                {row.legacy && (
                  <Tooltip title="No explicit permissions saved yet, so this account can do everything — the behaviour from before this page existed. Save once to make the list explicit.">
                    <Chip size="small" color="warning" label="full access (legacy)" />
                  </Tooltip>
                )}
                {!row.legacy && row.perms.includes('*') && (
                  <Chip size="small" color="success" label="all permissions" />
                )}
              </Box>

              <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 0.5 }}>
                {caps.map((cap) => (
                  <Tooltip key={cap.key} title={cap.note} placement="top-start">
                    <FormControlLabel
                      control={
                        <Checkbox
                          size="small"
                          checked={(draft[row.user_id] || []).includes(cap.key)}
                          onChange={() => toggle(row.user_id, cap.key)}
                          sx={{ color: '#888', '&.Mui-checked': { color: '#8ab4f8' } }}
                        />
                      }
                      label={
                        <Typography variant="body2" sx={{ color: '#ccc' }}>
                          {cap.label}
                          {cap.key === 'hosting_purge' && (
                            <Chip size="small" color="error" label="irreversible" sx={{ ml: 1, height: 16 }} />
                          )}
                        </Typography>
                      }
                    />
                  </Tooltip>
                ))}
              </Box>

              <Box sx={{ mt: 1 }}>
                <Button
                  variant="contained"
                  size="small"
                  disabled={savingId === row.user_id || !dirty(row)}
                  onClick={() => save(row)}
                >
                  {savingId === row.user_id ? 'Saving…' : 'Save'}
                </Button>
                {row.updated && (
                  <Typography variant="caption" sx={{ color: '#777', ml: 2 }}>
                    last changed {new Date(row.updated.replace(' ', 'T') + 'Z').toLocaleString()}
                  </Typography>
                )}
              </Box>
            </Box>
          ))
        )}

        {!loading && rows.length === 0 && !error && (
          <Typography variant="body2" sx={{ color: '#888' }}>
            No moderators found.
          </Typography>
        )}
      </StyledPaper>

      <Snackbar
        open={!!toast}
        autoHideDuration={3000}
        onClose={() => setToast(null)}
        message={toast || ''}
      />
    </Container>
  );
};

export default ModAccessPanel;
