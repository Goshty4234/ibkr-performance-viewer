'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import styles from './settings.module.css';

export default function SettingsForm({ email }: { email: string }) {
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [isError, setIsError] = useState(false);

  async function handlePasswordChange(e: React.FormEvent) {
    e.preventDefault();
    setMessage('');
    setIsError(false);

    if (newPassword.length < 6) {
      setIsError(true);
      setMessage('Le mot de passe doit contenir au moins 6 caractères.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setIsError(true);
      setMessage('Les mots de passe ne correspondent pas.');
      return;
    }

    setLoading(true);
    const supabase = createClient();
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    setLoading(false);

    if (error) {
      setIsError(true);
      setMessage(error.message);
    } else {
      setNewPassword('');
      setConfirmPassword('');
      setMessage('Mot de passe mis à jour avec succès.');
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <h1>Paramètres du compte</h1>
        <p>Gérez vos informations et la sécurité de votre compte.</p>
      </div>

      <section className={`card ${styles.section}`}>
        <h2 className={styles.sectionTitle}>Profil</h2>
        <div className={styles.infoRow}>
          <span className={styles.infoLabel}>Courriel</span>
          <span className={styles.infoValue}>{email}</span>
        </div>
      </section>

      <section className={`card ${styles.section}`}>
        <h2 className={styles.sectionTitle}>Sécurité</h2>
        <form onSubmit={handlePasswordChange} className={styles.form}>
          <label>
            Nouveau mot de passe
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              minLength={6}
              autoComplete="new-password"
              placeholder="6 caractères minimum"
            />
          </label>
          <label>
            Confirmer le mot de passe
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              minLength={6}
              autoComplete="new-password"
              placeholder="Retapez le mot de passe"
            />
          </label>

          {message && (
            <p className={`${styles.message} ${isError ? styles.messageError : styles.messageSuccess}`}>
              {message}
            </p>
          )}

          <div className={styles.actions}>
            <button type="submit" className="btn btn-primary" disabled={loading}>
              {loading ? 'Enregistrement…' : 'Changer le mot de passe'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
