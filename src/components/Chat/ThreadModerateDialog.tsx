// Topic moderation dialog: title, tags, hide. Separate from "edit OP": the OWNER deliberately can't
// change title/tags (the topic was found, remembered and linked by them — renaming turns a link
// into a bait); moderators come precisely to fix bait titles or wrong ratings. No delete, ever: a
// topic is others' conversation; hide (enabled=false) is reversible.

import { useEffect, useState } from 'react';
import {
  Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle,
  FormControlLabel, Stack, Switch, TextField, Typography, Box,
} from '@mui/material';
import { TagChip } from './ThreadComposer';
import {
  EXTRA_TAGS, RATING_TAGS, knownTags, type CommunityTag,
} from './communityTags';
import {
  communitySitePinsReady, fetchCommunitySitePins, moderateCommunityRoom,
  COMMUNITY_TITLE_MAX, type CommunityRoom,
} from './communityApi';

const TITLE_MAX = COMMUNITY_TITLE_MAX;
const EXTRA_MAX = 2;

type Props = {
  open: boolean;
  room: CommunityRoom | null;
  onClose: () => void;
  onSaved: (room: CommunityRoom) => void;
};

export default function ThreadModerateDialog({ open, room, onClose, onSaved }: Props) {
  const [title, setTitle] = useState('');
  const [rating, setRating] = useState<CommunityTag | null>(null);
  const [extra, setExtra] = useState<CommunityTag[]>([]);
  const [hidden, setHidden] = useState(false);
  // Site-wide pin (for EVERYONE); unrelated to personal pin slots. `sitePinOn` = field exists in
  // schema; until then no toggle (the handler would refuse).
  const [sitePin, setSitePin] = useState(false);
  const [sitePinOn, setSitePinOn] = useState(communitySitePinsReady() ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Every open starts from the current topic state.
  useEffect(() => {
    if (!open) return;
    const known = knownTags(room?.tags);
    setTitle(room?.title ?? '');
    setRating(RATING_TAGS.find((t) => known.includes(t)) ?? null);
    setExtra(EXTRA_TAGS.filter((t) => known.includes(t)));
    setHidden(Boolean(room?.hidden));
    setSitePin((room?.site_pin ?? 0) > 0);
    setError('');
    setBusy(false);
    // If the topic list wasn't opened in this tab we don't know the schema — ask once; the module
    // caches the answer.
    if (communitySitePinsReady() === null) {
      void fetchCommunitySitePins().then((r) => setSitePinOn(r.enabled));
    }
  }, [open, room?.id, room?.title, room?.tags, room?.hidden, room?.site_pin]);

  const toggleExtra = (t: CommunityTag) => setExtra((cur) => (
    cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t].slice(0, EXTRA_MAX)
  ));

  const trimmed = title.trim();
  const save = async () => {
    if (!room || busy) return;
    if (trimmed.length < 3 || trimmed.length > TITLE_MAX) {
      setError(`Title must be 3–${TITLE_MAX} characters.`);
      return;
    }
    if (!rating) {
      setError('Pick SFW or NSFW.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      onSaved(await moderateCommunityRoom({
        room: room.id,
        title: trimmed,
        tags: [rating, ...extra],
        hidden,
        // Weight, not a checkbox: few pins, the only dispute is which is first. Server sorts by
        // weight, then date.
        ...(sitePinOn ? { sitePin: sitePin ? 1 : 0 } : {}),
      }));
    } catch (e) {
      const msg = (e as { response?: { message?: string }; message?: string });
      setError(msg.response?.message || msg.message || 'Failed to save.');
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ pb: 1 }}>Moderate the thread</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 0.5 }}>
          {error && <Alert severity="error" onClose={() => setError('')}>{error}</Alert>}

          <TextField
            autoFocus
            fullWidth
            size="small"
            label="Title"
            value={title}
            onChange={(e) => setTitle(e.target.value.slice(0, TITLE_MAX))}
            disabled={busy}
            helperText={`${trimmed.length}/${TITLE_MAX} — this is what people see in the list`}
          />

          <Stack
            direction="row"
            alignItems="center"
            sx={{ flexWrap: 'wrap', gap: 0.75, rowGap: 0.75 }}
          >
            <Typography sx={{ fontSize: 10.5, fontWeight: 800, color: 'text.disabled', letterSpacing: 0.6 }}>
              RATING
            </Typography>
            {RATING_TAGS.map((t) => (
              <TagChip
                key={t}
                tag={t}
                on={rating === t}
                onClick={() => setRating(rating === t ? null : t)}
              />
            ))}
            <Box sx={{ width: '1px', height: 16, bgcolor: 'divider', mx: 0.5, flexShrink: 0 }} />
            <Typography sx={{ fontSize: 10.5, fontWeight: 800, color: 'text.disabled', letterSpacing: 0.6 }}>
              TOPIC
            </Typography>
            {EXTRA_TAGS.map((t) => (
              <TagChip
                key={t}
                tag={t}
                on={extra.includes(t)}
                disabled={extra.length >= EXTRA_MAX}
                onClick={() => toggleExtra(t)}
              />
            ))}
          </Stack>

          {sitePinOn && (
            <>
              <FormControlLabel
                control={(
                  <Switch
                    checked={sitePin}
                    onChange={(e) => setSitePin(e.target.checked)}
                    disabled={busy}
                  />
                )}
                label="Pin for everyone"
              />
              <Typography variant="caption" sx={{ mt: -1.5, color: 'text.disabled' }}>
                Sits at the top of the threads page for every visitor, guests included.
                A few slots only — the oldest pin has to go before a new one fits.
              </Typography>
            </>
          )}

          <FormControlLabel
            control={(
              <Switch
                checked={hidden}
                onChange={(e) => setHidden(e.target.checked)}
                disabled={busy}
              />
            )}
            label="Hide the thread"
          />
          {/* Say what the toggle does: "hide" without explanation reads as "delete". */}
          <Typography variant="caption" sx={{ mt: -1.5, color: 'text.disabled' }}>
            Hidden threads disappear from the lists and from search, but nothing is
            deleted and this can be undone.
          </Typography>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant="contained" onClick={() => void save()} disabled={busy || !room}>
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}
