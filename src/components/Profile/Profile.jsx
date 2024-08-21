// src/components/Profile/Profile.jsx
import React from 'react';
import { Container, Typography, Paper, Box, List, ListItem, ListItemIcon, ListItemText } from '@mui/material';
import { styled } from '@mui/material/styles';
import PersonIcon from '@mui/icons-material/Person';
import SettingsIcon from '@mui/icons-material/Settings';
import FavoriteIcon from '@mui/icons-material/Favorite';
import StarIcon from '@mui/icons-material/Star';

const StyledPaper = styled(Paper)(({ theme }) => ({
    padding: theme.spacing(3),
    margin: theme.spacing(3, 0),
    backgroundColor: '#1e1e1e',
    color: '#e0e0e0',
}));

const Profile = () => {
    return (
        <Container maxWidth="md">
            <Typography variant="h4" component="h1" gutterBottom sx={{ mt: 4, color: '#e0e0e0' }}>
                User Profile
            </Typography>
            <StyledPaper elevation={3}>
                <Typography variant="h6" gutterBottom>
                    Coming Soon!
                </Typography>
                <Typography variant="body1" paragraph>
                    The profile page is still under development!<br />
                    Huh... well... <br />
                    I mean, I haven't even started yet, but here's what you can expect in the future:
                </Typography>
                <List>
                    {[
                        { icon: <PersonIcon />, text: "Personal information management, changing email and passwords and all that." },
                        { icon: <SettingsIcon />, text: "View settings and blocked tags like scat." },
                        { icon: <FavoriteIcon />, text: "List of your favorite CYOA's." },
                        { icon: <StarIcon />, text: "Achievements, awards and other nice little things!" },
                    ].map((item, index) => (
                        <ListItem key={index}>
                            <ListItemIcon sx={{ color: '#e0e0e0' }}>
                                {item.icon}
                            </ListItemIcon>
                            <ListItemText primary={item.text} />
                        </ListItem>
                    ))}
                </List>
                <Box mt={2}>
                    <Typography variant="body1" color="textSecondary">
                        Stay tuned for updates!
                    </Typography>
                </Box>
            </StyledPaper>
        </Container>
    );
};

export default Profile;