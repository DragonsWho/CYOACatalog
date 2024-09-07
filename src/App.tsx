// src/App.tsx
// Version: 1.6.0
// Description: Main application component with routing, authentication state management, Footer, and cache version check

import React, { useState, useEffect } from 'react'
import { Routes, Route, useNavigate } from 'react-router-dom'
import { Container, Box } from '@mui/material'
import Header from './components/Header/Header'
import Footer from './components/Footer/Footer'
import GameList from './components/GameList'
import GameDetails from './components/CyoaPage/GameDetails'
import CreateGameForm from './components/Add/CreateGameForm'
import Login from './components/Header/Login'
import Profile from './components/Profile/Profile'
import AuthCallback from './components/AuthCallback'
import SearchPage from './components/Search/SearchPage'
import authService from './services/authService'
import { fetchAllGames } from './services/searchService'
import { clearCache } from './services/cacheService'

  

interface User {
    id: string
    username: string
    email: string
    // Add other user properties as needed
}

const App: React.FC = () => {
    const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false)
    const [user, setUser] = useState<User | null>(null)
    const navigate = useNavigate()

    useEffect(() => {
        const checkAuth = () => {
            const authStatus = authService.isAuthenticated()
            setIsAuthenticated(authStatus)
            if (authStatus) {
                setUser(authService.getCurrentUser().user)
            }
        }

        checkAuth()

        // Check and update cache
        const checkAndUpdateCache = async () => {
            try {
                await fetchAllGames() // This will clear the cache if the version is outdated
            } catch (error) {
                console.error('Error checking cache version:', error)
                clearCache() // Clear cache on error to ensure fresh data on next load
            }
        }

        checkAndUpdateCache()
    }, [])

    const handleLoginSuccess = (userData: { user: User }) => {
        setIsAuthenticated(true)
        setUser(userData.user)
    }

    const handleLogout = () => {
        authService.logout()
        setIsAuthenticated(false)
        setUser(null)
        navigate('/')
    }

    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', width: '100%' }}>
            <Header
                isAuthenticated={isAuthenticated}
                user={user}
                onLogout={handleLogout}
                onLoginSuccess={handleLoginSuccess}
            />
            <Container
                component="main"
                maxWidth={false}
                sx={{ mt: 4, mb: 4, flex: 1, display: 'flex', flexDirection: 'column' }}
            >
                <Routes>
                    <Route path="/" element={<GameList />} />
                    <Route path="/game/:id" element={<GameDetails />} />
                    <Route
                        path="/create"
                        element={isAuthenticated ? <CreateGameForm /> : <Login onLoginSuccess={handleLoginSuccess} />}
                    />
                    <Route path="/login" element={<Login onLoginSuccess={handleLoginSuccess} />} />
                    <Route path="/profile" element={<Profile />} />
                    <Route path="/auth-callback" element={<AuthCallback onLoginSuccess={handleLoginSuccess} />} />
                    <Route path="/search" element={<SearchPage />} />
                </Routes>
            </Container>
            <Footer />
        </Box>
    )
}




export default App