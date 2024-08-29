// src/components/CyoaPage/SimpleComments.tsx
// v3.36
// Fixed TypeScript errors and improved type safety

import React, { useState, useEffect } from 'react'
import { Box, Typography, useTheme, Theme } from '@mui/material'
import { CommentSection } from 'react-comments-section'
import 'react-comments-section/dist/index.css'
import { fetchComments, postComment, editComment, deleteComment } from '../../services/api'
import authService from '../../services/authService'

interface SimpleCommentsProps {
    gameId: string;
}

interface Comment {
    id: number;
    author?: {
        id: number;
        name: string;
    };
    content: string;
    children?: Comment[];
}

interface FormattedComment {
    userId: string;
    comId: string;
    fullName: string;
    avatarUrl: string;
    text: string;
    replies: FormattedComment[];
    parentId: string | null;
}

interface CustomTheme extends Theme {
    custom?: {
        comments?: {
            backgroundColor?: string;
            borderRadius?: string;
            color?: string;
        };
    };
}

const SimpleComments: React.FC<SimpleCommentsProps> = ({ gameId }) => {
    const [comments, setComments] = useState<FormattedComment[]>([])
    const [user, setUser] = useState<any>(null)
    const theme = useTheme<CustomTheme>()

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

    const formatComments = (commentsData: Comment[]): FormattedComment[] => {
        const flattenComments = (comment: Comment, parentId: string | null = null, depth = 0): FormattedComment[] => {
            const formattedComment: FormattedComment = {
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

    const handleSubmitComment = async (data: { text: string; parentId?: string }) => {
        try {
            await postComment(gameId, data.text, data.parentId || null)
            await loadComments()
        } catch (error) {
            console.error('Error posting comment:', error)
        }
    }

    const handleEditComment = async (data: { comId: string; text: string }) => {
        try {
            await editComment(gameId, data.comId, data.text)
            await loadComments()
        } catch (error) {
            console.error('Error editing comment:', error)
        }
    }

    const handleDeleteComment = async (data: { comId: string }) => {
        try {
            await deleteComment(gameId, data.comId)
            await loadComments()
        } catch (error) {
            console.error('Error deleting comment:', error)
        }
    }
    const inputStyle = {
        color: '#dcdcdc', 
    };

    return (
        <Box
            sx={{
                mt: 4,
                p: 2,
                backgroundColor: theme.custom?.comments?.backgroundColor,
                borderRadius: theme.custom?.comments?.borderRadius,
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
                    onSubmitAction={(data: { text: string; parentId?: string }) => handleSubmitComment(data)}
                    onReplyAction={(data: { text: string; repliedToCommentId: string }) =>
                        handleSubmitComment({ text: data.text, parentId: data.repliedToCommentId })}
                    onEditAction={handleEditComment}
                    onDeleteAction={handleDeleteComment}
                    hrStyle={{ border: 'none' }}
                    currentData={(data: any) => console.log('Current data:', data)}
                    removeEmoji={true}
                    submitBtnStyle={{ border: '1px solid gray', backgroundColor: 'gray', color: 'black' }}
                    cancelBtnStyle={{ border: '1px solid gray', backgroundColor: 'gray', color: 'black' }}
                    titleStyle={{ color: 'gray' }}
                    replyInputStyle={{ color: theme.palette.text.primary }}
                    formStyle={{ backgroundColor: '#1e1e1e' }}
                    inputStyle={inputStyle}
                />
            ) : (
                <Typography sx={{ color: theme.custom?.comments?.color }}>Please log in to post comments.</Typography>
            )}
        </Box>
    )
}
export default SimpleComments
