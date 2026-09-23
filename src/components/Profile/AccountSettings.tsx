import React, { useState, useContext } from 'react';
import { Box, Button, CircularProgress, TextField, Typography, Alert, Dialog, DialogTitle, DialogContent, DialogContentText, DialogActions, Paper, Grid } from '@mui/material';
import { styled, alpha } from '@mui/material/styles';
import LockIcon from '@mui/icons-material/Lock';
import LockOpenIcon from '@mui/icons-material/LockOpen';
import { pb, AuthContext } from '../../pocketbase/pocketbase';
import { LinkifiedText, pbErrorText } from '../../utils/pbErrors';

const StyledTextField = styled(TextField)(({ theme }) => ({
  '& .MuiOutlinedInput-root': {
    backgroundColor: '#1e1e1e', borderRadius: 8, transition: 'all 0.2s ease-in-out',
    '& fieldset': { borderColor: 'transparent' },
    '&:hover': { backgroundColor: '#252525' },
    '&:hover fieldset': { borderColor: 'rgba(255,255,255,0.1)' },
    '&.Mui-focused': { backgroundColor: '#252525', boxShadow: `0 0 0 2px ${alpha(theme.palette.primary.main, 0.25)}` },
    '&.Mui-focused fieldset': { borderColor: theme.palette.primary.main, borderWidth: 1 },
  },
  '& .MuiInputBase-input': { color: '#fff', padding: '12px 14px', fontSize: '0.9rem', fontWeight: 500 },
  '& .MuiInputLabel-root': { color: '#888', transform: 'translate(14px, 12px) scale(1)', fontSize: '0.9rem' },
  '& .MuiInputLabel-root.Mui-focused, & .MuiInputLabel-root.MuiFormLabel-filled': {
    transform: 'translate(14px, -9px) scale(0.75)', color: theme.palette.primary.main, backgroundColor: '#1e1e1e', padding: '0 6px', borderRadius: 4,
  },
}));

const SaveButton = styled(Button)(({ theme }) => ({
    borderRadius: 6, fontWeight: 700, textTransform: 'uppercase', boxShadow: 'none',
    padding: '8px 20px', fontSize: '0.8rem', backgroundColor: theme.palette.error.main,
    '&:hover': { backgroundColor: theme.palette.error.dark }
}));

const DangerZonePaper = styled(Paper)(({ theme }) => ({
    backgroundColor: alpha(theme.palette.error.main, 0.05), border: `1px solid ${alpha(theme.palette.error.main, 0.2)}`,
    padding: theme.spacing(3), borderRadius: 8, textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: theme.spacing(2)
}));

const SettingsCard = styled(Paper)(() => ({
    backgroundColor: '#252525', padding: '20px', borderRadius: 8, height: '100%', display: 'flex', flexDirection: 'column',
}));

const CONFIRMATION_PHRASE = "manage account";

export default function AccountSettings() {
  const { user } = useContext(AuthContext);
  
  const [isLocked, setIsLocked] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmInput, setConfirmInput] = useState('');
  const [dialogError, setDialogError] = useState(false);

  const [username, setUsername] = useState(user?.username || '');
  const [name, setName] = useState(user?.name || '');
  // Username changes only once: the server latches username_locked after the first change.
  const usernameLocked = !!user?.username_locked;
  const [isProfileLoading, setIsProfileLoading] = useState(false);
  const [profileMsg, setProfileMsg] = useState<{type: 'success' | 'error', text: string} | null>(null);

  // Email linking uses its own endpoint, not requestEmailChange: PB requires the account password
  // on confirmation, and Discord-login accounts have none (account_email.go). This only requests;
  // the address changes when the emailed link is followed.
  const currentEmail = user?.email || '';
  const [newEmail, setNewEmail] = useState('');
  const [isEmailLoading, setIsEmailLoading] = useState(false);
  const [emailMsg, setEmailMsg] = useState<{type: 'success' | 'error', text: string} | null>(null);

  const [oldPassword, setOldPassword] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [isPassLoading, setIsPassLoading] = useState(false);
  const [passMsg, setPassMsg] = useState<{type: 'success' | 'error', text: string} | null>(null);

  const handleUnlockConfirm = () => {
      if (confirmInput.toLowerCase() === CONFIRMATION_PHRASE) {
          setIsLocked(false); setDialogOpen(false);
      } else { setDialogError(true); }
  };

  const handleProfileSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setIsProfileLoading(true);
    setProfileMsg(null);
    try {
      // Don't send username if locked — the server would reject it.
      const payload = usernameLocked ? { name } : { username, name };
      await pb.collection('users').update(user.id, payload);
      setProfileMsg({ type: 'success', text: 'Profile updated successfully.' });
    } catch (err: unknown) {
      setProfileMsg({ type: 'error', text: pbErrorText(err) });
    } finally {
      setIsProfileLoading(false);
    }
  };

  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setIsEmailLoading(true);
    setEmailMsg(null);
    try {
      await pb.send('/api/custom/account/email/request', { method: 'POST', body: { email: newEmail } });
      setEmailMsg({ type: 'success', text: `Confirmation link sent to ${newEmail}. Open it to finish.` });
      setNewEmail('');
    } catch (err: unknown) {
      const errorMsg = pbErrorText(err);
      setEmailMsg({ type: 'error', text: errorMsg });
    } finally {
      setIsEmailLoading(false);
    }
  };

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    if (password !== passwordConfirm) {
      setPassMsg({ type: 'error', text: 'New passwords do not match.' });
      return;
    }
    setIsPassLoading(true);
    setPassMsg(null);
    try {
      await pb.collection('users').update(user.id, { oldPassword, password, passwordConfirm });
      setPassMsg({ type: 'success', text: 'Password changed successfully.' });
      setOldPassword(''); setPassword(''); setPasswordConfirm('');
    } catch (err: unknown) {
      const errorMsg = pbErrorText(err);
      setPassMsg({ type: 'error', text: errorMsg });
    } finally {
      setIsPassLoading(false);
    }
  };

  if (isLocked) {
      return (
          <>
            <DangerZonePaper elevation={0}>
                <LockIcon sx={{ fontSize: 40, color: 'error.main', opacity: 0.8 }} />
                <Typography variant="h6" color="error.main" sx={{fontSize: '1rem', fontWeight: 700}}>Restricted Area</Typography>
                <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 400, mb: 1 }}>Change password, update email, or manage other sensitive settings.</Typography>
                <Button variant="outlined" color="error" onClick={() => { setConfirmInput(''); setDialogError(false); setDialogOpen(true); }} startIcon={<LockOpenIcon />} size="small">Unlock</Button>
            </DangerZonePaper>

            <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} PaperProps={{ sx: { backgroundColor: '#1e1e1e', border: '1px solid #333', color: '#fff' } }}>
                <DialogTitle sx={{ color: '#fff', fontSize: '1rem' }}>Security Verification</DialogTitle>
                <DialogContent>
                    <DialogContentText sx={{ color: '#aaa', mb: 2, fontSize: '0.9rem' }}>Type <strong>{CONFIRMATION_PHRASE}</strong> to proceed.</DialogContentText>
                    <TextField autoFocus fullWidth size="small" variant="outlined" value={confirmInput} onChange={(e) => setConfirmInput(e.target.value)} placeholder={CONFIRMATION_PHRASE} error={dialogError} sx={{ input: { color: '#fff' }, fieldset: { borderColor: '#444' } }} />
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setDialogOpen(false)} sx={{ color: '#666' }}>Cancel</Button>
                    <Button onClick={handleUnlockConfirm} color="error">Unlock</Button>
                </DialogActions>
            </Dialog>
          </>
      );
  }

  return (
    <Box>
        <Alert severity="warning" icon={false} sx={{ mb: 3, borderRadius: 1, py: 0, backgroundColor: 'rgba(255, 167, 38, 0.1)', color: '#ffcc80', border: '1px solid rgba(255, 167, 38, 0.2)' }}>
            <Typography variant="caption">You are in editing mode. Save changes carefully.</Typography>
        </Alert>
        
        <Grid container spacing={2}>
            <Grid item xs={12} md={6}>
              <SettingsCard elevation={0}>
                <Box component="form" onSubmit={handleProfileSubmit} sx={{ display: 'flex', flexDirection: 'column', flexGrow: 1 }}>
                  <Typography variant="subtitle1" sx={{ mb: 2, color: '#fff', fontWeight: 600, fontSize: '0.95rem' }}>Profile Information</Typography>
                  {profileMsg && <Alert severity={profileMsg.type} sx={{ mb: 2, borderRadius: 1 }}><LinkifiedText text={profileMsg.text} /></Alert>}
                  <Grid container spacing={2}>
                    <Grid item xs={12}><StyledTextField name="username" label="Username" value={username} onChange={e => setUsername(e.target.value)} fullWidth size="small" required disabled={usernameLocked} helperText={usernameLocked ? 'Username is locked and can no longer be changed.' : 'You can change your username only once – choose carefully.'} FormHelperTextProps={{ sx: { color: usernameLocked ? '#888' : '#ffcc80', mx: 0.5 } }} /></Grid>
                    <Grid item xs={12}><StyledTextField name="name" label="Display Name" value={name} onChange={e => setName(e.target.value)} fullWidth size="small" /></Grid>
                  </Grid>
                  <Box sx={{ mt: 'auto', pt: 3, display: 'flex', justifyContent: 'flex-end' }}>
                    <SaveButton type="submit" variant="contained" disabled={isProfileLoading}>{isProfileLoading ? <CircularProgress size={20} /> : 'Update Profile'}</SaveButton>
                  </Box>
                </Box>
              </SettingsCard>
            </Grid>
            
            {/*
              Email link/change: for a Discord account the only way to ever recover access (no
              password, and password reset goes to email it doesn't have).
            */}
            <Grid item xs={12} md={6}>
              <SettingsCard elevation={0}>
                <Box component="form" onSubmit={handleEmailSubmit} sx={{ display: 'flex', flexDirection: 'column', flexGrow: 1 }}>
                  <Typography variant="subtitle1" sx={{ mb: 2, color: '#fff', fontWeight: 600, fontSize: '0.95rem' }}>Email</Typography>
                  {emailMsg && <Alert severity={emailMsg.type} sx={{ mb: 2, borderRadius: 1 }}>{emailMsg.text}</Alert>}
                  <Typography variant="body2" sx={{ mb: 2, color: '#aaa' }}>
                    {currentEmail
                      ? <>Currently linked: <strong style={{ color: '#fff' }}>{currentEmail}</strong>{user?.verified ? '' : ' (not confirmed)'}</>
                      : 'No email linked yet — you have no way to recover this account.'}
                  </Typography>
                  <Grid container spacing={2}>
                    <Grid item xs={12}>
                      <StyledTextField
                        name="newEmail" type="email" label={currentEmail ? 'New email address' : 'Email address'}
                        value={newEmail} onChange={e => setNewEmail(e.target.value)} fullWidth size="small" required
                        helperText="We send a link there; the address changes only after you open it."
                        FormHelperTextProps={{ sx: { color: '#888', mx: 0.5 } }}
                      />
                    </Grid>
                  </Grid>
                  <Box sx={{ mt: 'auto', pt: 3, display: 'flex', justifyContent: 'flex-end' }}>
                    <SaveButton type="submit" variant="contained" disabled={isEmailLoading}>{isEmailLoading ? <CircularProgress size={20} /> : 'Send Link'}</SaveButton>
                  </Box>
                </Box>
              </SettingsCard>
            </Grid>

            <Grid item xs={12} md={6}>
              <SettingsCard elevation={0}>
                <Box component="form" onSubmit={handlePasswordSubmit} sx={{ display: 'flex', flexDirection: 'column', flexGrow: 1 }}>
                  <Typography variant="subtitle1" sx={{ mb: 2, color: '#fff', fontWeight: 600, fontSize: '0.95rem' }}>Change Password</Typography>
                  {passMsg && <Alert severity={passMsg.type} sx={{ mb: 2, borderRadius: 1 }}>{passMsg.text}</Alert>}
                  <Grid container spacing={2}>
                    <Grid item xs={12}><StyledTextField name="oldPassword" type="password" label="Current Password" value={oldPassword} onChange={e => setOldPassword(e.target.value)} fullWidth size="small" required /></Grid>
                    <Grid item xs={12}><StyledTextField name="password" type="password" label="New Password" value={password} onChange={e => setPassword(e.target.value)} fullWidth size="small" required /></Grid>
                    <Grid item xs={12}><StyledTextField name="passwordConfirm" type="password" label="Confirm New Password" value={passwordConfirm} onChange={e => setPasswordConfirm(e.target.value)} fullWidth size="small" required /></Grid>
                  </Grid>
                  <Box sx={{ mt: 'auto', pt: 3, display: 'flex', justifyContent: 'flex-end' }}>
                    <SaveButton type="submit" variant="contained" disabled={isPassLoading}>{isPassLoading ? <CircularProgress size={20} /> : 'Set Password'}</SaveButton>
                  </Box>
                </Box>
              </SettingsCard>
            </Grid>
        </Grid>
    </Box>
  );
}