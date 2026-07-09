'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { dbToAccount, formatIbkrIdDisplay } from '@/lib/account-mapper';
import type { PortfolioAccount } from '@/lib/types';
import styles from './AccountsHome.module.css';

export default function AccountsHome() {
  const router = useRouter();
  const [accounts, setAccounts] = useState<PortfolioAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [newId, setNewId] = useState('');
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
        ...(newId.trim() ? { ibkrAccountId: newId.trim() } : {}),
      }),
    });
    const j = await res.json();
    setCreating(false);
    if (!res.ok) {
      setError(j.error || 'Erreur à la création');
      return;
    }
    router.push(`/compte/${j.id}`);
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
    router.push(`/compte/${id}`);
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
    await loadAccounts();
  }

  return (
    <div className={styles.page}>
      <div className={styles.hero}>
        <h1>Mes comptes IBKR</h1>
        <p className={styles.sub}>
          Chaque ligne = un compte. <strong>Cliquez sur une ligne</strong> pour l&apos;ouvrir.
        </p>
        {!loading && accounts.length > 0 && (
          <p className={styles.stats}>
            {accounts.length} compte{accounts.length !== 1 ? 's' : ''}
            {totalImports > 0 && ` · ${totalImports} CSV importé${totalImports !== 1 ? 's' : ''}`}
          </p>
        )}
      </div>

      {error && <div className={styles.error}>{error}</div>}

      <button
        type="button"
        className={`btn btn-primary ${styles.createBtn}`}
        onClick={() => setShowForm(!showForm)}
      >
        + Nouveau compte
      </button>

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
            <label>
              ID IBKR <span className={styles.optional}>(optionnel)</span>
              <input
                value={newId}
                onChange={(e) => setNewId(e.target.value)}
                placeholder="Laisser vide → détecté au 1er CSV"
              />
            </label>
          </div>
          <button type="submit" className="btn btn-primary" disabled={creating}>
            {creating ? 'Création…' : 'Créer et ouvrir →'}
          </button>
        </form>
      )}

      {loading ? (
        <p className={styles.loading}>Chargement…</p>
      ) : accounts.length === 0 ? (
        <div className={`card ${styles.empty}`}>
          <p>Aucun compte. Cliquez <strong>+ Nouveau compte</strong> ou importez un CSV depuis un compte.</p>
        </div>
      ) : (
        <div className={`card ${styles.list}`}>
          <div className={styles.listHeader}>
            <span>Nom du compte</span>
            <span>ID IBKR</span>
            <span>Données</span>
            <span>Actions</span>
          </div>
          {accounts.map((a) => {
            const isEditing = editingId === a.id;
            return (
            <div
              key={a.id}
              className={`${styles.row} ${isEditing ? styles.rowEditing : styles.rowClickable}`}
              onClick={() => handleRowClick(a)}
              onKeyDown={(e) => handleRowKeyDown(e, a)}
              role={isEditing ? undefined : 'button'}
              tabIndex={isEditing ? undefined : 0}
              aria-label={isEditing ? undefined : `Ouvrir ${a.displayName || 'Sans nom'}`}
            >
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
                  <span className={styles.accountName}>{a.displayName || 'Sans nom'}</span>
                )}
              </div>
              <div className={styles.idCol}>{formatIbkrIdDisplay(a.ibkrAccountId)}</div>
              <div className={styles.dataCol}>
                {(a.statementCount ?? 0) > 0
                  ? `${a.statementCount} CSV`
                  : <span className={styles.noData}>Vide</span>}
                {!isEditing && <span className={styles.openHint} aria-hidden>→</span>}
              </div>
              <div className={styles.actionsCol} onClick={stopRowClick} onKeyDown={stopRowClick}>
                {editingId !== a.id && (
                  <button
                    type="button"
                    className={`btn btn-secondary btn-sm ${styles.renameBtn}`}
                    onClick={() => startEdit(a)}
                  >
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
