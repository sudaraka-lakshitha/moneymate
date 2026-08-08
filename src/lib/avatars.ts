import { supabase } from './supabase';

const BUCKET = 'avatars';

/** Beyond this the browser downscales before upload rather than sending it raw. */
const MAX_DIMENSION = 512;
const MAX_BYTES = 5 * 1024 * 1024;

/**
 * Shrinks a picked photo to a square thumbnail before upload.
 *
 * A modern phone camera produces 3-8MB images; an avatar is rendered at 76px at
 * the very largest. Uploading the original would waste the user's data, their
 * storage quota, and make every friend list slow to paint — so the resize is not
 * an optimisation, it is what makes the feature usable on a phone connection.
 */
const toSquareThumbnail = (file: File): Promise<Blob> =>
  new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();

    image.onload = () => {
      URL.revokeObjectURL(url);

      // Center-crop to a square so the circular avatar never distorts the face.
      const side = Math.min(image.width, image.height);
      const sx = (image.width - side) / 2;
      const sy = (image.height - side) / 2;
      const target = Math.min(side, MAX_DIMENSION);

      const canvas = document.createElement('canvas');
      canvas.width = target;
      canvas.height = target;

      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Could not process the image.'));
        return;
      }
      ctx.drawImage(image, sx, sy, side, side, 0, 0, target, target);

      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('Could not process the image.'))),
        'image/jpeg',
        0.85
      );
    };

    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('That file could not be read as an image.'));
    };

    image.src = url;
  });

/**
 * Uploads a new profile picture and returns its public URL.
 *
 * The bucket is public on purpose: an avatar is shown next to a name in other
 * people's friend lists and group screens, and a private bucket would need a
 * signed URL minted per face on every render.
 */
export const uploadAvatar = async (file: File, userId: string): Promise<string> => {
  if (!file.type.startsWith('image/')) {
    throw new Error('Pick an image file.');
  }
  if (file.size > MAX_BYTES) {
    throw new Error('That image is too large — pick one under 5MB.');
  }

  const thumbnail = await toSquareThumbnail(file);

  // The path's first folder is the user id, which is what the storage policy
  // checks to decide who may write here. The timestamp busts any CDN cache of a
  // previous picture, which a fixed filename would keep serving.
  const path = `${userId}/${Date.now()}.jpg`;

  const { error } = await supabase.storage.from(BUCKET).upload(path, thumbnail, {
    cacheControl: '3600',
    upsert: true,
    contentType: 'image/jpeg',
  });
  if (error) throw error;

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return data.publicUrl;
};

/** Best-effort cleanup of a previous picture; never blocks setting the new one. */
export const removeOldAvatar = async (publicUrl?: string | null): Promise<void> => {
  if (!publicUrl) return;
  const marker = `/${BUCKET}/`;
  const index = publicUrl.indexOf(marker);
  if (index === -1) return; // an external URL (e.g. Google) — nothing of ours to delete
  const path = publicUrl.slice(index + marker.length).split('?')[0];
  if (!path) return;
  try {
    await supabase.storage.from(BUCKET).remove([path]);
  } catch {
    // A leftover file is harmless; failing here must not break the update.
  }
};
