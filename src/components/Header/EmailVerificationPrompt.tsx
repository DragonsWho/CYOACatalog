import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Typography,
} from '@mui/material';

export const EMAIL_VERIFICATION_PROMPT_QUERY = 'verification_prompt';
export const EMAIL_VERIFICATION_PROMPT_VALUE = 'check-email';

interface EmailVerificationPromptProps {
  open: boolean;
  onClose: () => void;
}

export default function EmailVerificationPrompt({
  open,
  onClose,
}: EmailVerificationPromptProps) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      PaperProps={{ sx: { backgroundImage: 'none', maxWidth: 420 } }}
    >
      <DialogTitle textAlign="center" fontWeight={700}>
        Check your inbox
      </DialogTitle>
      <DialogContent>
        <Box display="flex" flexDirection="column" gap={2}>
          <Typography textAlign="center" color="text.secondary">
            We sent a verification link to your email. Confirm it to activate your
            account and enable password recovery.
          </Typography>
          <Alert severity="info">
            Didn’t get the email? Give it a minute and be sure to check the spam folder.
          </Alert>
        </Box>
      </DialogContent>
      <DialogActions sx={{ justifyContent: 'center', pb: 2 }}>
        <Button variant="contained" onClick={onClose}>
          Got it
        </Button>
      </DialogActions>
    </Dialog>
  );
}