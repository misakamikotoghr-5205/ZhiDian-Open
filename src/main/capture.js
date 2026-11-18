// Screen capture and cropping. Everything here runs on explicit triggers only: there is no
// background capture loop anywhere in the app.
import { desktopCapturer, nativeImage, screen, systemPreferences } from 'electron';
import { fitWithin } from '../core/geometry.js';

/** 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown'. Only macOS gates this. */
export function screenPermission() {
  if (process.platform !== 'darwin') return 'granted';
  try {
    return systemPreferences.getMediaAccessStatus('screen');
  } catch {
    return 'unknown';
  }
}

/**
 * macOS has no API to ask for screen recording. It shows its own prompt, and lists the app under
 * Privacy > Screen Recording so the user can switch it on, the first time the app tries to
 * capture. So try once, with a thumbnail too small to be of any use.
 */
export function requestScreenPermission() {
  if (process.platform !== 'darwin') return;
  desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 16, height: 16 } }).catch(() => {});
}

/**
 * Capture one display at its physical resolution.
 * Returns { image, px:{w,h}, dip:{w,h}, scale, displayId, ms }.
 */
export async function captureDisplay(display) {
  const t0 = Date.now();
  const size = {
    width: Math.round(display.bounds.width * display.scaleFactor),
    height: Math.round(display.bounds.height * display.scaleFactor),
  };
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
  if (!sources.length) throw new Error('no screen source available');
  const all = screen.getAllDisplays();
  let src = sources.find((s) => s.display_id && s.display_id === String(display.id));
  if (!src) {
    // Some Linux setups leave display_id empty: fall back to matching by order.
    const idx = Math.max(0, all.findIndex((d) => d.id === display.id));
    src = sources[Math.min(idx, sources.length - 1)];
  }
  const image = src.thumbnail;
  const px = image.getSize();
  if (!px.width || !px.height) throw new Error('screen capture returned an empty image');
  return {
    image,
    px: { w: px.width, h: px.height },
    dip: { w: display.bounds.width, h: display.bounds.height },
    scale: px.width / display.bounds.width,
    displayId: display.id,
    ms: Date.now() - t0,
  };
}

/** Raw 4-bytes-per-pixel bitmap at DIP resolution, for snapping and signatures. */
export function dipBitmap(shot) {
  const img =
    shot.px.w === shot.dip.w && shot.px.h === shot.dip.h
      ? shot.image
      : shot.image.resize({ width: shot.dip.w, height: shot.dip.h, quality: 'good' });
  const size = img.getSize();
  return { data: img.toBitmap(), width: size.width, height: size.height };
}

/** Crop a DIP box out of a capture. Returns { buffer, mediaType, w, h, bytes }. */
export function cropImage(shot, boxDip, { maxEdge = 1280, format = 'png', quality = 85 } = {}) {
  const s = shot.scale;
  const rect = {
    x: Math.max(0, Math.round(boxDip.x * s)),
    y: Math.max(0, Math.round(boxDip.y * s)),
    width: Math.max(1, Math.round(boxDip.w * s)),
    height: Math.max(1, Math.round(boxDip.h * s)),
  };
  rect.width = Math.min(rect.width, shot.px.w - rect.x);
  rect.height = Math.min(rect.height, shot.px.h - rect.y);
  let img = shot.image.crop(rect);
  const fit = fitWithin(rect.width, rect.height, maxEdge);
  if (fit.scale !== 1) img = img.resize({ width: fit.w, height: fit.h, quality: 'best' });
  const buffer = format === 'jpeg' ? img.toJPEG(quality) : img.toPNG();
  const size = img.getSize();
  return {
    buffer,
    mediaType: format === 'jpeg' ? 'image/jpeg' : 'image/png',
    w: size.width,
    h: size.height,
    bytes: buffer.length,
  };
}

/** Re-encode a stored PNG for transports with tight size limits (MCP tool results). */
export function toJpeg(buffer, { maxEdge = 1024, quality = 82 } = {}) {
  let img = nativeImage.createFromBuffer(buffer);
  const size = img.getSize();
  const fit = fitWithin(size.width, size.height, maxEdge);
  if (fit.scale !== 1) img = img.resize({ width: fit.w, height: fit.h, quality: 'best' });
  const out = img.toJPEG(quality);
  const s2 = img.getSize();
  return { buffer: out, mediaType: 'image/jpeg', w: s2.width, h: s2.height, bytes: out.length };
}

export function thumbDataUrl(buffer, maxEdge = 168) {
  let img = nativeImage.createFromBuffer(buffer);
  const size = img.getSize();
  const fit = fitWithin(size.width, size.height, maxEdge);
  if (fit.scale !== 1) img = img.resize({ width: fit.w, height: fit.h, quality: 'good' });
  return 'data:image/jpeg;base64,' + img.toJPEG(72).toString('base64');
}

/** The whole frame as a data URL, shown as the frozen backdrop while pointing. */
export function frameDataUrl(shot) {
  return 'data:image/jpeg;base64,' + shot.image.toJPEG(94).toString('base64');
}
