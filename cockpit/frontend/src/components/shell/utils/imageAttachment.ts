/**
 * An image picked on the device, made fit for the host's paste upload: phone
 * photos are large (and HEIC where the browser keeps the original), the host
 * takes PNG, JPEG, GIF or WebP up to 10 MB. Anything else, or anything larger
 * than LONG_EDGE_PX, is drawn onto a canvas and re-encoded as JPEG.
 */
const UPLOAD_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
/** Long edge after scaling; enough detail for an agent to read a screenshot. */
const LONG_EDGE_PX = 2048;
const MAX_UPLOAD_BYTES = 9 * 1024 * 1024;
const JPEG_QUALITY = 0.85;

export interface ImageUpload {
  blob: Blob;
  type: string;
}

export async function prepareImageUpload(file: File): Promise<ImageUpload | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null;
  }
  try {
    const longEdge = Math.max(bitmap.width, bitmap.height);
    if (UPLOAD_TYPES.has(file.type) && longEdge <= LONG_EDGE_PX && file.size <= MAX_UPLOAD_BYTES) {
      return { blob: file, type: file.type };
    }
    const scale = Math.min(1, LONG_EDGE_PX / longEdge);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
    return blob ? { blob, type: 'image/jpeg' } : null;
  } finally {
    bitmap.close();
  }
}
