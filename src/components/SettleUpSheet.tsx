import React, { useState } from 'react';
import { supabase } from '../lib/supabase';
import { User } from '../types';
import { formatLKR, parseAmount, roundMoney } from '../lib/currency';
import { friendlyDbError } from '../lib/authErrors';
import { Alert, Avatar, Sheet, Spinner } from './ui';
import { useToast } from './Toast';
import { useConfirm } from './Confirm';

export interface SettleTarget {
  groupId: string;
  groupName?: string;
  /** The other person in the settlement. */
  payee: User;
  /** The outstanding amount, used to prefill. */
  suggestedAmount: number;
  /**
   * 'THEY_PAY' records a payment you received. Without it a debt could only be
   * cleared by whoever owed it, so being handed cash was unrecordable.
   */
  direction?: 'I_PAY' | 'THEY_PAY';
}

interface SettleUpSheetProps {
  target: SettleTarget;
  onClose: () => void;
  onSettled: () => void;
}

const METHODS = ['CASH', 'BANK', 'CARD', 'OTHER'];

export const SettleUpSheet: React.FC<SettleUpSheetProps> = ({ target, onClose, onSettled }) => {
  const toast = useToast();
  const confirm = useConfirm();
  const theyPay = target.direction === 'THEY_PAY';
  const [amountStr, setAmountStr] = useState(
    target.suggestedAmount > 0 ? target.suggestedAmount.toFixed(2) : ''
  );
  const [mode, setMode] = useState<'FULL' | 'PARTIAL'>('FULL');
  const [method, setMethod] = useState('CASH');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const amount = roundMoney(parseAmount(amountStr));
  const remaining = roundMoney(target.suggestedAmount - amount);
  const isPartial = mode === 'PARTIAL' && amount > 0 && remaining > 0.005;

  const chooseMode = (next: 'FULL' | 'PARTIAL') => {
    setMode(next);
    setError(null);
    // Switching back to Full restores the whole balance rather than leaving a
    // part-amount behind that no longer matches the label.
    if (next === 'FULL') {
      setAmountStr(target.suggestedAmount > 0 ? target.suggestedAmount.toFixed(2) : '');
    } else {
      setAmountStr('');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (amount <= 0) {
      setError('Enter an amount greater than zero.');
      return;
    }
    if (amount - target.suggestedAmount > 0.005 && target.suggestedAmount > 0) {
      setError(
        theyPay
          ? `That is more than they owe (${formatLKR(target.suggestedAmount)}). Reduce the amount, or record the extra separately.`
          : `That is more than you owe (${formatLKR(target.suggestedAmount)}). Reduce the amount, or record the extra separately.`
      );
      return;
    }

    // Money changing hands is worth one deliberate confirmation, and it is the
    // last point at which the direction can still be checked.
    const outstanding = isPartial ? ` ${formatLKR(remaining)} stays outstanding.` : '';
    const ok = await confirm({
      title: isPartial
        ? 'Record this part payment?'
        : theyPay
          ? 'Record this payment?'
          : 'Record this settlement?',
      message: theyPay
        ? `${target.payee.display_name} paid you ${formatLKR(amount)}.${
            outstanding || ' That clears what they owe you.'
          }`
        : `You paid ${target.payee.display_name} ${formatLKR(amount)}.${
            outstanding || ' That clears what you owe them.'
          }`,
      confirmLabel: 'Record it',
    });
    if (!ok) return;

    setSaving(true);
    try {
      // One transaction: the settlement row plus the balancing ledger pair.
      const { error: rpcError } = theyPay
        ? await supabase.rpc('record_payment_received', {
            p_group_id: target.groupId,
            p_from_user: target.payee.id,
            p_amount: amount,
            p_note: note.trim(),
            p_method: method,
          })
        : await supabase.rpc('record_settlement', {
            p_group_id: target.groupId,
            p_to_user: target.payee.id,
            p_amount: amount,
            p_note: note.trim(),
            p_method: method,
          });
      if (rpcError) throw rpcError;

      toast.success(
        theyPay
          ? `Recorded ${formatLKR(amount)} received from ${target.payee.display_name}.`
          : `Settled ${formatLKR(amount)} with ${target.payee.display_name}.`
      );
      onSettled();
    } catch (err) {
      setError(friendlyDbError(err, 'Could not record the settlement.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet title={theyPay ? 'Record a payment' : 'Settle up'} onClose={onClose}>
      <form onSubmit={handleSubmit} className="stack">
        <div className="card row">
          <Avatar name={target.payee.display_name} url={target.payee.avatar_url} size={44} />
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="truncate" style={{ fontWeight: 700 }}>
              {theyPay ? `${target.payee.display_name} is paying you` : `Paying ${target.payee.display_name}`}
            </div>
            <div className="hint">
              {target.groupName ? `${target.groupName} · ` : ''}
              {theyPay
                ? `They owe ${formatLKR(target.suggestedAmount)}`
                : `You owe ${formatLKR(target.suggestedAmount)}`}
            </div>
          </div>
        </div>

        {target.suggestedAmount > 0 && (
          <div className="segmented" role="group" aria-label="How much">
            <button
              type="button"
              className={`segmented-option ${mode === 'FULL' ? 'is-active' : ''}`}
              onClick={() => chooseMode('FULL')}
              aria-pressed={mode === 'FULL'}
            >
              Full amount
            </button>
            <button
              type="button"
              className={`segmented-option ${mode === 'PARTIAL' ? 'is-active' : ''}`}
              onClick={() => chooseMode('PARTIAL')}
              aria-pressed={mode === 'PARTIAL'}
            >
              Part of it
            </button>
          </div>
        )}

        <div className="field">
          <span className="label label-block">Amount</span>
          <div className="input-prefixed">
            <span className="input-prefix">Rs.</span>
            <input
              type="text"
              inputMode="decimal"
              className="input tabular"
              placeholder={mode === 'PARTIAL' ? 'How much now?' : '0.00'}
              value={amountStr}
              onChange={(e) => setAmountStr(e.target.value)}
              // Read-only rather than disabled on Full: the figure stays legible
              // and selectable, it just cannot drift from the balance it claims
              // to be.
              readOnly={mode === 'FULL' && target.suggestedAmount > 0}
              autoFocus={mode === 'PARTIAL'}
              required
            />
          </div>

          {mode === 'PARTIAL' && target.suggestedAmount > 0 && (
            <div className="row-between" style={{ marginTop: 'var(--sp-2)' }}>
              <span className="hint">
                {amount > 0 ? 'Still outstanding after this' : `Outstanding now`}
              </span>
              <span
                className={`tabular ${remaining > 0.005 ? 'text-negative' : 'text-positive'}`}
                style={{ fontSize: '0.85rem', fontWeight: 700 }}
              >
                {formatLKR(Math.max(0, amount > 0 ? remaining : target.suggestedAmount))}
              </span>
            </div>
          )}

          {mode === 'FULL' && target.suggestedAmount > 0 && (
            <span className="hint">Clears the balance in full. Choose "Part of it" to pay some now.</span>
          )}
        </div>

        <div className="field">
          <span className="label label-block">{theyPay ? 'How did they pay?' : 'How did you pay?'}</span>
          <div className="chip-grid">
            {METHODS.map((option) => (
              <button
                key={option}
                type="button"
                className={`chip ${method === option ? 'is-selected' : ''}`}
                style={{ display: 'flex', justifyContent: 'center' }}
                onClick={() => setMethod(option)}
              >
                {option[0] + option.slice(1).toLowerCase()}
              </button>
            ))}
          </div>
        </div>

        <input
          type="text"
          className="input"
          placeholder="Note (optional)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={140}
        />

        {error && <Alert variant="error">{error}</Alert>}

        <button type="submit" className="btn btn-primary btn-block btn-lg" disabled={saving}>
          {saving && <Spinner />}
          {saving
            ? 'Recording…'
            : isPartial
              ? `Record part payment of ${formatLKR(amount)}`
              : `Record ${amount > 0 ? formatLKR(amount) : 'payment'}`}
        </button>
      </form>
    </Sheet>
  );
};
