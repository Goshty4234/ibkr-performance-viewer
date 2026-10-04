'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { dbToAccount, formatAccountLinkLabel } from '@/lib/account-mapper';
import type { PortfolioAccount } from '@/lib/types';
import { removeAccountDataLocal } from '@/lib/storage/mirror';
import FlexQueryGuide from './FlexQueryGuide';
import styles from './AccountsHome.module.css';

function initials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? '?').slice(0, 2)).toUpperCase();
}

export default function AccountsHome() {
  const router = useRouter();
  const [accounts, setAccounts] = useState<PortfolioAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [savingId, setSavingId] = useState<string | null>(null);

  const loadAccounts = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/accounts');
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 401) {
          router.push('/login');
          return;
        }
        setError((j as { error?: string }).error || 'Impossible de charger les comptes');
        setLoading(false);
        return;
      }
      const data = j;
      setAccounts(Array.isArray(data) ? data.map(dbToAccount) : []);
    } catch {
      setError('Erreur réseau — rechargez la page (Ctrl+F5)');
    }
    setLoading(false);
  }, [router]);

  useEffect(() => { loadAccounts(); }, [loadAccounts]);

  const totalImports = useMemo(
    () => accounts.reduce((n, a) => n + (a.statementCount ?? 0), 0),
    [accounts],
  );

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    setCreating(true);
    setError('');
    const res = await fetch('/api/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        displayName: newName.trim(),
      }),
    });
    const j = await res.json();
    setCreating(false);
    if (!res.ok) {
      setError(j.error || 'Erreur à la création');
      return;
    }
    router.push(`/ibkr/compte/${j.id}`);
  }

  async function handleRename(acc: PortfolioAccount) {
    const name = editName.trim();
    if (!name) return;
    setSavingId(acc.id);
    setError('');
    const res = await fetch('/api/accounts', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: acc.id, displayName: name }),
    });
    const j = await res.json().catch(() => ({}));
    setSavingId(null);
    if (!res.ok) {
      setError(j.error || 'Erreur renommage');
      return;
    }
    (document.activeElement as HTMLElement | null)?.blur?.();
    setEditingId(null);
    const updated = dbToAccount(j);
    setAccounts((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
  }

  function startEdit(acc: PortfolioAccount) {
    setEditingId(acc.id);
    setEditName(acc.displayName);
  }

  function openAccount(id: string) {
    router.push(`/ibkr/compte/${id}`);
  }

  function handleRowClick(acc: PortfolioAccount) {
    if (editingId === acc.id) return;
    openAccount(acc.id);
  }

  function handleRowKeyDown(e: React.KeyboardEvent, acc: PortfolioAccount) {
    if (editingId === acc.id) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openAccount(acc.id);
    }
  }

  function stopRowClick(e: React.MouseEvent | React.KeyboardEvent) {
    e.stopPropagation();
  }

  async function handleDelete(e: React.MouseEvent, acc: PortfolioAccount) {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm(`Supprimer « ${acc.displayName} » et toutes ses données ?`)) return;
    setDeletingId(acc.id);
    const res = await fetch(`/api/accounts?id=${acc.id}`, { method: 'DELETE' });
    setDeletingId(null);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error || 'Erreur suppression');
      return;
    }
    void removeAccountDataLocal(acc.id);
    await loadAccounts();
  }

  return (
    <div className={styles.page}>
      <div className={styles.hero}>
        <div className={styles.heroText}>
          <span className={styles.eyebrow}>Performance réelle</span>
          <h1>Mes comptes IBKR</h1>
          <p className={styles.sub}>
            Importe tes relevés CSV Interactive Brokers pour suivre la performance réelle (TWR, NAV, flux) de chaque compte.
          </p>
          {!loading && accounts.length > 0 && (
            <div className={styles.stats}>
              <span className={styles.statChip}><strong>{accounts.length}</strong> compte{accounts.length !== 1 ? 's' : ''}</span>
              <span className={styles.statChip}><strong>{totalImports}</strong> CSV importé{totalImports !== 1 ? 's' : ''}</span>
            </div>
          )}
        </div>
        <button
          type="button"
          className={`btn btn-primary ${styles.createBtn}`}
          onClick={() => setShowForm(!showForm)}
        >
          {showForm ? 'Fermer' : '+ Nouveau compte'}
        </button>
      </div>

      <FlexQueryGuide prominent defaultOpen={!loading && totalImports === 0} />

      {error && <div className={styles.error}>{error}</div>}

      {showForm && (
        <form className={`card ${styles.createCard}`} onSubmit={handleCreate}>
          <h2>Créer un compte</h2>
          <div className={styles.createFields}>
            <label>
              Nom du compte
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Ex. REER, Growth, Margin…"
                required
                autoFocus
              />
            </label>
          </div>
          <button type="submit" className="btn btn-primary" disabled={creating}>
            {creating ? 'Création…' : 'Créer et ouvrir →'}
          </button>
        </form>
      )}

      {loading ? (
        <div className={styles.grid}>
          {[0, 1, 2].map((k) => <div key={k} className={`card ${styles.skeleton}`} />)}
        </div>
      ) : accounts.length === 0 ? (
        <div className={`card ${styles.empty}`}>
          <div className={styles.emptyIcon}>📊</div>
          <h2>Aucun compte pour l&apos;instant</h2>
          <p>Crée un compte, puis importe un relevé CSV d&apos;Interactive Brokers depuis sa page.</p>
          {!showForm && (
            <button type="button" className="btn btn-primary" onClick={() => setShowForm(true)}>+ Créer mon premier compte</button>
          )}
        </div>
      ) : (
        <div className={styles.grid}>
          {accounts.map((a) => {
            const isEditing = editingId === a.id;
            const count = a.statementCount ?? 0;
            const name = a.displayName || 'Sans nom';
            return (
            <div
              key={a.id}
              className={`card ${styles.row} ${isEditing ? styles.rowEditing : styles.rowClickable}`}
              onClick={() => handleRowClick(a)}
              onKeyDown={(e) => handleRowKeyDown(e, a)}
              role={isEditing ? undefined : 'button'}
              tabIndex={isEditing ? undefined : 0}
              aria-label={isEditing ? undefined : `Ouvrir ${name}`}
            >
              <div className={styles.cardHead}>
                <span className={styles.avatar} aria-hidden>{initials(name)}</span>
                <div className={styles.nameCol}>
                {isEditing ? (
                  <div className={styles.renameRow} onClick={stopRowClick} onKeyDown={stopRowClick}>
                    <input
                      className={styles.renameInput}
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleRename(a);
                        if (e.key === 'Escape') setEditingId(null);
                      }}
                    />
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={() => handleRename(a)}
                      disabled={savingId === a.id}
                    >
                      {savingId === a.id ? '…' : 'OK'}
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditingId(null)}>
                      Annuler
                    </button>
                  </div>
                ) : (
                  <span className={styles.accountName} title={name}>{name}</span>
                )}
                </div>
              </div>
              <div className={styles.chips}>
                <span className={styles.chip}>{formatAccountLinkLabel(a.ibkrAccountId)}</span>
                {count > 0
                  ? <span className={`${styles.chip} ${styles.chipOk}`}>{count} CSV</span>
                  : <span className={`${styles.chip} ${styles.chipWarn}`}>Aucun relevé</span>}
                <span className={styles.chipMuted}>Créé le {new Date(a.created_at).toLocaleDateString('fr-CA', { dateStyle: 'medium' })}</span>
              </div>
              <div className={styles.cardFoot} onClick={stopRowClick} onKeyDown={stopRowClick}>
                {!isEditing && (
                  <button type="button" className="btn btn-primary btn-sm" onClick={() => openAccount(a.id)}>
                    {count > 0 ? 'Voir la performance →' : 'Importer un CSV →'}
                  </button>
                )}
                <span className={styles.footSpacer} />
                {!isEditing && (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => startEdit(a)}>
                    Renommer
                  </button>
                )}
                <button
                  type="button"
                  className={`btn btn-danger btn-sm ${styles.deleteBtn}`}
                  onClick={(e) => handleDelete(e, a)}
                  disabled={deletingId === a.id}
                >
                  {deletingId === a.id ? '…' : 'Supprimer'}
                </button>
              </div>
            </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
