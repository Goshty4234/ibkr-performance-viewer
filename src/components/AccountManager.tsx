'use client';

import { useState } from 'react';
import type { PortfolioAccount } from '@/lib/types';
import styles from './AccountManager.module.css';

interface Props {
  accounts: PortfolioAccount[];
  selectedId: string;
  onSelect: (ibkrAccountId: string) => void;
  onRefresh: () => void;
  onAccountCreated?: (account: PortfolioAccount) => void;
}

export default function AccountManager({ accounts, selectedId, onSelect, onRefresh, onAccountCreated }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [newId, setNewId] = useState('');
  const [newName, setNewName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  async function handleRename(id: string) {
    if (!editName.trim()) return;
    setLoading(true);
    const res = await fetch('/api/accounts', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, displayName: editName.trim() }),
    });
    setLoading(false);
    if (!res.ok) {
      const j = await res.json();
      setError(j.error || 'Erreur');
      return;
    }
    setEditingId(null);
    onRefresh();
  }

  async function handleDelete(id: string, name: string) {
    if (!confirm(`Supprimer le compte « ${name} » et toutes ses données importées ?`)) return;
    setLoading(true);
    const res = await fetch(`/api/accounts?id=${id}`, { method: 'DELETE' });
    setLoading(false);
    if (!res.ok) {
      const j = await res.json();
      setError(j.error || 'Erreur');
      return;
    }
    if (selectedId !== 'all') onSelect('all');
    onRefresh();
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newId.trim() || !newName.trim()) return;
    setLoading(true);
    setError('');
    const res = await fetch('/api/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ibkrAccountId: newId.trim(), displayName: newName.trim() }),
    });
    setLoading(false);
    if (!res.ok) {
      const j = await res.json();
      setError(j.error || 'Erreur');
      return;
    }
    const created = await res.json() as PortfolioAccount;
    setShowCreate(false);
    setNewId('');
    setNewName('');
    setSuccess(`Compte « ${created.displayName} » créé et sélectionné ↓`);
    onSelect(created.ibkrAccountId);
    onAccountCreated?.({ ...created, statementCount: 0 });
    onRefresh();
  }

  return (
    <div className={`card ${styles.panel}`}>
      <div className={styles.header}>
        <div>
          <h2>Mes comptes</h2>
          <p className={styles.sub}>
            Cliquez sur un compte pour le sélectionner, puis importez un CSV en dessous.
          </p>
        </div>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setShowCreate(!showCreate); setSuccess(''); }}>
          + Nouveau (optionnel)
        </button>
      </div>

      {success && <p className={styles.success}>{success}</p>}
      {error && <p className={styles.error}>{error}</p>}

      {showCreate && (
        <form className={styles.createForm} onSubmit={handleCreate}>
          <input
            placeholder="ID IBKR (ex. U98765432)"
            value={newId}
            onChange={(e) => setNewId(e.target.value)}
            required
          />
          <input
            placeholder="Nom du compte (ex. Stratégie growth)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            required
          />
          <button type="submit" className="btn btn-primary btn-sm" disabled={loading}>
            Créer
          </button>
        </form>
      )}

      <p className={styles.sectionLabel}>Vos comptes — cliquez pour sélectionner</p>

      {accounts.length > 0 ? (
        <div className={styles.cards}>
          {accounts.map((a) => {
            const isSelected = selectedId === a.ibkrAccountId;
            const hasData = (a.statementCount ?? 0) > 0;
            return (
              <button
                key={a.id}
                type="button"
                className={`${styles.accountCard} ${isSelected ? styles.accountCardSelected : ''}`}
                onClick={() => onSelect(a.ibkrAccountId)}
              >
                {isSelected && <span className={styles.selectedBadge}>✓ Sélectionné</span>}
                <span className={styles.cardName}>{a.displayName}</span>
                <span className={styles.cardId}>{a.ibkrAccountId}</span>
                <span className={styles.cardStatus}>
                  {hasData
                    ? `${a.statementCount} période${a.statementCount !== 1 ? 's' : ''} importée${a.statementCount !== 1 ? 's' : ''}`
                    : 'Aucun CSV — importez ci-dessous'}
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <p className={styles.empty}>
          <strong>Aucun compte pour l&apos;instant.</strong> Glissez un CSV IBKR juste en dessous — le compte se crée tout seul.
        </p>
      )}

      {accounts.length > 0 && (
        <details className={styles.manage}>
          <summary>Gérer les comptes (renommer / supprimer)</summary>
          <div className={styles.list}>
          {accounts.map((a) => (
            <div key={a.id} className={styles.item}>
              {editingId === a.id ? (
                <div className={styles.editRow}>
                  <input
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    autoFocus
                  />
                  <button type="button" className="btn btn-primary btn-sm" onClick={() => handleRename(a.id)} disabled={loading}>
                    OK
                  </button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditingId(null)}>
                    Annuler
                  </button>
                </div>
              ) : (
                <>
                  <div className={styles.itemInfo}>
                    <span className={styles.itemName}>{a.displayName}</span>
                    <span className={styles.itemMeta}>
                      {a.ibkrAccountId}
                      {` · ${a.statementCount ?? 0} import${(a.statementCount ?? 0) !== 1 ? 's' : ''}`}
                      {(a.statementCount ?? 0) === 0 && (
                        <span className={styles.noData}> — en attente de CSV</span>
                      )}
                    </span>
                  </div>
                  <div className={styles.itemActions}>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => { setEditingId(a.id); setEditName(a.displayName); }}
                    >
                      Renommer
                    </button>
                    <button
                      type="button"
                      className="btn btn-danger btn-sm"
                      onClick={() => handleDelete(a.id, a.displayName)}
                    >
                      Supprimer
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
          </div>
        </details>
      )}
    </div>
  );
}
