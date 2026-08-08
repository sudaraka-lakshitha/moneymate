import React, { useEffect, useRef, useState } from 'react';
import { Camera, Loader2, ScanLine, Trash2 } from 'lucide-react';
import { ReceiptScope, ScanResult, deleteReceipt, receiptUrl, scanReceipt, uploadReceipt } from '../lib/receipts';
import { useOnline } from '../lib/offline';
import { messageFrom } from '../lib/authErrors';
import { Alert } from './ui';

interface ReceiptPickerProps {
  scope: ReceiptScope;
  /** Storage path of an already-attached receipt. */
  value: string | null;
  onChange: (path: string | null) => void;
  /** Fired when OCR finds usable fields, so the form can pre-fill itself. */
  onScanned?: (result: ScanResult) => void;
}

export const ReceiptPicker: React.FC<ReceiptPickerProps> = ({ scope, value, onChange, onScanned }) => {
  const online = useOnline();
  const inputRef = useRef<HTMLInputElement>(null);

  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState<'scanning' | 'uploading' | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [scanNote, setScanNote] = useState<string | null>(null);

  // Show whatever is already attached.
  useEffect(() => {
    let cancelled = false;
    if (!value) {
      setPreview(null);
      return;
    }
    void receiptUrl(value).then((url) => {
      if (!cancelled) setPreview(url);
    });
    return () => {
      cancelled = true;
    };
  }, [value]);

  const handleFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = ''; // let the same file be picked again
    if (!file) return;

    setError(null);
    setScanNote(null);

    // Show the local image immediately; uploading can take a moment.
    const localUrl = URL.createObjectURL(file);
    setPreview(localUrl);

    try {
      setBusy('scanning');
      setProgress(0);
      const result = await scanReceipt(file, setProgress);

      const found: string[] = [];
      if (result.amount) found.push(`amount ${result.amount.toFixed(2)}`);
      if (result.date) found.push(`date ${result.date}`);
      setScanNote(
        found.length > 0
          ? `Read ${found.join(' and ')} from the receipt — check it before saving.`
          : 'Could not read the total automatically. Enter it manually; the image is still attached.'
      );
      onScanned?.(result);
    } catch {
      setScanNote('Scanning is unavailable right now. The image will still be attached.');
    }

    try {
      setBusy('uploading');
      const path = await uploadReceipt(file, scope);
      onChange(path);
    } catch (err) {
      // Storage errors aren't guaranteed to be Error instances either — same
      // messageFrom() used everywhere else, so this never falls back to a
      // stringified object.
      // Whichever way it fails, the person holding the phone can only retry —
      // telling them to re-run a setup script is an instruction for us, not them.
      setError(
        /bucket|not found/i.test(messageFrom(err))
          ? 'Receipt uploads are unavailable right now. The expense will still save without the image.'
          : 'Could not upload the receipt image.'
      );
      setPreview(null);
    } finally {
      setBusy(null);
    }
  };

  const handleRemove = async () => {
    const path = value;
    onChange(null);
    setPreview(null);
    setScanNote(null);
    if (path) await deleteReceipt(path);
  };

  return (
    <div className="field">
      <span className="label label-block">Receipt</span>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={handleFile}
        style={{ display: 'none' }}
      />

      {preview ? (
        <div className="card row" style={{ padding: 'var(--sp-2)' }}>
          <img
            src={preview}
            alt="Receipt"
            style={{
              width: 56,
              height: 56,
              objectFit: 'cover',
              borderRadius: 'var(--r-sm)',
              flexShrink: 0,
            }}
          />
          <span className="grow" style={{ minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: '0.86rem', fontWeight: 600 }}>
              {busy === 'scanning'
                ? `Reading receipt… ${Math.round(progress * 100)}%`
                : busy === 'uploading'
                  ? 'Uploading…'
                  : 'Receipt attached'}
            </span>
            <span className="hint">Tap the bin to remove it.</span>
          </span>
          <button
            type="button"
            className="btn-icon"
            style={{ width: 32, height: 32 }}
            onClick={handleRemove}
            disabled={busy !== null}
            aria-label="Remove receipt"
          >
            <Trash2 size={14} />
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="btn btn-secondary btn-block"
          onClick={() => inputRef.current?.click()}
          disabled={!online || busy !== null}
        >
          {busy ? <Loader2 size={16} className="spin" /> : <Camera size={16} />}
          {busy ? 'Working…' : 'Scan or attach a receipt'}
        </button>
      )}

      {!online && !preview && (
        <span className="hint">Receipts need a connection — attach one when you are back online.</span>
      )}

      {scanNote && (
        <span className="row hint" style={{ gap: 6 }}>
          <ScanLine size={12} /> {scanNote}
        </span>
      )}

      {error && <Alert variant="error">{error}</Alert>}
    </div>
  );
};
