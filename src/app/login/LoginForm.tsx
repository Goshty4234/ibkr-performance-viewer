'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useRouter } from 'next/navigation';
import styles from './login.module.css';

export default function LoginForm() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isSignUp, setIsSignUp] = useState(false);
  const [loading, setLoading] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);
  const [message, setMessage] = useState('');
  const [isError, setIsError] = useState(false);
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      if (!cancelled) setCheckingSession(false);
    }, 2500);

    createClient()
      .auth.getSession()
      .then(({ data }) => {
        if (!cancelled && data.session) router.replace('/');
      })
      .finally(() => {
        if (!cancelled) {
          clearTimeout(timer);
          setCheckingSession(false);
        }
      });
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [router]);

  function formatAuthError(msg: string): string {
    const lower = msg.toLowerCase();
    if (lower.includes('rate limit') || lower.includes('over_email_send')) {
      return 'Limite d’envoi de courriels Supabase atteinte. Désactivez « Confirm email » dans Supabase, ou attendez ~1 h.';
    }
    if (lower.includes('invalid login credentials')) {
      return 'Courriel ou mot de passe incorrect.';
    }
    if (lower.includes('email not confirmed')) {
      return 'Courriel non confirmé. Vérifiez votre boîte ou désactivez « Confirm email » dans Supabase.';
    }
    return msg;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setMessage('');
    setIsError(false);
    const supabase = createClient();

    if (isSignUp) {
      const { error } = await supabase.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
      });
      setLoading(false);
      if (error) {
        setIsError(true);
        setMessage(formatAuthError(error.message));
      } else {
        setMessage('Compte créé. Connectez-vous pour continuer.');
      }
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      setLoading(false);
      if (error) {
        setIsError(true);
        setMessage(formatAuthError(error.message));
      } else {
        router.push('/');
        router.refresh();
      }
    }
  }

  return (
    <div className={styles.root}>
      {checkingSession ? (
        <p className={styles.cardSub}>Vérification de la session…</p>
      ) : (
      <div className={styles.wrap}>
        <div className={styles.brand}>
          <div className={styles.logo} aria-hidden>📈</div>
          <h1>IBKR Performance</h1>
          <p className={styles.tagline}>Suivez votre rendement TWRR et comparez aux indices.</p>
        </div>

        <div className={styles.card}>
          <p className={styles.cardTitle}>{isSignUp ? 'Créer un compte' : 'Connexion'}</p>
          <p className={styles.cardSub}>
            {isSignUp ? 'Accédez à votre espace investisseur' : 'Entrez vos identifiants pour continuer'}
          </p>

          <div className={styles.tabs} role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={!isSignUp}
              className={`${styles.tab} ${!isSignUp ? styles.tabActive : ''}`}
              onClick={() => { setIsSignUp(false); setMessage(''); }}
            >
              Connexion
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={isSignUp}
              className={`${styles.tab} ${isSignUp ? styles.tabActive : ''}`}
              onClick={() => { setIsSignUp(true); setMessage(''); }}
            >
              Inscription
            </button>
          </div>

          <form onSubmit={handleSubmit} className={styles.form}>
            <div className={styles.field}>
              <label htmlFor="email">Courriel</label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                placeholder="vous@exemple.com"
              />
            </div>
            <div className={styles.field}>
              <label htmlFor="password">Mot de passe</label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={6}
                autoComplete={isSignUp ? 'new-password' : 'current-password'}
                placeholder="6 caractères minimum"
              />
            </div>

            {message && (
              <p className={`${styles.message} ${isError ? styles.messageError : styles.messageInfo}`}>
                {message}
              </p>
            )}

            <button type="submit" className={styles.submit} disabled={loading}>
              {loading ? 'Chargement…' : isSignUp ? 'Créer mon compte' : 'Se connecter'}
            </button>
          </form>
        </div>

        <div className={styles.features}>
          <span className={styles.feature}><span className={styles.featureDot} /> TWRR</span>
          <span className={styles.feature}><span className={styles.featureDot} /> vs S&P 500</span>
          <span className={styles.feature}><span className={styles.featureDot} /> Données cloud</span>
        </div>
      </div>
      )}
    </div>
  );
}
