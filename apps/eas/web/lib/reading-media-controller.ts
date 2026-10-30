export interface ReadingMediaController {
  currentTime(): number;
  duration(): number;
  seek(seconds: number): void;
  destroy(): void;
  tracksPosition: true;
}

export function html5ReadingController(
  media: HTMLMediaElement,
): ReadingMediaController {
  return {
    currentTime: () => media.currentTime,
    duration: () => Number.isFinite(media.duration) ? media.duration : 0,
    seek: (seconds) => {
      media.currentTime = Math.max(0, seconds);
    },
    destroy: () => undefined,
    tracksPosition: true,
  };
}
