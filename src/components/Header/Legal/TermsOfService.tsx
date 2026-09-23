import React from 'react';
import { Container, Typography, Box, Paper } from '@mui/material';

const TermsOfService: React.FC = () => {
  return (
    <Container maxWidth="md" sx={{ py: 4 }}>
      <Paper sx={{ p: 4 }}>
        <Typography variant="h4" component="h1" gutterBottom>
          Terms of Service
        </Typography>
        <Typography variant="subtitle1" gutterBottom color="text.secondary">
          Last Updated: February 20, 2024
        </Typography>

        <Box sx={{ mt: 4 }}>
          <Typography variant="h6" gutterBottom>
            1. Acceptance of Terms and Age Restriction
          </Typography>
          <Typography paragraph>
            By accessing or using our website, you agree to be bound by these Terms of Service.
          </Typography>
          <Typography paragraph sx={{ fontWeight: 'bold', color: 'error.main' }}>
            WARNING: This Service contains content intended for mature audiences (NSFW), including
            artistic depictions that may be considered adult in nature.
          </Typography>
          <Typography paragraph sx={{ fontWeight: 'bold' }}>
            You represent and warrant that you are at least 18 years of age (or the age of majority in your jurisdiction)
            and have the legal capacity to enter into this agreement. If you are under 18 years of age,
            you are strictly prohibited from using or accessing this Service.
          </Typography>
          <Typography paragraph>
            If you do not agree to these terms, please do not use our services.
          </Typography>

          <Typography variant="h6" gutterBottom>
            2. Use of Service
          </Typography>
          <Typography paragraph>
            Our service allows users to discover and interact with Choose Your Own Adventure (CYOA) games.
            You agree to use the service only for lawful purposes and in accordance with these Terms.
            While we host community content, we strictly prohibit illegal content.
          </Typography>

          <Typography variant="h6" gutterBottom>
            3. User Accounts
          </Typography>
          <Typography paragraph>
            To access certain features like saving preferences or commenting, you may need to create an account
            using a third-party authentication provider (such as Google). You are responsible for maintaining
            the confidentiality of your account information.
          </Typography>
          <Typography paragraph>
            We collect minimal information (email and display name) solely for the purpose of maintaining
            your user profile and preferences.
          </Typography>

          <Typography variant="h6" gutterBottom>
            4. User Content
          </Typography>
          <Typography paragraph>
            Users may post comments or interact with content. You retain ownership of your contributions,
            but you grant us a license to display and store them in connection with the service.
            We reserve the right to remove any content that violates our community guidelines, is illegal, or is deemed inappropriate.
          </Typography>

          <Typography variant="h6" gutterBottom>
            5. Disclaimer
          </Typography>
          <Typography paragraph>
            The service is provided "as is" without warranties of any kind. We do not guarantee that the
            service will be uninterrupted or error-free.
          </Typography>

          <Typography variant="h6" gutterBottom>
            6. Changes to Terms
          </Typography>
          <Typography paragraph>
            We reserve the right to modify these terms at any time. Continued use of the service after
            any changes constitutes acceptance of the new terms.
          </Typography>
        </Box>
      </Paper>
    </Container>
  );
};

export default TermsOfService;