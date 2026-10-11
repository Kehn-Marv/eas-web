import { useState, useEffect, useRef } from "react";

export function useImageFadeIn(imageSrc: string) {
  const [isLoaded, setIsLoaded] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const checkImageLoaded = () => {
      if (imgRef.current && imgRef.current.complete && imgRef.current.naturalWidth > 0) {
        setIsLoaded(true);
      }
    };

    // Small delay to ensure ref is set
    setTimeout(checkImageLoaded, 0);
  }, []);

  const handleLoad = () => {
    setIsLoaded(true);
  };

  const handleError = () => {
    // If image fails to load, still mark it as loaded so it doesn't stay invisible
    setIsLoaded(true);
  };

  return {
    imgRef,
    isLoaded,
    handleLoad,
    handleError,
  };
}

