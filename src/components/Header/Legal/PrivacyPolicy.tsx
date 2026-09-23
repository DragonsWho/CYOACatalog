import React from 'react';
import { Container, Typography, Box, Paper } from '@mui/material';

const PrivacyPolicy: React.FC = () => {
  return (
    <Container maxWidth="md" sx={{ py: 4 }}>
      <Paper sx={{ p: 4 }}>
        <Typography variant="h4" component="h1" gutterBottom>
          Privacy Policy
        </Typography>
        <Typography variant="subtitle1" gutterBottom color="text.secondary">
          Last Updated: February 20, 2024
        </Typography>

        <Box sx={{ mt: 4 }}>
          <Typography variant="h6" gutterBottom>
            1. Information We Collect
          </Typography>
          <Typography paragraph>
            We collect only the minimum amount of information necessary to provide our services.
            When you sign up or log in using Google or other providers, we only request and store:
          </Typography>
          <ul>
            <li>
              <Typography paragraph>Your email address (for account identification)</Typography>
            </li>
            <li>
              <Typography paragraph>Your display name (to show on your profile/comments)</Typography>
            </li>
          </ul>
          <Typography paragraph>
            We do not request, access, or store any other personal data (such as contacts, location, or photos) from your OAuth providers.
          </Typography>

          <Typography variant="h6" gutterBottom>
            2. How We Use Your Information
          </Typography>
          <Typography paragraph>
            The information we collect is used solely for authentication purposes and to provide you with
            personalized features of the site. Specifically, we use your data to:
          </Typography>
          <ul>
            <li>
              <Typography paragraph>Create and maintain your user account.</Typography>
            </li>
            <li>
              <Typography paragraph>
                Attribute your comments and game ratings to you.
              </Typography>
            </li>
          </ul>

          <Typography variant="h6" gutterBottom>
            3. Cookies and Local Storage
          </Typography>
          <Typography paragraph>
            We use local storage and cookies solely to enhance your user experience. This includes:
          </Typography>
          <ul>
            <li>
              <Typography paragraph>
                Maintaining your logged-in session.
              </Typography>
            </li>
            <li>
              <Typography paragraph>
                <strong>Preference Settings:</strong> Storing your interface preferences, specifically the state of the
                SFW (Safe For Work) / NSFW (Not Safe For Work) toggle, to ensure the site content matches your comfort level.
              </Typography>
            </li>
          </ul>
          <Typography paragraph>
            We do not use cookies for third-party advertising or cross-site tracking.
          </Typography>

          <Typography variant="h6" gutterBottom>
            4. Data Sharing and Selling
          </Typography>
          <Typography paragraph>
            We treat your privacy with the utmost respect. <strong>We do not sell, trade, or rent
            your personal identification information to others.</strong> We do not share your data
            with third parties for marketing purposes.
          </Typography>

          <Typography variant="h6" gutterBottom>
            5. Data Security
          </Typography>
          <Typography paragraph>
            We implement appropriate data collection, storage, and processing practices and security
            measures to protect against unauthorized access, alteration, disclosure, or destruction
            of your personal information.
          </Typography>

          <Typography variant="h6" gutterBottom>
            6. Your Rights and Data Deletion
          </Typography>
          <Typography paragraph>
            You have full control over your data. You have the right to request access to the personal information we hold about you.
            Furthermore, you have the <strong>right to request the deletion</strong> of your account and all associated data at any time.
          </Typography>

          <Typography variant="h6" gutterBottom>
            7. Contact Us
          </Typography>
          <Typography paragraph>
            If you have any questions about this Privacy Policy, or if you wish to request the deletion of your account/data,
            please contact us via email at:
          </Typography>
          <Typography paragraph sx={{ fontWeight: 'bold', color: 'primary.main' }}>
            support@cyoa.cafe
          </Typography>
        </Box>
      </Paper>
    </Container>
  );
};

export default PrivacyPolicy;