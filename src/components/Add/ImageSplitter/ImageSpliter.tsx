import React, { useState, useRef, useEffect } from 'react';
import { 
  Dialog, 
  DialogContent, 
  DialogActions, 
  Button, 
  Box, 
  Typography,
  Grid,
} from '@mui/material';
import ContentCutIcon from '@mui/icons-material/ContentCut';
import ReactCrop, { Crop, PixelCrop } from 'react-image-crop';
import { CanvasPreview } from './CanvasPreview';
import { useDebounceEffect } from '../../../utils/useDebounceEffect';
import 'react-image-crop/dist/ReactCrop.css';

export default function ImageSplitter({
  file,
  index,
  returnImages,
  close,
}: {
  file: File;
  index: number;
  returnImages: Function;
  close: Function;
}) {
  const [imgSrc, setImgSrc] = useState('');
  const imgRef = useRef<HTMLImageElement>(null);
  const divRef = useRef<HTMLDivElement>(null);
  const topCanvasRef = useRef<HTMLCanvasElement>(null);
  const bottomCanvasRef = useRef<HTMLCanvasElement>(null);
  const [crop, setCrop] = useState<Crop>();
  const [completedCrop, setCompletedCrop] = useState<PixelCrop>();

  useEffect(() => {
    setCrop(undefined);
    const reader = new FileReader();
    reader.addEventListener('load', () => setImgSrc(reader.result?.toString() || ''));
    reader.readAsDataURL(file);
  }, [file]);

  function onImageLoad(e: React.SyntheticEvent<HTMLImageElement>) {
    const { height } = e.currentTarget;
    setCrop({
      unit: '%',
      x: 0,
      y: 0,
      width: 100,
      height: 50,
    });
    divRef.current?.scrollTo(0, Math.min(height / 2 - 600, 16383));
  }

  useDebounceEffect(
    async () => {
      if (
        completedCrop?.width &&
        completedCrop?.height &&
        imgRef.current &&
        topCanvasRef.current &&
        bottomCanvasRef.current
      ) {
        const image = imgRef.current;
        const cropHeightPx = completedCrop.height * 2;

        CanvasPreview(image, topCanvasRef.current, {
          unit: 'px',
          x: 0,
          y: 0,
          width: image.width,
          height: cropHeightPx,
        });

        CanvasPreview(image, bottomCanvasRef.current, {
          unit: 'px',
          x: 0,
          y: cropHeightPx,
          width: image.width,
          height: image.height - cropHeightPx,
        });
      }
    },
    100,
    [completedCrop],
  );

  async function onSplitImage() {
    if (!topCanvasRef.current) return;
    const topBlob = await new Promise<Blob | null>((resolve) => topCanvasRef.current!.toBlob(resolve));
    if (!bottomCanvasRef.current) return;
    const bottomBlob = await new Promise<Blob | null>((resolve) => bottomCanvasRef.current!.toBlob(resolve));

    const topFile = new File([topBlob!], 'split1.png', { type: 'image/png' });
    const bottomFile = new File([bottomBlob!], 'split2.png', { type: 'image/png' });

    returnImages([topFile, bottomFile], index);
  }

  return (
    <Dialog 
      open={true} 
      onClose={() => close(index)}
      maxWidth={false}
      PaperProps={{
        sx: {
          width: '60%',
          bgcolor: 'background.paper',
          color: 'text.primary',
          maxHeight: '90vh',
          '& ::-webkit-scrollbar': {
            width: '8px',
            height: '8px',
          },
          '& ::-webkit-scrollbar-track': {
            background: '#1e1e1e',
          },
          '& ::-webkit-scrollbar-thumb': {
            background: '#fc3447',
            borderRadius: '4px',
          },
          '& ::-webkit-scrollbar-thumb:hover': {
            background: '#FF0000c363f',
          }
        }
      }}
    >
      <DialogContent sx={{ 
        p: 0, 
        overflowX: 'hidden',
        '&.MuiDialogContent-root': {
          padding: 0,
        }
      }}>
        <Box sx={{ bgcolor: 'background.default' }}>
          {!!imgSrc && (
            <>
                <div
                  style={{
                    maxHeight: '1200px',
                    overflowY: 'auto',  
                    overflowX: 'hidden',  
                    transform: 'scale(0.5)',
                    margin: `-${Math.min((imgRef.current?.height ?? 0) / 4, 300)}px 0`,
                    width: '100%',
                  }}
                  ref={divRef}
                >
                  <ReactCrop
                    crop={crop}
                    onChange={(_, percentCrop) => {
                      setCrop({
                        ...percentCrop,
                        x: 0,
                        y: 0,
                        width: 100,
                      });
                    }}
                    onComplete={(c) => setCompletedCrop(c)}
                    minHeight={10}
                  >
                    <img
                      ref={imgRef}
                      alt="Crop me"
                      src={imgSrc}
                      style={{
                        maxHeight: 'none',
                        maxWidth: '100%',
                      }}
                      onLoad={onImageLoad}
                    />
                  </ReactCrop>
                </div>
              <DialogActions 
                sx={{ 
                  justifyContent: 'center', 
                  py: 2,  
                  bgcolor: 'background.default'
                }}
              >
                <Button 
                  variant="outlined"  
                  onClick={() => close(index)}
                  sx={{ 
                    mr: 2,
                    color: '#fc3447',
                    textTransform: 'uppercase',
                    border: '1px solid #fc3447',
                    '&:hover': {
                      backgroundColor: 'rgba(252, 52, 71, 0.04)',
                      border: '1px solid #fc3447'  
                    }
                  }}
                >
                  Cancel
                </Button>
                <Button
                  variant="contained"
                  onClick={onSplitImage}
                  startIcon={<ContentCutIcon />}
                  sx={{ 
                    bgcolor: 'primary.main',
                    '&:hover': {
                      bgcolor: '#cc363f'
                    }
                  }}
                >
                  Split Image
                </Button>
              </DialogActions>
            </>
          )}
        </Box>

        {!!completedCrop && (
          <Grid 
            container 
            spacing={2} 
            sx={{ 
              p: 2,
              bgcolor: 'background.default',
              m: 0,
              width: '100%' // Фиксируем ширину Grid
            }}
          >
            <Grid item xs={6}>
              <Typography 
                variant="subtitle1" 
                sx={{ 
                  mb: 1,
                  color: 'text.primary'
                }}
              >
                Top Part
              </Typography>
              <Box sx={{ 
                border: '1px solid rgba(255, 255, 255, 0.12)',
                borderRadius: 2,
                overflow: 'hidden',
                backgroundColor: 'background.default'
              }}>
                <canvas
                  ref={topCanvasRef}
                  style={{
                    width: '100%',
                    display: 'block'
                  }}
                />
              </Box>
            </Grid>
            <Grid item xs={6}>
              <Typography 
                variant="subtitle1" 
                sx={{ 
                  mb: 1,
                  color: 'text.primary'
                }}
              >
                Bottom Part
              </Typography>
              <Box sx={{ 
                border: '1px solid rgba(255, 255, 255, 0.12)',
                borderRadius: 2,
                overflow: 'hidden',
                backgroundColor: 'background.default'
              }}>
                <canvas
                  ref={bottomCanvasRef}
                  style={{
                    width: '100%',
                    display: 'block'
                  }}
                />
              </Box>
            </Grid>
          </Grid>
        )}
      </DialogContent>
    </Dialog>
  );
}