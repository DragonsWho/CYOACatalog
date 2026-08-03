import React, { useState, useEffect, useRef, useCallback } from 'react';
import { thinScrollbar } from '../../styles/scrollbar';
import { 
  Box, 
  Typography, 
  IconButton, 
  TextField, 
  Button, 
  Stack, 
  Paper,
  Tooltip,
  useMediaQuery,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { useVisualViewportScale } from '../../utils/useVisualViewportScale';
import { 
  Add as AddIcon, 
  Remove as RemoveIcon, 
  DeleteOutline as DeleteIcon, 
  Save as SaveIcon,
  Error as ErrorIcon,
  Calculate as CalculateIcon,
  Close as CloseIcon,
  DragIndicator as DragIcon,
  SouthEast as ResizeIcon,
  Casino as DiceIcon
} from '@mui/icons-material';

// --- TYPES ---
interface Counter {
  id: number;
  name: string;
  value: number;
}

interface GameState {
  counters: Counter[];
  notes: string;
}

interface CyoaCompanionDrawerProps {
  gameId: string;
}

export default function CyoaCompanionDrawer({ gameId }: CyoaCompanionDrawerProps) {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));
  // Пока полотно увеличено пинч-зумом, прячем плавающую кнопку Calc, чтобы не
  // раздувалась поверх контента.
  const isZoomed = useVisualViewportScale() > 1.05;

  // --- STATE ---
  const [isOpen, setIsOpen] = useState(false);
  const [counters, setCounters] = useState<Counter[]>([]);
  const [notes, setNotes] = useState('');
  const [hasError, setHasError] = useState(false);
  const [deleteId, setDeleteId] = useState<number | null>(null);

  // Dice roller
  const [diceFormula, setDiceFormula] = useState('20');
  const [lastRoll, setLastRoll] = useState<number | null>(null);
  const [lastBreakdown, setLastBreakdown] = useState('');
  const [isRolling, setIsRolling] = useState(false);
  const [rollHistory, setRollHistory] = useState<number[]>([]);
  const rollIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Desktop State: Position (Top/Left coordinates) and Size
  // Инициализируем позицию "где-то справа внизу", но в координатах Top/Left
  const [position, setPosition] = useState(() => {
    if (typeof window !== 'undefined') {
      return { 
        top: Math.max(50, window.innerHeight - 507), // ~600px снизу
        left: Math.max(50, window.innerWidth - 340)  // ~450px справа
      };
    }
    return { top: 100, left: 100 };
  });
  
  const [size, setSize] = useState({ width: 320, height: 500 });

  // Refs for Dragging/Resizing
  const isDragging = useRef(false);
  const dragOffset = useRef({ x: 0, y: 0 }); // Смещение курсора относительно угла окна

  const isResizing = useRef(false);
  const resizeStart = useRef({ x: 0, y: 0, w: 0, h: 0 });

  // Refs other
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const touchStartX = useRef<number>(0);
  const drawerRef = useRef<HTMLDivElement>(null);

  // --- 1. LOAD DATA ---
  useEffect(() => {
    const storageKey = `cyoa_save_${gameId}`;
    try {
      const savedData = localStorage.getItem(storageKey);
      if (savedData) {
        const parsed: GameState = JSON.parse(savedData);
        setCounters(parsed.counters || []);
        setNotes(parsed.notes || '');
      } else {
        setCounters([{ id: Date.now(), name: 'Points', value: 100 }]);
      }
    } catch (e) {
      console.error("Load error", e);
    }
  }, [gameId]);

  // --- 2. SAVE LOGIC ---
  const triggerSave = useCallback(() => {
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(() => {
      try {
        const stateToSave: GameState = { counters, notes };
        localStorage.setItem(`cyoa_save_${gameId}`, JSON.stringify(stateToSave));
        setHasError(false);
      } catch (e) {
        console.error(e);
        setHasError(true);
      }
    }, 1000); 
  }, [counters, notes, gameId]);

  const isFirstRender = useRef(true);
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    triggerSave();
  }, [counters, notes, triggerSave]);

  // --- 3. ACTIONS ---
  const addCounter = () => setCounters(prev => [...prev, { id: Date.now(), name: 'New Stat', value: 0 }]);
  const confirmDelete = (id: number) => setDeleteId(id);
  const executeDelete = () => {
    if (deleteId !== null) {
      setCounters(prev => prev.filter(c => c.id !== deleteId));
      setDeleteId(null);
    }
  };
  const updateVal = (id: number, delta: number) => {
    setCounters(prev => prev.map(c => c.id === id ? { ...c, value: c.value + delta } : c));
  };
  const updateName = (id: number, newName: string) => {
    setCounters(prev => prev.map(c => c.id === id ? { ...c, name: newName } : c));
  };

  // --- 3b. DICE ROLLER ---
  // Принимает либо голое число граней ("20"), либо стандартную запись NdM+K ("4d6+2", "d20-1").
  const parseDiceFormula = (raw: string): { count: number; sides: number; modifier: number } | null => {
    const input = raw.trim();
    if (!input) return null;
    const full = input.match(/^(\d*)d(\d+)\s*([+-]\s*\d+)?$/i);
    if (full) {
      const count = Math.max(1, Math.min(50, full[1] ? parseInt(full[1], 10) : 1));
      const sides = Math.max(2, Math.min(1000, parseInt(full[2], 10)));
      const modifier = full[3] ? parseInt(full[3].replace(/\s/g, ''), 10) : 0;
      return { count, sides, modifier };
    }
    const plain = input.match(/^(\d+)$/);
    if (plain) {
      return { count: 1, sides: Math.max(2, Math.min(1000, parseInt(plain[1], 10))), modifier: 0 };
    }
    return null;
  };

  const rollDice = () => {
    const parsed = parseDiceFormula(diceFormula);
    if (!parsed) return;
    const { count, sides, modifier } = parsed;
    if (rollIntervalRef.current) clearInterval(rollIntervalRef.current);
    setIsRolling(true);
    let ticks = 0;
    rollIntervalRef.current = setInterval(() => {
      const preview = Array.from({ length: count }, () => 1 + Math.floor(Math.random() * sides));
      setLastRoll(preview.reduce((a, b) => a + b, 0) + modifier);
      ticks += 1;
      if (ticks >= 8) {
        if (rollIntervalRef.current) clearInterval(rollIntervalRef.current);
        const rolls = Array.from({ length: count }, () => 1 + Math.floor(Math.random() * sides));
        const total = rolls.reduce((a, b) => a + b, 0) + modifier;
        setLastRoll(total);
        setLastBreakdown(
          count > 1 || modifier !== 0
            ? `${rolls.join(' + ')}${modifier ? (modifier > 0 ? ` + ${modifier}` : ` - ${-modifier}`) : ''} = ${total}`
            : ''
        );
        setRollHistory(prev => [total, ...prev].slice(0, 20));
        setIsRolling(false);
      }
    }, 60);
  };

  useEffect(() => () => {
    if (rollIntervalRef.current) clearInterval(rollIntervalRef.current);
  }, []);

  // --- 4. DRAG LOGIC (Move Window) ---
  const handleDragStart = (e: React.MouseEvent) => {
    if (isMobile) return;
    if ((e.target as HTMLElement).closest('button')) return;

    isDragging.current = true;
    // Вычисляем, где именно мы схватили окно относительно его top/left
    dragOffset.current = {
      x: e.clientX - position.left,
      y: e.clientY - position.top
    };
    
    document.addEventListener('mousemove', handleDragMove);
    document.addEventListener('mouseup', handleDragEnd);
  };

  const handleDragMove = (e: MouseEvent) => {
    if (!isDragging.current) return;
    // Новая позиция = Текущая мышь - Смещение захвата
    setPosition({
      left: e.clientX - dragOffset.current.x,
      top: e.clientY - dragOffset.current.y
    });
  };

  const handleDragEnd = () => {
    isDragging.current = false;
    document.removeEventListener('mousemove', handleDragMove);
    document.removeEventListener('mouseup', handleDragEnd);
  };

  // --- 5. RESIZE LOGIC (Resize Window) ---
  const handleResizeStart = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isMobile) return;
    
    isResizing.current = true;
    resizeStart.current = { 
      x: e.clientX, 
      y: e.clientY, 
      w: size.width, 
      h: size.height 
    };
    
    document.addEventListener('mousemove', handleResizeMove);
    document.addEventListener('mouseup', handleResizeEnd);
  };

  const handleResizeMove = (e: MouseEvent) => {
    if (!isResizing.current) return;
    const deltaX = e.clientX - resizeStart.current.x;
    const deltaY = e.clientY - resizeStart.current.y;
    
    // Просто меняем ширину/высоту. Так как позиция задана через Top/Left,
    // окно будет расти вправо и вниз.
    setSize({
      width: Math.max(300, resizeStart.current.w + deltaX),
      height: Math.max(400, resizeStart.current.h + deltaY)
    });
  };

  const handleResizeEnd = () => {
    isResizing.current = false;
    document.removeEventListener('mousemove', handleResizeMove);
    document.removeEventListener('mouseup', handleResizeEnd);
  };

  // --- 6. SWIPE LOGIC ---
  useEffect(() => {
    if (!isMobile) return;
    const handleTouchStart = (e: TouchEvent) => {
      // Мультитач (пинч-зум) — не свайп открытия. Помечаем -1 как «игнорировать».
      if (e.touches.length > 1) { touchStartX.current = -1; return; }
      touchStartX.current = e.changedTouches[0].screenX;
    };
    const handleTouchEnd = (e: TouchEvent) => {
      if (touchStartX.current < 0) return;
      // При активном зуме горизонтальное движение — это панорамирование полотна,
      // а не свайп; иначе калькулятор открывался бы случайно во время чтения.
      if (window.visualViewport && window.visualViewport.scale > 1.05) return;
      const diff = touchStartX.current - e.changedTouches[0].screenX;
      if (diff > 70) setIsOpen(true);
      if (diff < -70) setIsOpen(false);
    };
    document.addEventListener('touchstart', handleTouchStart, { passive: true });
    document.addEventListener('touchend', handleTouchEnd, { passive: true });
    return () => {
      document.removeEventListener('touchstart', handleTouchStart);
      document.removeEventListener('touchend', handleTouchEnd);
    };
  }, [isMobile]);


  // --- RENDER CONTENT ---
  const renderContent = () => (
    <>
      <Stack 
        direction="row" 
        justifyContent="space-between" 
        alignItems="center" 
        sx={{ mb: 1, cursor: isMobile ? 'default' : 'grab', flexShrink: 0 }}
        onMouseDown={handleDragStart}
      >
        <Stack direction="row" alignItems="center" gap={1}>
           {!isMobile && <DragIndicator sx={{ color: 'rgba(255,255,255,0.3)', fontSize: 20 }} />}
           <Typography variant="subtitle1" sx={{ fontWeight: 'bold', color: theme.palette.text.primary, userSelect: 'none' }}>
             CYOA Calculator
           </Typography>
        </Stack>
        <Stack direction="row" alignItems="center" gap={1}>
          <Tooltip title={hasError ? "Error saving data!" : "Game saved locally!"}>
            <Box sx={{ display: 'flex', alignItems: 'center', opacity: 0.8 }}>
              {hasError ? <ErrorIcon color="error" fontSize="small" /> : <SaveIcon color="success" fontSize="small" />}
            </Box>
          </Tooltip>
          <IconButton size="small" onClick={() => setIsOpen(false)}><CloseIcon fontSize="small" /></IconButton>
        </Stack>
      </Stack>

      <Box sx={{
        maxHeight: isMobile ? '40vh' : '50%',
        overflowY: 'auto', mb: 2, pr: 0.5, flexShrink: 0,
        ...thinScrollbar,
      }}>
        <Stack spacing={1}>
          {counters.map((counter) => (
            <Paper key={counter.id} elevation={0} sx={{ p: '6px', display: 'flex', alignItems: 'center', gap: 0.5, bgcolor: 'rgba(255,255,255,0.05)' }}>
              <TextField
                variant="standard" value={counter.name} onChange={(e) => updateName(counter.id, e.target.value)}
                placeholder="Name" InputProps={{ disableUnderline: true, style: { fontSize: '0.9rem' } }} sx={{ flexGrow: 1, minWidth: '60px' }}
              />
              <Stack direction="row" alignItems="center" sx={{ bgcolor: 'rgba(0,0,0,0.2)', borderRadius: 1, p: '2px' }}>
                <Button size="small" sx={{ minWidth: '25px', px: 0, color: 'rgba(255,255,255,0.7)' }} onClick={() => updateVal(counter.id, -5)}>-5</Button>
                <IconButton size="small" onClick={() => updateVal(counter.id, -1)}><RemoveIcon fontSize="small" /></IconButton>
                <Typography sx={{ minWidth: '35px', textAlign: 'center', fontWeight: 'bold', fontSize: '1rem' }}>{counter.value}</Typography>
                <IconButton size="small" onClick={() => updateVal(counter.id, 1)}><AddIcon fontSize="small" /></IconButton>
                <Button size="small" sx={{ minWidth: '25px', px: 0, color: 'rgba(255,255,255,0.7)' }} onClick={() => updateVal(counter.id, 5)}>+5</Button>
              </Stack>
              <Box sx={{ ml: 1, pl: 0.5 }}>
                 <IconButton size="small" color="error" onClick={() => confirmDelete(counter.id)}><DeleteIcon fontSize="small" /></IconButton>
              </Box>
            </Paper>
          ))}
        </Stack>
      </Box>

      <Button variant="outlined" size="small" startIcon={<AddIcon />} onClick={addCounter} fullWidth sx={{ mb: 2, borderColor: 'rgba(255,255,255,0.2)', color: 'text.secondary', flexShrink: 0 }}>Add Row</Button>

      <Paper elevation={0} sx={{ p: '4px 6px', mb: 2, display: 'flex', alignItems: 'center', gap: 0.75, bgcolor: 'rgba(255,255,255,0.05)', flexShrink: 0 }}>
        <TextField
          variant="standard"
          type="text"
          value={diceFormula}
          onChange={(e) => setDiceFormula(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') rollDice(); }}
          placeholder="d20"
          InputProps={{
            disableUnderline: true,
            style: { fontSize: '0.85rem', fontWeight: 'bold' }
          }}
          sx={{ width: '68px', bgcolor: 'rgba(0,0,0,0.2)', borderRadius: 1, px: '6px' }}
          inputProps={{ style: { textAlign: 'center', padding: '4px 0' } }}
        />
        <IconButton size="small" color="primary" onClick={rollDice} disabled={isRolling} sx={{ ml: 0.5 }}>
          <DiceIcon fontSize="small" />
        </IconButton>
        <Tooltip title={lastBreakdown}>
          {lastRoll === null ? (
            <Typography variant="caption" noWrap sx={{ color: 'text.secondary' }}>Roll Dice</Typography>
          ) : (
            <Box sx={{
              minWidth: '28px', textAlign: 'center', fontWeight: 'bold', fontSize: '1.1rem',
              color: isRolling ? 'text.secondary' : theme.palette.primary.main,
              transition: 'color 0.15s', flexShrink: 0
            }}>
              {lastRoll}
            </Box>
          )}
        </Tooltip>
        {rollHistory.length > 1 && (
          <Typography variant="caption" noWrap sx={{ color: 'rgba(255,255,255,0.35)', flexGrow: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {rollHistory.slice(1).join(' ')}
          </Typography>
        )}
      </Paper>

      <TextField
        multiline
        placeholder={`Notes, inventory, perks...\nRoll dice above – try 20, 4d6+2, d100-5\n(Auto-saved to browser storage)`}
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        variant="outlined"
        sx={{ 
          flexGrow: 1, width: '100%', bgcolor: 'rgba(0,0,0,0.2)',
          '& .MuiInputBase-root': { height: '100%', alignItems: 'flex-start', color: 'text.secondary' },
          '& .MuiOutlinedInput-notchedOutline': { border: 'none' }
        }}
      />
      
      {!isMobile && (
        <Box onMouseDown={handleResizeStart} sx={{ position: 'absolute', bottom: 2, right: 2, cursor: 'nwse-resize', opacity: 0.5, '&:hover': { opacity: 1, color: theme.palette.primary.main } }}>
          <ResizeIcon fontSize="small" />
        </Box>
      )}
    </>
  );

  return (
    <>
      <Button
        variant="outlined"
        onClick={() => setIsOpen(!isOpen)}
        startIcon={<CalculateIcon />}
        sx={{
          position: 'fixed', bottom: 50, right: 20, zIndex: 1200,
          borderColor: '#d32f2f', borderWidth: 2, color: '#e7e7e7ee',
          bgcolor: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)',
          textTransform: 'none', fontWeight: 'bold', px: 2, py: 0.5, boxShadow: 4,
          '&:hover': { bgcolor: 'rgba(40,0,0,0.9)', borderColor: '#ff5252', borderWidth: 2 },
          transition: 'all 0.2s',
          display: (isOpen && isMobile) || isZoomed ? 'none' : 'flex'
        }}
      >
        CYOA Calc
      </Button>

      {isOpen && (
        <Paper
          ref={drawerRef}
          elevation={12}
          sx={isMobile ? {
            // MOBILE STYLES (Fixed to Right)
            position: 'fixed', top: 0, right: 0, bottom: 0,
            width: '85%', maxWidth: '400px',
            bgcolor: 'rgba(18, 18, 18, 0.95)', backdropFilter: 'blur(12px)',
            zIndex: 1300, display: 'flex', flexDirection: 'column', p: 2,
            borderLeft: '1px solid #333',
            animation: 'slideIn 0.3s ease-out',
            '@keyframes slideIn': { from: { transform: 'translateX(100%)' }, to: { transform: 'translateX(0)' } }
          } : {
            // DESKTOP STYLES (Absolute positioning TOP/LEFT)
            position: 'fixed',
            // Вот ключевое изменение: используем top/left из стейта
            left: `${position.left}px`,
            top: `${position.top}px`,
            
            width: `${size.width}px`,
            height: `${size.height}px`,
            
            display: 'flex', flexDirection: 'column',
            bgcolor: 'rgba(30, 30, 30, 0.95)', backdropFilter: 'blur(10px)',
            border: '1px solid rgba(255,255,255,0.05)', borderRadius: 2,
            zIndex: 1300, p: 2,
            boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
          }}
        >
          {renderContent()}
        </Paper>
      )}

      <Dialog open={deleteId !== null} onClose={() => setDeleteId(null)} PaperProps={{ style: { backgroundColor: '#222', color: 'white' } }}>
        <DialogTitle>Delete Counter?</DialogTitle>
        <DialogContent><DialogContentText sx={{ color: '#aaa' }}>Are you sure you want to remove this row?</DialogContentText></DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteId(null)} sx={{ color: '#aaa' }}>Cancel</Button>
          <Button onClick={executeDelete} color="error" variant="contained">Delete</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

// Drag Helper
function DragIndicator(props: any) {
    return (
        <Box {...props} component="span" sx={{ display: 'flex', alignItems: 'center', cursor: 'grab', ...props.sx }}>
            <DragIcon fontSize="inherit" />
        </Box>
    );
}