import React, { useState, useRef, useEffect } from 'react';

import { Box, Button, Typography, List, ListItem, ListItemText, IconButton, Modal } from '@mui/material';
import ReactCrop, { Crop, PixelCrop } from 'react-image-crop';
import { CanvasPreview } from './CanvasPreview';
import { useDebounceEffect } from './useDebounceEffect';
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
    setCrop(undefined); // Update cropping when loading a new image
    const reader = new FileReader();
    reader.addEventListener('load', () => setImgSrc(reader.result?.toString() || ''));
    reader.readAsDataURL(file);
  }, [file]);
  function onImageLoad(e: React.SyntheticEvent<HTMLImageElement>) {
    const { width, height } = e.currentTarget;
    setCrop({
      unit: '%',
      x: 0,
      y: 0,
      width: 100,
      height: 50, // Initial selection of about half of the picture
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
        // const scaleY = image.naturalHeight / image.height
        // const scaleX = image.naturalWidth / image.width

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
    if (!topCanvasRef.current) {
      return;
    }
    const topBlob = await new Promise<Blob | null>((resolve) => topCanvasRef.current!.toBlob(resolve));
    if (!bottomCanvasRef.current) {
      return;
    }
    const bottomBlob = await new Promise<Blob | null>((resolve) => bottomCanvasRef.current!.toBlob(resolve));

    returnImages([topBlob, bottomBlob], index);
  }

  return (
    <div className="fixed top-0 left-0 right-0 z-[1000] overflow-scroll overscroll-contain max-h-[100vh]">
      <div className="container bg-black border-white mx-auto">
        {!!imgSrc && (
          <>
            <div className='flex flex-row justify-end m-2.5'>
                <Button variant="contained" className="!mt-2.5" onClick={() => close(index)}>
                X
                </Button>
            </div>
            <div
              style={{
                maxHeight: '1200px',
                overflow: 'auto',
                transform: 'scale(0.5)',
                margin: `-${Math.min((imgRef.current?.height ?? 0) / 4, 300)}px 0`,
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
            <div className='flex flex-row justify-start m-2.5'>
            <Button variant="contained" className="!my-2.5" onClick={() => onSplitImage()}>
              Split Image
            </Button>
            </div>
          </>
        )}
        {!!completedCrop && (
          <>
            <div>
              <h3 className="m-2.5">top part</h3>
              <canvas
                ref={topCanvasRef}
                style={{
                  border: '1px solid white',
                  width: '100%',
                  maxWidth: '400px'
                }}
                className="m-2.5"
              />
            </div>
            <div>
              <h3 className="m-2.5">bottom part</h3>
              <canvas
                ref={bottomCanvasRef}
                style={{
                  border: '1px solid white',
                  width: '100%',
                  maxWidth: '400px',
                }}
                className="m-2.5"
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
