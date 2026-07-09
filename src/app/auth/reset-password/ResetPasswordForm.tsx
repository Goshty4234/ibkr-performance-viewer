'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import { useRouter } from 'next/navigation';
import styles from '@/app/login/login.module.css';

export default function ResetPasswordForm() {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);
  const [hasSession, setHasSession] = useState(false);
  const [message, setMessage] = useState('');
  const [isError, setIsError] = useState(false);
  const router = useRouter();

  useEffect(() => {
    createClient()
      .auth.getSession()
      .then(({ data }) => {
        setHasSession(Boolean(data.session));
      })
      .finally(() => setCheckingSession(false));
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setIsError(true);
      setMessage('Les mots de passe ne correspondent pas.');
      return;
    }
    if (password.length < 6) {
      setIsError(true);
      setMessage('Le mot de passe doit contenir au moins 6 caractères.');
      return;
    }

    setLoading(true);
    setMessage('');
    setIsError(false);

    const { error } = await createClient().auth.updateUser({ password });
    setLoading(false);

    if (error) {
      setIsError(true);
      setMessage(error.message);
      return;
    }

    setIsError(false);
    setMessage('Mot de passe mis à jour. Redirection…');
    router.push('/');
    router.refresh();
  }

  return (
    <div className={styles.root}>
      <div className={styles.wrap}>
        <div className={styles.brand}>
          <div className={styles.logo} aria-hidden>📈</div>
          <h1>IBKR Performance</h1>
          <p className={styles.tagline}>Choisissez un nouveau mot de passe</p>
        </div>

        <div className={styles.card}>
          {checkingSession ? (
            <p className={styles.cardSub}>Vérification du lien…</p>
          ) : !hasSession ? (
            <>
              <p className={styles.cardTitle}>Lien invalide ou expiré</p>
              <p className={styles.cardSub}>
                Demandez un nouveau lien depuis la page de connexion.
              </p>
              <Link href="/login" className={styles.submit} style={{ display: 'block', textAlign: 'center', textDecoration: 'none' }}>
                Retour à la connexion
              </Link>
            </>
          ) : (
            <>
              <p className={styles.cardTitle}>Nouveau mot de passe</p>
              <p className={styles.cardSub}>6 caractères minimum</p>

              <form onSubmit={handleSubmit} className={styles.form}>
                <div className={styles.field}>
                  <label htmlFor="password">Nouveau mot de passe</label>
                  <input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    minLength={6}
                    autoComplete="new-password"
                    placeholder="6 caractères minimum"
                  />
                </div>
                <div className={styles.field}>
                  <label htmlFor="confirm">Confirmer le mot de passe</label>
                  <input
                    id="confirm"
                    type="password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    required
                    minLength={6}
                    autoComplete="new-password"
                    placeholder="Répétez le mot de passe"
                  />
                </div>

                {message && (
                  <p className={`${styles.message} ${isError ? styles.messageError : styles.messageInfo}`}>
                    {message}
                  </p>
                )}

                <button type="submit" className={styles.submit} disabled={loading}>
                  {loading ? 'Enregistrement…' : 'Enregistrer le mot de passe'}
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
