//src/components/Hosting/Hosting.tsx

import { useState, useEffect, useCallback } from 'react'
import {
  Box, Button, TextField, Typography, Card, CardContent,
  IconButton, Alert, LinearProgress, Stack, Link, Tooltip, Chip,
  Collapse, Divider, FormControlLabel, Checkbox
} from '@mui/material'
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff'
import VisibilityIcon from '@mui/icons-material/Visibility'
import CloudUploadIcon from '@mui/icons-material/CloudUpload'
import RefreshIcon from '@mui/icons-material/Refresh'
import SystemUpdateAltIcon from '@mui/icons-material/SystemUpdateAlt'
import HistoryIcon from '@mui/icons-material/History'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown'
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp'
import { pb, authedFetch } from '../../pocketbase/pocketbase'

interface VersionMeta {
  v: number
  uploaded_at: string
  size_bytes: number
  file_count: number
  note?: string
}

interface HostedGame {
  id: string
  slug: string
  title: string
  description: string
  version: number
  size_bytes: number
  file_count: number
  status: string
  url: string
  created: string
  updated: string
  versions: VersionMeta[]
}

interface Limits {
  max_games: number
  max_upload_mb: number
  daily_limit_mb: number
  daily_used_mb: number
}

const DEFAULT_LIMITS: Limits = {
  max_games: 10,
  max_upload_mb: 200,
  daily_limit_mb: 500,
  daily_used_mb: 0,
}

const darkInputSx = {
  '& .MuiOutlinedInput-root': {
    bgcolor: 'rgba(0, 0, 0, 0.2)',
  }
}

// `embedded` — компактная врезка внутри /add-next: без заголовка страницы и
// внешних отступов, логика идентична. Standalone /hosting рендерит без пропа.
export default function Hosting({ embedded = false }: { embedded?: boolean }) {
  const [games, setGames] = useState<HostedGame[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const [title, setTitle] = useState('')
  const [slug, setSlug] = useState('')
  const [description, setDescription] = useState('')
  const [file, setFile] = useState<File | null>(null)
  
  const [isHomepage, setIsHomepage] = useState(false)

  const [hostingSlug, setHostingSlug] = useState('')
  const [homepage, setHomepage] = useState('')
  const [limits, setLimits] = useState<Limits>(DEFAULT_LIMITS)
  const [expandedVersions, setExpandedVersions] = useState<Set<string>>(new Set())
  const [expandedNotes, setExpandedNotes] = useState<Set<string>>(new Set())

  const fetchGames = useCallback(async () => {
    try {
      const res = await authedFetch('/api/hosting/my-games')
      if (res.ok) {
        const data = await res.json()
        setGames(data.games || [])
        setHostingSlug(data.hosting_slug || '')
        setHomepage(data.homepage || '')
        if (data.limits) setLimits(data.limits)
      }
    } catch (e) {
      console.error(e)
    }
  }, [])

  useEffect(() => {
    if (pb.authStore.isValid) fetchGames()

    const unsub = pb.authStore.onChange(() => {
      if (pb.authStore.isValid) fetchGames()
      else {
        setGames([])
        setHostingSlug('')
        setHomepage('')
        setLimits(DEFAULT_LIMITS)
      }
    })

    return unsub
  }, [fetchGames])

  // Теперь слаг всегда жестко привязан к названию
  const handleTitleChange = (val: string) => {
    setTitle(val)
    setSlug(titleToSlug(val))
  }

  const titleToSlug = (t: string) =>
    t.toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 60)

  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!file) return
    
    const finalSlug = isHomepage ? '_home' : slug
    if (!finalSlug) {
      setError('Title must contain at least some English letters or numbers to generate a valid link.')
      return
    }

    setLoading(true)
    setError('')
    setSuccess('')

    const form = new FormData()
    form.append('title', title)
    form.append('slug', finalSlug)
    form.append('description', description)
    form.append('archive', file)

    try {
      const res = await authedFetch('/api/hosting/upload', {
        method: 'POST',
        body: form,
      })
      const data = await res.json()
      if (res.ok) {
        setSuccess(`Uploaded! ${data.url}`)
        setTitle('')
        setSlug('')
        setDescription('')
        setFile(null)
        setIsHomepage(false)
        fetchGames()
      } else {
        setError(data.error || 'Upload failed')
      }
    } catch {
      setError('Network error')
    } finally {
      setLoading(false)
    }
  }

  const handleUpdate = async (game: HostedGame) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.zip'
    input.onchange = async () => {
      const zipFile = input.files?.[0]
      if (!zipFile) return

      const note = prompt(
        `Upload v${game.version + 1} of "${game.title}"\n\nVersion note (optional):`,
        ''
      )
      if (note === null) return

      setLoading(true)
      setError('')
      setSuccess('')

      const form = new FormData()
      form.append('archive', zipFile)
      if (note.trim()) form.append('version_note', note.trim())

      try {
        const res = await authedFetch(`/api/hosting/update/${game.id}`, {
          method: 'POST',
          body: form,
        })
        const data = await res.json()
        if (res.ok) {
          setSuccess(`"${game.title}" updated to v${data.version}`)
          fetchGames()
        } else {
          setError(data.error || 'Update failed')
        }
      } catch {
        setError('Network error')
      } finally {
        setLoading(false)
      }
    }
    input.click()
  }

  const handleHide = async (game: HostedGame) => {
    if (!confirm(`Hide "${game.title}"? It will go offline, but files are saved and can be restored anytime.`)) return
    
    try {
      const res = await authedFetch(`/api/hosting/games/${game.id}`, {
        method: 'DELETE',
      })
      if (res.ok) {
        fetchGames()
        setSuccess('Game hidden')
      }
    } catch {
      setError('Failed to hide game')
    }
  }

  const handleRestore = async (game: HostedGame) => {
    setLoading(true)
    setError('')
    try {
      const res = await authedFetch(`/api/hosting/restore/${game.id}`, {
        method: 'POST',
      })
      const data = await res.json()
      if (res.ok) {
        fetchGames()
        setSuccess(`"${game.title}" is back online!`)
      } else {
        setError(data.error || 'Restore failed')
      }
    } catch {
      setError('Network error')
    } finally {
      setLoading(false)
    }
  }

  const handleSwitchVersion = async (game: HostedGame, targetVersion: number) => {
    if (targetVersion === game.version) return
    if (!confirm(
      `Switch "${game.title}" to v${targetVersion}?\n\nAll visitors will see version ${targetVersion}.`
    )) return

    setLoading(true)
    setError('')
    try {
      const res = await authedFetch(`/api/hosting/version/${game.id}`, {
        method: 'POST',
        body: JSON.stringify({ version: targetVersion }),
      })
      const data = await res.json()
      if (res.ok) {
        fetchGames()
        setSuccess(`"${game.title}" switched to v${targetVersion}`)
      } else {
        setError(data.error || 'Switch failed')
      }
    } catch {
      setError('Network error')
    } finally {
      setLoading(false)
    }
  }

  const toggleVersions = (gameId: string) => {
    setExpandedVersions(prev => {
      const next = new Set(prev)
      if (next.has(gameId)) next.delete(gameId)
      else next.add(gameId)
      return next
    })
  }

  const toggleNote = (key: string) => {
    setExpandedNotes(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const formatSize = (bytes: number) => {
    if (!bytes) return '0 B'
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
    return (bytes / 1024 / 1024).toFixed(1) + ' MB'
  }

  const formatDatetime = (iso: string) => {
    if (!iso) return ''
    const d = new Date(iso)
    return d.toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  }

  const truncateNote = (note: string, max: number) => {
    if (note.length <= max) return note
    return note.slice(0, max) + '…'
  }

  const activeCount = games.filter(g => g.status === 'active').length
  const dailyPercent = limits.daily_limit_mb > 0
    ? Math.min(100, (limits.daily_used_mb / limits.daily_limit_mb) * 100)
    : 0

  const hasHomepage = games.some(g => g.slug === '_home')

  const sortedGames = [...games].sort((a, b) => {
    if (a.slug === '_home') return -1
    if (b.slug === '_home') return 1
    return 0
  })

  if (!pb.authStore.isValid) {
    return (
      <Box sx={{ p: 4, textAlign: 'center' }}>
        <Typography variant="h5">Please log in to use hosting</Typography>
      </Box>
    )
  }

  return (
    <Box sx={{ maxWidth: 700, mx: 'auto', p: embedded ? 0 : 3 }}>
      {!embedded && <Typography variant="h4" gutterBottom>CYOA Hosting</Typography>}
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Upload a ZIP with your game files. Must contain index.html.
        Max 100 MB per upload, {limits.max_games} active games
        {' '}(need more? ask in <Link href="https://discord.gg/URn6seuvNa" target="_blank" rel="noopener" color="primary">Discord</Link>).
        {' '}Archive too big? Images are usually the culprit – shrink them fast with this{' '}
        <Link href="https://avif-cyoa-compressor.neocities.org/" target="_blank" rel="noopener" color="primary">free AVIF compressor</Link>.
      </Typography>

      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert>}
      {success && <Alert severity="success" sx={{ mb: 2 }} onClose={() => setSuccess('')}>{success}</Alert>}

      <Card sx={{ mb: 3 }}>
        <CardContent>
          <form onSubmit={handleUpload}>
            <Stack spacing={2}>
              <TextField
                label="Game Title (e.g. My Awesome Adventure)" value={title}
                onChange={e => handleTitleChange(e.target.value)}
                required fullWidth
                sx={darkInputSx}
              />
              
              {!hasHomepage && (
                <FormControlLabel
                  control={
                    <Checkbox 
                      checked={isHomepage} 
                      onChange={(e) => setIsHomepage(e.target.checked)}
                      sx={{
                        color: 'rgba(255,255,255,0.3)',
                        '&.Mui-checked': { color: 'primary.main' }
                      }}
                    />
                  }
                  label="Set as Homepage (Root URL)"
                />
              )}

              {/* Красивый вывод итоговой ссылки */}
              {title && (
                <Box sx={{ px: 1, mt: -1 }}>
                  <Typography variant="caption" color="text.secondary">
                    Game Link:{' '}
                    <Typography component="span" variant="caption" color="primary.light" sx={{ fontWeight: 'bold' }}>
                      https://{hostingSlug || '...'}.cyoa.cafe/{!isHomepage && slug ? slug + '/' : ''}
                    </Typography>
                  </Typography>
                </Box>
              )}

              <TextField
                label="Description (optional)" value={description}
                onChange={e => setDescription(e.target.value)}
                multiline rows={2} fullWidth
                sx={darkInputSx}
              />
              <Button variant="outlined" component="label" startIcon={<CloudUploadIcon />}>
                {file ? file.name : 'Choose ZIP file'}
                <input type="file" accept=".zip" hidden
                  onChange={e => setFile(e.target.files?.[0] || null)} />
              </Button>
              {loading && <LinearProgress />}
              <Button type="submit" variant="contained" color="primary"
                disabled={loading || !file || !title || (!isHomepage && !slug)}>
                Upload
              </Button>
            </Stack>
          </form>
        </CardContent>
      </Card>

      {homepage && (
        <Typography variant="body2" sx={{ mb: 2 }}>
          Your page: <Link href={homepage} target="_blank">{homepage}</Link>
        </Typography>
      )}

      {limits.daily_used_mb > 0 && (
        <Box sx={{ mb: 2 }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
            <Typography variant="caption" color="text.secondary">
              Uploaded today
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {limits.daily_used_mb.toFixed(1)} / {limits.daily_limit_mb} MB
            </Typography>
          </Box>
          <LinearProgress
            variant="determinate"
            value={dailyPercent}
            sx={{
              height: 4, borderRadius: 2,
              bgcolor: 'action.hover',
              '& .MuiLinearProgress-bar': {
                bgcolor: dailyPercent > 80 ? 'warning.main' : 'primary.main',
              },
            }}
          />
        </Box>
      )}

      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
        <Typography variant="h6">
          My Games ({activeCount}/{limits.max_games} active)
        </Typography>
        <IconButton onClick={fetchGames}><RefreshIcon /></IconButton>
      </Box>

      {sortedGames.map(game => {
        const isExpanded = expandedVersions.has(game.id)
        const versions = [...(game.versions || [])].sort((a, b) => b.v - a.v)
        const hasVersions = versions.length > 1
        const isHomeGame = game.slug === '_home'

        return (
          <Card key={game.id} sx={{
            mb: 1.5,
            opacity: game.status === 'blocked' ? 0.4 : 1,
            borderLeft: game.status === 'hidden' ? '3px solid #f44336'
              : game.status === 'blocked' ? '3px solid #d32f2f'
              : '3px solid transparent',
          }}>
            <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>

              <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Box sx={{ minWidth: 0, flex: 1 }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                    <Link href={game.url} target="_blank" underline="hover" sx={{
                      color: game.status !== 'active' ? 'text.disabled' : 'inherit',
                      fontWeight: 600, fontSize: '1.05em',
                    }}>
                      {game.title}
                    </Link>
                    {isHomeGame && (
                      <Chip label="Homepage" size="small" color="primary" variant="outlined" />
                    )}
                    {game.status === 'hidden' && (
                      <Chip label="hidden" size="small" color="error" variant="outlined" />
                    )}
                    {game.status === 'blocked' && (
                      <Chip label="blocked" size="small" color="error" variant="outlined" />
                    )}
                  </Box>
                  <Typography variant="caption" display="block" color="text.secondary" sx={{ mt: 0.3 }}>
                    v{game.version}
                    {versions.length > 1 && ` (${versions.length} versions)`}
                    {' · '}{formatSize(game.size_bytes)} · {game.file_count} files
                  </Typography>
                </Box>

                <Box sx={{ display: 'flex', gap: 0.5, ml: 1, flexShrink: 0 }}>
                  {hasVersions && (
                    <Tooltip title={isExpanded ? 'Hide versions' : 'Version history'}>
                      <IconButton size="small" onClick={() => toggleVersions(game.id)}
                        sx={{ color: isExpanded ? 'primary.main' : 'text.secondary' }}>
                        <HistoryIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  )}

                  {game.status === 'active' && (
                    <>
                      <Tooltip title="Upload new version">
                        <IconButton color="primary" onClick={() => handleUpdate(game)}
                          size="small" disabled={loading}>
                          <SystemUpdateAltIcon />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="Hide">
                        <IconButton color="success" onClick={() => handleHide(game)} size="small">
                          <VisibilityIcon />
                        </IconButton>
                      </Tooltip>
                    </>
                  )}

                  {game.status === 'hidden' && (
                    <>
                      <Tooltip title="Upload new version">
                        <IconButton color="primary" onClick={() => handleUpdate(game)}
                          size="small" disabled={loading}>
                          <SystemUpdateAltIcon />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="Restore">
                        <IconButton color="error" onClick={() => handleRestore(game)}
                          size="small" disabled={loading}>
                          <VisibilityOffIcon />
                        </IconButton>
                      </Tooltip>
                    </>
                  )}
                </Box>
              </Box>

              <Collapse in={isExpanded}>
                <Divider sx={{ my: 1.5 }} />
                <Typography variant="caption" color="text.secondary"
                  sx={{ mb: 1, display: 'block', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                  Version History
                </Typography>
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                  {versions.map(ver => {
                    const isCurrent = ver.v === game.version
                    const noteKey = `${game.id}-v${ver.v}`
                    const hasNote = !!ver.note
                    const isNoteExpanded = expandedNotes.has(noteKey)
                    const NOTE_PREVIEW_LEN = 60

                    return (
                      <Box key={ver.v} sx={{
                        px: 1.5, py: 1, borderRadius: 1,
                        bgcolor: isCurrent ? 'action.selected' : 'transparent',
                        border: '1px solid',
                        borderColor: isCurrent ? 'primary.main' : 'divider',
                        transition: 'all 0.15s',
                        '&:hover': { bgcolor: isCurrent ? 'action.selected' : 'action.hover' },
                      }}>
                        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0, flex: 1 }}>
                            {isCurrent && (
                              <CheckCircleIcon sx={{ fontSize: 16, color: 'primary.main', flexShrink: 0 }} />
                            )}
                            <Box sx={{ minWidth: 0 }}>
                              <Typography variant="body2" sx={{
                                fontWeight: isCurrent ? 600 : 400,
                                color: isCurrent ? 'primary.main' : 'text.primary',
                              }}>
                                v{ver.v}{isCurrent && ' (active)'}
                              </Typography>
                              <Typography variant="caption" color="text.secondary">
                                {formatDatetime(ver.uploaded_at)} · {formatSize(ver.size_bytes)} · {ver.file_count} files
                              </Typography>

                              {hasNote && (
                                <Box sx={{ mt: 0.5 }}>
                                  <Typography variant="caption" sx={{
                                    color: 'text.secondary', fontStyle: 'italic', display: 'block', lineHeight: 1.4,
                                    whiteSpace: isNoteExpanded ? 'pre-wrap' : 'nowrap',
                                    overflow: isNoteExpanded ? 'visible' : 'hidden',
                                    textOverflow: isNoteExpanded ? 'clip' : 'ellipsis',
                                  }}>
                                    {isNoteExpanded ? ver.note : truncateNote(ver.note!, NOTE_PREVIEW_LEN)}
                                  </Typography>
                                  {ver.note!.length > NOTE_PREVIEW_LEN && (
                                    <Typography variant="caption" onClick={() => toggleNote(noteKey)} sx={{
                                      color: 'primary.main', cursor: 'pointer', userSelect: 'none',
                                      display: 'inline-flex', alignItems: 'center', gap: 0.3,
                                      '&:hover': { textDecoration: 'underline' },
                                    }}>
                                      {isNoteExpanded
                                        ? <>less <KeyboardArrowUpIcon sx={{ fontSize: 14 }} /></>
                                        : <>more <KeyboardArrowDownIcon sx={{ fontSize: 14 }} /></>}
                                    </Typography>
                                  )}
                                </Box>
                              )}
                            </Box>
                          </Box>

                          {!isCurrent && (
                            <Tooltip title={`Switch to v${ver.v}`}>
                              <Button size="small" variant="outlined"
                                onClick={() => handleSwitchVersion(game, ver.v)}
                                disabled={loading || game.status === 'blocked'}
                                sx={{ ml: 1, minWidth: 'auto', px: 1.5, textTransform: 'none', fontSize: '0.75rem', flexShrink: 0 }}>
                                Activate
                              </Button>
                            </Tooltip>
                          )}
                        </Box>
                      </Box>
                    )
                  })}
                </Box>
              </Collapse>
            </CardContent>
          </Card>
        )
      })}

      {games.length === 0 && (
        <Typography color="text.secondary" textAlign="center" sx={{ py: 3 }}>
          No games uploaded yet
        </Typography>
      )}
    </Box>
  )
}