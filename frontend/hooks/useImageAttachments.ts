import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../lib/api';

/** An image attached to the question being written. */
export type Attachment = {
  key: number;
  name: string;
  /** For its thumbnail. */
  url: string;
  status: 'uploading' | 'ready' | 'failed';
  /** Its id on the backend, once uploaded. */
  id?: string;
  error?: string;
};

export const MAX_IMAGES = 4;
// A bigger image is shrunk to this many pixels on its longer side before it's uploaded: plenty
// for Gemini to read a screenshot, and quicker to send.
const MAX_SIDE = 2048;
const MAX_BYTES = 3 * 1024 * 1024;
// The kinds Gemini reads as they are; others (a GIF, say) are turned into a JPEG first.
const READ_AS_IS = ['image/png', 'image/jpeg', 'image/webp'];
const isHeic = (file: File) => /^image\/hei[cf]$/.test(file.type) || /\.hei[cf]$/i.test(file.name);
export const isImage = (file: File) => file.type.startsWith('image/') || isHeic(file);

/** The image, ready to upload: as it is, or redrawn as a JPEG if it's big or of another kind. */
async function prepare(file: File): Promise<Blob> {
  if (isHeic(file)) return file; // the browser can't redraw it, but Gemini reads it as it is
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) throw new Error(`${file.name || 'The image'} couldn't be opened.`);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && READ_AS_IS.includes(file.type) && file.size <= MAX_BYTES) {
    bitmap.close();
    return file;
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const context = canvas.getContext('2d')!;
  context.fillStyle = 'white'; // under see-through parts, which a JPEG can't keep
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      blob => (blob ? resolve(blob) : reject(new Error(`${file.name || 'The image'} couldn't be prepared.`))),
      'image/jpeg',
      0.9,
    ),
  );
}

/**
 * The images attached to the question being written. Each is uploaded as soon as it's attached,
 * so sending the question doesn't wait for it; one taken off before sending is deleted again.
 */
export function useImageAttachments(conversationId: string | null, setError: (message: string) => void) {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  // Always the latest list, for the uploads finishing later.
  const listRef = useRef<Attachment[]>([]);
  const uploadsRef = useRef(new Map<number, Promise<void>>());
  const nextKeyRef = useRef(1);
  // Thumbnails made from the files themselves, to be released when no longer shown.
  const localUrlsRef = useRef(new Set<string>());

  const change = useCallback((update: (list: Attachment[]) => Attachment[]) => {
    listRef.current = update(listRef.current);
    setAttachments(listRef.current);
  }, []);

  const release = useCallback((attachment: Attachment) => {
    if (localUrlsRef.current.delete(attachment.url)) URL.revokeObjectURL(attachment.url);
  }, []);

  /** Attaches images (from the picker, a paste or a drop). Other files are turned away. */
  const add = useCallback(
    (files: File[]) => {
      const id = conversationId;
      if (!id) return;
      const images = files.filter(isImage);
      const room = MAX_IMAGES - listRef.current.length;
      if (images.length < files.length) setError('Only images can be added to a question.');
      else if (images.length > room) setError(`A question can have up to ${MAX_IMAGES} images.`);
      for (const file of images.slice(0, Math.max(0, room))) {
        const key = nextKeyRef.current++;
        const url = URL.createObjectURL(file);
        localUrlsRef.current.add(url);
        const name = file.name || 'Pasted image';
        change(list => [...list, { key, name, url, status: 'uploading' }]);
        const upload = (async () => {
          try {
            const blob = await prepare(file);
            const response = await api.uploadImage(id, blob, name);
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(errorMessage(data, `${name} couldn't be uploaded.`));
            const imageId = (data as { image_id: string }).image_id;
            change(list => list.map(item => (item.key === key ? { ...item, status: 'ready', id: imageId } : item)));
            // Taken off while it uploaded: not needed after all.
            if (!listRef.current.some(item => item.key === key)) void api.deleteImage(imageId).catch(() => {});
          } catch (e) {
            const error = e instanceof Error ? e.message : `${name} couldn't be uploaded.`;
            change(list => list.map(item => (item.key === key ? { ...item, status: 'failed', error } : item)));
          } finally {
            uploadsRef.current.delete(key);
          }
        })();
        uploadsRef.current.set(key, upload);
      }
    },
    [change, conversationId, setError],
  );

  /** Takes an image off the question, and off the backend if it was uploaded. */
  const remove = useCallback(
    (key: number) => {
      const attachment = listRef.current.find(item => item.key === key);
      if (!attachment) return;
      change(list => list.filter(item => item.key !== key));
      release(attachment);
      if (attachment.id) void api.deleteImage(attachment.id).catch(() => {});
    },
    [change, release],
  );

  /** Takes every image off (on Clear, or leaving the interview). */
  const clear = useCallback(() => {
    for (const attachment of [...listRef.current]) remove(attachment.key);
  }, [remove]);

  const hasImages = useCallback(() => listRef.current.length > 0, []);

  /**
   * For sending: waits for any image still uploading, then takes them all off the question and
   * returns their ids (the question shows them from then on). Null, saying why, if one couldn't be
   * uploaded: the question isn't sent.
   */
  const take = useCallback(async (): Promise<string[] | null> => {
    await Promise.all(uploadsRef.current.values());
    const list = listRef.current;
    if (list.some(item => item.status === 'failed')) {
      setError("An image couldn't be uploaded. Remove it, or add it again.");
      return null;
    }
    change(() => []);
    list.forEach(release);
    return list.map(item => item.id).filter((imageId): imageId is string => Boolean(imageId));
  }, [change, release, setError]);

  /** Puts a question's images back (when it couldn't be answered), to send again. */
  const restore = useCallback(
    (ids: string[]) => {
      const restored = ids.map(imageId => ({
        key: nextKeyRef.current++,
        name: 'Image',
        url: api.imageUrl(imageId),
        status: 'ready' as const,
        id: imageId,
      }));
      change(list => [...restored, ...list]);
    },
    [change],
  );

  useEffect(() => {
    const urls = localUrlsRef.current;
    return () => urls.forEach(url => URL.revokeObjectURL(url));
  }, []);

  return { attachments, add, remove, clear, hasImages, take, restore };
}
