import { supabase } from './supabase';
import { toISODate } from './dates';

const BUCKET = 'receipts';

/**
 * Storage paths are groups/<group_id>/…, which is what the storage RLS policies
 * read to decide who may see a receipt.
 */
export type ReceiptScope = { kind: 'group'; groupId: string };

const pathFor = (scope: ReceiptScope, fileName: string): string => {
  const stamp = Date.now();
  const safe = fileName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-40);
  return `groups/${scope.groupId}/${stamp}-${safe}`;
};

/** Uploads a receipt image and returns its storage path (not a public URL). */
export const uploadReceipt = async (file: File, scope: ReceiptScope): Promise<string> => {
  const path = pathFor(scope, file.name || 'receipt.jpg');
  const { error } = await supabase.storage.from(BUCKET).upload(path, file, {
    cacheControl: '3600',
    upsert: false,
    contentType: file.type || 'image/jpeg',
  });
  if (error) throw error;
  return path;
};

/** The bucket is private, so viewing needs a short-lived signed URL. */
export const receiptUrl = async (path: string, expiresInSeconds = 3600): Promise<string | null> => {
  if (!path) return null;
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, expiresInSeconds);
  if (error) return null;
  return data?.signedUrl ?? null;
};

export const deleteReceipt = async (path: string): Promise<void> => {
  if (!path) return;
  await supabase.storage.from(BUCKET).remove([path]);
};

/* ------------------------------------------------------------------------ */
/* OCR                                                                       */
/* ------------------------------------------------------------------------ */

export interface ScanResult {
  amount: number | null;
  date: string | null;
  merchant: string | null;
  text: string;
}

/**
 * Picks the bill total out of OCR text.
 *
 * Receipts put many numbers on the page, so a plain "largest number" guess is
 * wrong as often as it is right (quantities, phone numbers, card digits). This
 * prefers a number on a line that says total, and falls back to the largest
 * money-shaped value only when no such line exists.
 */
const extractAmount = (text: string): number | null => {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);

  const moneyOn = (line: string): number[] => {
    const matches = line.match(/\d[\d,\s]*(?:[.,]\d{2})?/g) ?? [];
    return matches
      .map((raw) => {
        // "1,234.56" and "1 234,56" both appear on Sri Lankan receipts.
        const normalized = raw.replace(/\s/g, '').replace(/,(\d{2})$/, '.$1').replace(/,/g, '');
        return parseFloat(normalized);
      })
      .filter((value) => Number.isFinite(value) && value > 0);
  };

  // Strongest signal first, and skip subtotal/tax lines that also say "total".
  const totalLine = lines
    .filter((line) => /(grand\s*total|net\s*total|total\s*due|amount\s*due|\btotal\b)/i.test(line))
    .filter((line) => !/(sub\s*total|subtotal|tax|vat|discount|change|cash|balance)/i.test(line))
    .pop();

  if (totalLine) {
    const candidates = moneyOn(totalLine);
    if (candidates.length > 0) return Math.max(...candidates);
  }

  const all = lines.flatMap(moneyOn).filter((value) => value >= 1);
  return all.length > 0 ? Math.max(...all) : null;
};

const extractDate = (text: string): string | null => {
  // dd/mm/yyyy or dd-mm-yy, the common receipt formats.
  const match = text.match(/(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})/);
  if (!match) return null;

  const day = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  let year = parseInt(match[3], 10);
  if (year < 100) year += 2000;

  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const parsed = new Date(year, month - 1, day);
  if (Number.isNaN(parsed.getTime())) return null;
  // A future date means we mis-read it; ignore rather than mislead.
  if (parsed.getTime() > Date.now() + 24 * 3600 * 1000) return null;

  return toISODate(parsed);
};

const extractMerchant = (text: string): string | null => {
  // The shop name is nearly always the first substantial line.
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length >= 3 && /[a-zA-Z]/.test(l) && !/receipt|invoice|bill/i.test(l));
  return line ? line.slice(0, 60) : null;
};

/**
 * Runs OCR in the browser. tesseract.js is imported dynamically so its worker
 * and language data are only fetched when someone actually scans — it would
 * otherwise dominate the bundle for a feature most sessions never touch.
 */
export const scanReceipt = async (
  file: File,
  onProgress?: (ratio: number) => void
): Promise<ScanResult> => {
  const { default: Tesseract } = await import('tesseract.js');

  const { data } = await Tesseract.recognize(file, 'eng', {
    logger: (message: { status: string; progress: number }) => {
      if (message.status === 'recognizing text') onProgress?.(message.progress);
    },
  });

  const text = data.text ?? '';
  return {
    amount: extractAmount(text),
    date: extractDate(text),
    merchant: extractMerchant(text),
    text,
  };
};
