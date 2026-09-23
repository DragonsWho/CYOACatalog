// Chat settings in the profile. Main item: show yourself in "who's here". The toggle also exists in
// chat, but must live here too: registered users are VISIBLE by default, so someone who doesn't
// want that mustn't have to open chat first to find it. `chat_hidden` lives on the account, not the
// browser (hide from the whole site on all devices); the server reads it on every presence ping
// (shoutbox.go, POST /ping).
// Below are the same two toggles as in chat (header icon click behavior, phone swipe). They live in
// localStorage (chatPrefs.ts) on purpose — per device, not per person; duplicated here for
// discoverability.

import { useContext, useState } from 'react';
import {
  Alert, Box, CircularProgress, Divider, FormControlLabel, Switch,
  ToggleButton, ToggleButtonGroup, Typography,
} from '@mui/material';
import { AuthContext, pb } from '../../pocketbase/pocketbase';
import { setChatPref, useChatPrefs, type SwipeOpenMode } from '../Chat/chatPrefs';

export default function ChatSettings() {
  const { user } = useContext(AuthContext);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const viewPrefs = useChatPrefs();

  // The checkbox has no own state: it shows the account record; the server response updates
  // authStore → context → checkbox.
  const shown = !user?.chat_hidden;

  const onToggle = async (next: boolean) => {
    if (!user || saving) return;
    setSaving(true);
    setError(null);
    try {
      await pb.collection('users').update(user.id, { chat_hidden: !next });
    } catch (err) {
      setError((err as Error)?.message || 'Could not save the setting.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Box>
      {error && <Alert severity="error" sx={{ mb: 2, borderRadius: 1 }}>{error}</Alert>}
      <FormControlLabel
        control={(
          <Switch
            checked={shown}
            disabled={saving}
            onChange={(e) => onToggle(e.target.checked)}
          />
        )}
        label={(
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Typography variant="body2">Show me in the chat&apos;s members list</Typography>
            {saving && <CircularProgress size={14} />}
          </Box>
        )}
      />
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
        {shown
          ? 'Other people can see your name while you are on the site and write to you directly.'
          : 'You are counted as one of the people online, but your name is not listed.'}
      </Typography>

      <Divider sx={{ my: 2 }} />

      <FormControlLabel
        control={(
          <Switch
            checked={viewPrefs.singleClickFullChat}
            onChange={(e) => setChatPref('singleClickFullChat', e.target.checked)}
          />
        )}
        label="Header icon opens the full chat"
      />
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5, mb: 1 }}>
        {viewPrefs.singleClickFullChat
          ? 'One click on the chat bubble in the header opens the full page; two clicks open the quick chat.'
          : 'One click on the chat bubble in the header opens the quick chat; two clicks open the full page.'}
      </Typography>

      {/*
        Finger gesture shown to everyone: behind TOUCH_ONLY people couldn't find it (flaky tablet
        detection; mobile "desktop mode" hid it). Per-device, so the text says it applies on
        phone/tablet.
      */}
      <Typography variant="body2" sx={{ mb: 0.5 }}>
        Swipe to open chat
      </Typography>
      <ToggleButtonGroup
        value={viewPrefs.swipeOpenMode}
        exclusive
        size="small"
        onChange={(_, next: SwipeOpenMode | null) => {
          if (next) setChatPref('swipeOpenMode', next);
        }}
      >
        <ToggleButton value="everywhere">Everywhere</ToggleButton>
        <ToggleButton value="games_off">Off in games</ToggleButton>
        <ToggleButton value="off">Off</ToggleButton>
      </ToggleButtonGroup>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
        {viewPrefs.swipeOpenMode === 'off'
          ? 'Swiping right-to-left from the edge of the screen does nothing.'
          : viewPrefs.swipeOpenMode === 'games_off'
            ? 'Swiping right-to-left from the edge of the screen opens the quick chat, except on game pages — there it often clashes with the game itself.'
            : 'Swiping right-to-left from the edge of the screen opens the quick chat, on any page.'}
        {' '}
        Touchscreens only, and remembered per device — set it on the phone you swipe on.
      </Typography>
    </Box>
  );
}
