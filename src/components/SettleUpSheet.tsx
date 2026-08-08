import React, { useState } from 'react';
import { supabase } from '../lib/supabase';
import { User } from '../types';
import { formatLKR, parseAmount, roundMoney } from '../lib/currency';
import { friendlyDbError } from '../lib/authErrors';
import { Alert, Avatar, Sheet, Spinner } from './ui';
import { useToast } from './Toast';

export interface SettleTarget {
  groupId: string;
  groupName?: string;
  /** The person being paid. */
  payee: User;
  /** What you owe them, used to prefill the amount. */
  suggestedAmount: number;
}

interface SettleUpSheetProps {
  target: SettleTarget;
  onClose: () => void;
  onSettled: () => void;
}

const METHODS = ['CASH', 'BANK', 'CARD', 'OTHER'];

export const SettleUpSheet: React.FC<SettleUpSheetProps> = ({ target, onClose, onSettled }) => {
  const toast = useToast();
  const [amountStr, setAmountStr] = useState(
    target.suggestedAmount > 0 ? target.suggestedAmount.toFixed(2) : ''
  );
  const [method, setMethod] = useState('CASH');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const amount = roundMoney(parseAmount(amountStr));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (amount <= 0) {
      setError('Enter an amount greater than zero.');
      return;
    }
    if (amount - target.suggestedAmount > 0.005 && target.suggestedAmount > 0) {
      setError(
        `That is more than you owe (${formatLKR(target.suggestedAmount)}). Reduce the amount, or record the extra separately.`
      );
      return;
    }

    setSaving(true);
    try {
      // One transaction: the settlement row plus the balancing ledger pair.
      const { error: rpcError } = await supabase.rpc('record_settlement', {
        p_group_id: target.groupId,
        p_to_user: target.payee.id,
        p_amount: amount,
        p_note: note.trim(),
        p_method: method,
      });
      if (rpcError) throw rpcError;

      toast.success(`Settled ${formatLKR(amount)} with ${target.payee.display_name}.`);
      onSettled();
    } catch (err) {
      setError(friendlyDbError(err, 'Could not record the settlement.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet title="Settle up" onClose={onClose}>
      <form onSubmit={handleSubmit} className="stack">
        <div className="card row">
          <Avatar name={target.payee.display_name} url={target.payee.avatar_url} size={44} />
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="truncate" style={{ fontWeight: 700 }}>
              Paying {target.payee.display_name}
            </div>
            <div className="hint">
              {target.groupName ? `${target.groupName} · ` : ''}
              You owe {formatLKR(target.suggestedAmount)}
            </div>
          </div>
        </div>

        <div className="field">
          <span className="label label-block">Amount</span>
          <div className="input-prefixed">
            <span className="input-prefix">Rs.</span>
            <input
              type="text"
              inputMode="decimal"
              className="input tabular"
              value={amountStr}
              onChange={(e) => setAmountStr(e.target.value)}
              autoFocus
              required
            />
          </div>
          {target.suggestedAmount > 0 && amount > 0 && amount < target.suggestedAmount && (
            <span className="hint">
              {formatLKR(target.suggestedAmount - amount)} will still be outstanding.
            </span>
          )}
        </div>

        <div className="field">
          <span className="label label-block">How did you pay?</span>
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
          {saving ? 'Recording…' : `Record ${amount > 0 ? formatLKR(amount) : 'payment'}`}
        </button>
      </form>
    </Sheet>
  );
};
