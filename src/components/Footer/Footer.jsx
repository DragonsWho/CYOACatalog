// src/components/Footer/Footer.jsx
// Version: 1.4.0
// Description: Further adjusted Footer component to improve logo spacing and alignment

import React from 'react';
import { Box, Container, Typography, Link as MuiLink } from '@mui/material';
import { styled } from '@mui/system';
import BoostyIcon from './BoostyIcon';
import PatreonIcon from './PatreonIcon';
import PatreonWordmark from './PatreonWordmark';

const StyledFooter = styled('footer')(({ theme }) => ({
    backgroundColor: theme.palette.primary.main,
    color: theme.palette.primary.contrastText,
    padding: theme.spacing(0.5, 0), // Еще немного уменьшили вертикальный padding
    marginTop: 'auto',
}));

const SupportLink = styled(MuiLink)(({ theme }) => ({
    display: 'inline-flex',
    alignItems: 'center',
    color: theme.palette.primary.contrastText,
    textDecoration: 'none',
    marginLeft: theme.spacing(0.5),
    marginRight: theme.spacing(0.5),
    '&:hover': {
        textDecoration: 'underline',
    },
}));

const IconWrapper = styled('span')({
    display: 'inline-flex',
    alignItems: 'center',
});

const Footer = () => {
    return (
        <StyledFooter>
            <Container maxWidth="lg">
                <Box sx={{
                    display: 'flex',
                    justifyContent: 'center',
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    '& > *': { my: 1 } 
                }}>
                    <Typography variant="body1" component="span" sx={{ mr: 0.5 }}>
                        Made by Dragon's Whore! To keep this project from going to hell, please support it on
                    </Typography>
                    <SupportLink href="https://boosty.to/dragonswhore" target="_blank" rel="noopener noreferrer">
                        <IconWrapper>
                            <BoostyIcon sx={{ width: 100, height: 'auto', ml: -1  }} />
                        </IconWrapper>
                    </SupportLink>
                    <Typography variant="body1" component="span" sx={{ mx: 0.5, ml: -0.7 }}>
                        or
                    </Typography>
                    <SupportLink href="https://www.patreon.com/DragonsWhore" target="_blank" rel="noopener noreferrer">
                        <IconWrapper sx={{ display: 'flex', alignItems: 'center' }}>
                            <PatreonIcon sx={{ width: 23, height: 'auto' }} />
                            <PatreonWordmark sx={{ width: 100, height: 'auto', ml: -0.5 }} />
                        </IconWrapper>
                    </SupportLink>
                </Box>
            </Container>
        </StyledFooter>
    );
};

export default Footer;