// src/components/CyoaPage/SimpleComments.jsx
// v3.34
// Changes: Updated button color and removed emoji

import React, { useState, useEffect } from 'react'
import { Box, Typography, useTheme } from '@mui/material'
import { CommentSection } from 'react-comments-section'
import 'react-comments-section/dist/index.css'
import { fetchComments, postComment, editComment, deleteComment } from '../../services/api'
import authService from '../../services/authService'

const SimpleComments = ({ gameId }) => {
    const [comments, setComments] = useState([])
    const [user, setUser] = useState(null)
    const theme = useTheme()

    useEffect(() => {
        loadComments()
        const currentUser = authService.getCurrentUser()
        setUser(currentUser)
    }, [gameId])

    const loadComments = async () => {
        try {
            const fetchedComments = await fetchComments(gameId)
            const formattedComments = formatComments(fetchedComments)
            setComments(formattedComments)
        } catch (error) {
            console.error('Error loading comments:', error)
        }
    }

    const formatComments = (commentsData) => {
        const flattenComments = (comment, parentId = null, depth = 0) => {
            const formattedComment = {
                userId: comment.author?.id?.toString() || 'anonymous',
                comId: comment.id.toString(),
                fullName: comment.author?.name || 'Anonymous',
                avatarUrl: `https://ui-avatars.com/api/?name=${encodeURIComponent(
                    comment.author?.name || 'Anonymous',
                )}&background=1a1a1a&color=fc3447`,
                text: comment.content,
                replies: [],
                parentId: parentId,
            }

            let result = [formattedComment]

            if (comment.children && comment.children.length > 0) {
                comment.children.forEach((childComment) => {
                    if (depth === 0) {
                        formattedComment.replies.push(
                            ...flattenComments(childComment, formattedComment.comId, depth + 1),
                        )
                    } else {
                        result.push(
                            ...flattenComments(
                                childComment,
                                depth === 1 ? formattedComment.comId : parentId,
                                depth + 1,
                            ),
                        )
                    }
                })
            }

            return result
        }

        return commentsData.flatMap((comment) => flattenComments(comment))
    }

    const handleSubmitComment = async (data, parentCommentId = null) => {
        try {
            await postComment(gameId, data.text, parentCommentId)
            await loadComments()
        } catch (error) {
            console.error('Error posting comment:', error)
        }
    }

    const handleEditComment = async (data) => {
        try {
            await editComment(gameId, data.comId, data.text)
            await loadComments()
        } catch (error) {
            console.error('Error editing comment:', error)
        }
    }

    const handleDeleteComment = async (data) => {
        try {
            await deleteComment(gameId, data.comId)
            await loadComments()
        } catch (error) {
            console.error('Error deleting comment:', error)
        }
    }

    return (
        <Box
            sx={{
                mt: 4,
                p: 2,
                backgroundColor: theme.custom.comments.backgroundColor,
                borderRadius: theme.custom.comments.borderRadius,
            }}
        >
            {user ? (
                <CommentSection
                    currentUser={{
                        currentUserId: user.user.id.toString(),
                        currentUserImg: `https://ui-avatars.com/api/?name=${encodeURIComponent(
                            user.user.username,
                        )}&background=1a1a1a&color=fc3447`,
                        currentUserFullName: user.user.username,
                    }}
                    commentData={comments}
                    onSubmitAction={(data) => handleSubmitComment(data, data.parentId)}
                    onReplyAction={(data) => handleSubmitComment(data, data.repliedToCommentId)}
                    onEditAction={handleEditComment}
                    onDeleteAction={handleDeleteComment}
                    hrStyle={{ border: 'none' }}
                    currentData={(data) => console.log('Current data:', data)}
                    removeEmoji={true}
                    submitBtnStyle={{ border: '1px solid gray', backgroundColor: 'gray', color: 'black' }}
                    cancelBtnStyle={{ border: '1px solid gray', backgroundColor: 'gray', color: 'black' }}
                    titleStyle={{ color: 'gray' }}
                    replyInputStyle={{ color: 'theme.palette.text.primary' }}
                    formStyle={{ backgroundColor: '#1e1e1e' }}
                />
            ) : (
                <Typography sx={{ color: theme.custom.comments.color }}>Please log in to post comments.</Typography>
            )}
        </Box>
    )
}

export default SimpleComments
