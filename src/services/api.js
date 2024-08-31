// src/services/api.js
// v2.3
// Added comments counter functionality

import axios from 'axios'
import authService from './authService'

axios.defaults.withCredentials = true

const API_URL = process.env.REACT_APP_API_URL || 'https://api.cyoa.cafe'

const countComments = (comments) => {
  return comments.reduce((total, comment) => {
    // Считаем текущий комментарий
    let count = 1
    // Если у комментария есть дочерние элементы, рекурсивно считаем их
    if (comment.children && comment.children.length > 0) {
      count += countComments(comment.children)
    }
    return total + count
  }, 0)
}

export const fetchGames = async (page = 1, pageSize = 12) => {
    try {
        const response = await axios.get(`${API_URL}/api/games`, {
            params: {
                'pagination[page]': page,
                'pagination[pageSize]': pageSize,
                'populate': '*',
                'sort[0]': 'createdAt:desc'
            }
        })
        console.log('Raw response:', response.data)

        const games = await Promise.all(response.data.data.map(async game => {
            let commentCount = 0
            try {
                const commentsResponse = await axios.get(`${API_URL}/api/comments/api::game.game:${game.id}`)
                commentCount = countComments(commentsResponse.data)
            } catch (error) {
                console.error(`Error fetching comments for game ${game.id}:`, error)
            }

            return {
                id: game.id,
                title: game.attributes.Title,
                description: Array.isArray(game.attributes.Description)
                    ? game.attributes.Description[0]
                    : game.attributes.Description,
                image: game.attributes.Image?.data?.attributes?.url
                    ? `${API_URL}${game.attributes.Image.data.attributes.url}`
                    : null,
                authors: game.attributes.authors?.data?.map(author => ({
                    id: author.id,
                    name: author.attributes.Name
                })) || [],
                tags: game.attributes.tags?.data || [],
                Upvotes: game.attributes.Upvotes || [],
                commentCount: commentCount
            }
        }))

        return {
            games,
            totalCount: response.data.meta.pagination.total
        }
    } catch (error) {
        console.error('Error fetching games:', error)
        throw error
    }
}

export const fetchCommentCount = async (gameId) => {
    try {
        const response = await axios.get(`${API_URL}/api/comments/count`, {
            params: {
                'filters[game][id][$eq]': gameId,
            },
        })
        return response.data
    } catch (error) {
        console.error('Error fetching comment count:', error)
        return 0
    }
}





export const fetchGameById = async (id) => {
    try {
        const response = await axios.get(`${API_URL}/api/games/${id}?populate=*`)
        const game = response.data.data
        return {
            id: game.id,
            title: game.attributes.Title,
            description: game.attributes.Description,
            image: game.attributes.Image?.data?.attributes?.url
                ? `${API_URL}${game.attributes.Image.data.attributes.url}`
                : null,
            authors: game.attributes.authors?.data?.map(author => ({
                id: author.id,
                name: author.attributes.Name
            })) || [],
            tags: game.attributes.tags?.data || [],
            img_or_link: game.attributes.img_or_link,
            iframe_url: game.attributes.iframe_url,
            CYOA_pages: game.attributes.CYOA_pages?.data || [],
            Upvotes: game.attributes.Upvotes || []
        }
    } catch (error) {
        console.error('Error fetching game:', error)
        throw error
    }
}

export const createGame = async (formData) => {
    try {
        const response = await axios.post(`${API_URL}/api/games`, formData, {
            headers: {
                'Content-Type': 'multipart/form-data',
            }
        })

        console.log('API response:', response.data)
        return response.data
    } catch (error) {
        console.error('API error:', error.response ? error.response.data : error)
        throw error
    }
}

export const getAuthors = async () => {
    const response = await axios.get(`${API_URL}/api/authors`)
    return response.data.data
}

export const createAuthor = async (authorName) => {
    try {
        const response = await axios.post(`${API_URL}/api/authors`, {
            data: {
                Name: authorName
            }
        })
        return response.data.data
    } catch (error) {
        console.error('Error creating author:', error)
        throw error
    }
}

export const getTags = async () => {
    try {
        const firstPageResponse = await axios.get(`${API_URL}/api/tags?populate=tag_category&pagination[pageSize]=100&pagination[page]=1`)

        console.log('Tags response (first page):', firstPageResponse.data)

        const { data, meta } = firstPageResponse.data

        if (meta.pagination.pageCount > 1) {
            const remainingPages = Array.from({ length: meta.pagination.pageCount - 1 }, (_, i) => i + 2)
            const additionalResponses = await Promise.all(
                remainingPages.map(page =>
                    axios.get(`${API_URL}/api/tags?populate=tag_category&pagination[pageSize]=100&pagination[page]=${page}`)
                )
            )

            const allData = additionalResponses.reduce((acc, response) => {
                return [...acc, ...response.data.data]
            }, data)

            console.log('All tags:', allData)
            return allData
        }

        return data
    } catch (error) {
        console.error('Error fetching tags:', error)
        throw error
    }
}

export const getTagCategories = async () => {
    try {
        const response = await axios.get(`${API_URL}/api/tag-categories?populate=tags`)
        console.log('Tag categories response:', response.data)
        return response.data.data
    } catch (error) {
        console.error('Error fetching tag categories:', error)
        throw error
    }
}

export const postComment = async (gameId, content, parentId = null) => {
    try {
        const user = authService.getCurrentUser()
        const token = user ? user.jwt : null

        const commentData = {
            content,
            author: user ? user.user.id : 'anonymous',
        }

        if (parentId) {
            commentData.threadOf = parentId
        }

        const response = await axios.post(
            `${API_URL}/api/comments/api::game.game:${gameId}`,
            commentData,
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                },
            }
        )
        return response.data
    } catch (error) {
        console.error('Error posting comment:', error)
        throw error
    }
}

export const fetchComments = async (gameId) => {
    try {
        const response = await axios.get(`${API_URL}/api/comments/api::game.game:${gameId}`, {
            params: {
                'sort[createdAt]': 'desc',
                'populate[0]': 'author',
                'populate[1]': 'threadOf',
                'populate[2]': 'children.author',
                'populate[3]': 'children.children.author',
                'populate[4]': 'children.children.children.author',
            }
        })
        console.log('API response:', response.data)
        return response.data
    } catch (error) {
        console.error('Error fetching comments:', error)
        throw error
    }
}

export const editComment = async (gameId, commentId, content) => {
    try {
        const user = authService.getCurrentUser()
        const token = user ? user.jwt : null

        const response = await axios.put(
            `${API_URL}/api/comments/api::game.game:${gameId}/comment/${commentId}`,
            { content },
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                },
            }
        )
        return response.data
    } catch (error) {
        console.error('Error editing comment:', error)
        throw error
    }
}

export const deleteComment = async (gameId, commentId) => {
    try {
        const user = authService.getCurrentUser()
        const token = user ? user.jwt : null
        const authorId = user ? user.user.id : null

        if (!authorId) {
            throw new Error('User not authenticated')
        }

        if (!commentId) {
            throw new Error('Comment ID is undefined')
        }

        console.log(`Deleting comment: ${API_URL}/api/comments/api::game.game:${gameId}/comment/${commentId}?authorId=${authorId}`)

        const response = await axios.delete(
            `${API_URL}/api/comments/api::game.game:${gameId}/comment/${commentId}?authorId=${authorId}`,
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                },
            }
        )
        return response.data
    } catch (error) {
        console.error('Error deleting comment:', error)
        throw error
    }
}

export const upvoteGame = async (gameId) => {
    try {
        const user = authService.getCurrentUser()
        if (!user) {
            throw new Error('User not authenticated')
        }

        const game = await fetchGameById(gameId)
        const currentUpvotes = game.Upvotes || []

        if (!currentUpvotes.includes(user.user.username)) {
            const updatedUpvotes = [...currentUpvotes, user.user.username]

            const response = await axios.put(`${API_URL}/api/games/${gameId}`, {
                data: {
                    Upvotes: updatedUpvotes
                }
            }, {
                headers: {
                    Authorization: `Bearer ${user.jwt}`,
                },
            })

            return response.data
        } else {
            console.log('User has already upvoted this game')
            return game
        }
    } catch (error) {
        console.error('Error upvoting game:', error)
        throw error
    }
}

export const removeUpvote = async (gameId) => {
    try {
        const user = authService.getCurrentUser()
        if (!user) {
            throw new Error('User not authenticated')
        }

        const game = await fetchGameById(gameId)
        const updatedUpvotes = (game.Upvotes || []).filter(username => username !== user.user.username)

        const response = await axios.put(`${API_URL}/api/games/${gameId}`, {
            data: {
                Upvotes: updatedUpvotes
            }
        }, {
            headers: {
                Authorization: `Bearer ${user.jwt}`,
            },
        })

        return response.data
    } catch (error) {
        console.error('Error removing upvote:', error)
        throw error
    }
}