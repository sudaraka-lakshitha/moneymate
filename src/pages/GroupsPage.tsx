import React, { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { Group, User } from '../types';
import { Plus, QrCode } from 'lucide-react';

interface GroupsPageProps {
  user: User;
  onNavigate: (route: string) => void;
}

const EMOJIS = ['💰', '🏠', '🎉', '✈️', '🍔', '🚗', '🎓', '💼', '🏖️', '🎮', '🛍️', '💊'];

export const GroupsPage: React.FC<GroupsPageProps> = ({ user, onNavigate }) => {
  const [groups, setGroups] = useState<Group[]>([]);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showJoinModal, setShowJoinModal] = useState(false);
  const [loading, setLoading] = useState(true);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [selectedEmoji, setSelectedEmoji] = useState('💰');
  const [inviteCode, setInviteCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  useEffect(() => {
    loadGroups();
  }, [user.id]);

  const loadGroups = async () => {
    try {
      const { data, error } = await supabase
        .from('group_members')
        .select('group_id, groups(*)')
        .eq('user_id', user.id);

      if (error) throw error;
      if (data) {
        const groupList = data.map((m: any) => m.groups).filter(Boolean);
        setGroups(groupList);
      }
    } catch (err: any) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const code = Math.random().toString(36).substring(2, 8).toUpperCase();
      const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();

      const { data: newGroup, error: groupErr } = await supabase
        .from('groups')
        .insert({
          name,
          description,
          icon_emoji: selectedEmoji,
          created_by: user.id,
          invite_code: code,
          invite_code_expires_at: expiresAt,
        })
        .select()
        .single();

      if (groupErr) throw groupErr;

      await supabase.from('group_members').insert({
        group_id: newGroup.id,
        user_id: user.id,
        role: 'ADMIN',
      });

      setShowCreateModal(false);
      setName('');
      setDescription('');
      loadGroups();
    } catch (err: any) {
      setError(err.message || 'Failed to create group');
    }
  };

  const handleJoinGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessMsg(null);
    try {
      const code = inviteCode.toUpperCase().trim();
      const { data: group, error: groupErr } = await supabase
        .from('groups')
        .select('*')
        .eq('invite_code', code)
        .single();

      if (groupErr || !group) {
        setError('Invalid or expired invite code');
        return;
      }

      const { data: member } = await supabase
        .from('group_members')
        .select('*')
        .eq('group_id', group.id)
        .eq('user_id', user.id)
        .single();

      if (member) {
        setError('You are already a member of this group');
        return;
      }

      const { error: reqErr } = await supabase.from('group_join_requests').insert({
        group_id: group.id,
        user_id: user.id,
        status: 'PENDING',
      });

      if (reqErr) throw reqErr;

      setSuccessMsg(`Join request sent to "${group.name}" admin for approval!`);
      setInviteCode('');
    } catch (err: any) {
      setError(err.message || 'Failed to submit join request');
    }
  };

  return (
    <div style={{ padding: '20px 16px 100px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <h2 style={{ fontSize: '1.4rem', fontWeight: 800, color: 'var(--on-background)' }}>Groups</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => setShowJoinModal(true)} className="btn-outline" style={{ padding: '8px 12px' }}>
            <QrCode size={18} /> Join
          </button>
          <button onClick={() => setShowCreateModal(true)} className="btn-primary" style={{ padding: '8px 14px' }}>
            <Plus size={18} /> New
          </button>
        </div>
      </div>

      {groups.length === 0 && !loading ? (
        <div className="glass-card" style={{ padding: 36, textAlign: 'center' }}>
          <span style={{ fontSize: 48 }}>👥</span>
          <h3 style={{ marginTop: 12, fontSize: '1.1rem', color: 'var(--on-background)' }}>No groups yet</h3>
          <p style={{ color: 'var(--on-surface-variant)', fontSize: '0.85rem', marginTop: 4, marginBottom: 20 }}>
            Create a group or join with a 6-character code
          </p>
          <button onClick={() => setShowCreateModal(true)} className="btn-primary">
            Create First Group
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {groups.map((group) => (
            <div
              key={group.id}
              onClick={() => onNavigate(`group-detail/${group.id}`)}
              className="glass-card"
              style={{ padding: 18, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                <div style={{
                  width: 52, height: 52, borderRadius: 16,
                  background: 'var(--primary-container)', display: 'flex',
                  alignItems: 'center', justifyContent: 'center', fontSize: 26
                }}>
                  {group.icon_emoji}
                </div>
                <div>
                  <div style={{ fontWeight: 700, fontSize: '1rem', color: 'var(--on-background)' }}>{group.name}</div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--on-surface-variant)' }}>
                    Code: <strong style={{ color: 'var(--primary-light)' }}>{group.invite_code}</strong>
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="badge badge-neutral">{group.status}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {showCreateModal && (
        <div className="modal-overlay" onClick={() => setShowCreateModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ fontSize: '1.2rem', fontWeight: 800, marginBottom: 16 }}>Create Group</h3>
            <form onSubmit={handleCreateGroup} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <label style={{ fontSize: '0.8rem', color: 'var(--on-surface-variant)', marginBottom: 8, display: 'block' }}>Choose Icon</label>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {EMOJIS.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      onClick={() => setSelectedEmoji(emoji)}
                      style={{
                        width: 42, height: 42, borderRadius: 12, border: selectedEmoji === emoji ? '2px solid var(--primary)' : '1px solid var(--card-border)',
                        background: selectedEmoji === emoji ? 'var(--primary-container)' : 'var(--surface-variant)',
                        fontSize: 20, cursor: 'pointer'
                      }}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              </div>

              <input
                type="text"
                placeholder="Group Name (e.g. Galle Trip)"
                className="input-field"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
              <input
                type="text"
                placeholder="Description (optional)"
                className="input-field"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />

              {error && <div style={{ color: 'var(--negative)', fontSize: '0.85rem' }}>{error}</div>}

              <button type="submit" className="btn-primary" style={{ height: 50, marginTop: 8 }}>
                Create Group
              </button>
            </form>
          </div>
        </div>
      )}

      {showJoinModal && (
        <div className="modal-overlay" onClick={() => setShowJoinModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ fontSize: '1.2rem', fontWeight: 800, marginBottom: 8 }}>Join Group</h3>
            <p style={{ fontSize: '0.85rem', color: 'var(--on-surface-variant)', marginBottom: 16 }}>
              Enter the 6-character invite code shared by the group admin.
            </p>
            <form onSubmit={handleJoinGroup} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <input
                type="text"
                placeholder="INVITE CODE (e.g. AB3X9K)"
                className="input-field"
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
                maxLength={6}
                style={{ textAlign: 'center', letterSpacing: 4, fontWeight: 700, fontSize: '1.2rem' }}
                required
              />

              {error && <div style={{ color: 'var(--negative)', fontSize: '0.85rem' }}>{error}</div>}
              {successMsg && <div style={{ color: 'var(--positive)', fontSize: '0.85rem' }}>{successMsg}</div>}

              <button type="submit" className="btn-primary" style={{ height: 50, marginTop: 8 }}>
                Request to Join
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
