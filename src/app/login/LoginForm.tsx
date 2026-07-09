'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useRouter } from 'next/navigation';
import styles from './login.module.css';

type FormMode = 'login' | 'signup' | 'forgot';

export default function LoginForm() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<FormMode>('login');
  const [loading, setLoading] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);
  const [message, setMessage] = useState('');
  const [isError, setIsError] = useState(false);
  const router = useRouter();

  const isSignUp = mode === 'signup';
  const isForgot = mode === 'forgot';

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

    if (isForgot) {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/auth/callback?next=/auth/reset-password`,
      });
      setLoading(false);
      if (error) {
        setIsError(true);
        setMessage(formatAuthError(error.message));
      } else {
        setIsError(false);
        setMessage(
          'Si un compte existe pour ce courriel, un lien de réinitialisation vient d’être envoyé. Vérifiez votre boîte (et les indésirables).',
        );
      }
      return;
    }

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
          <p className={styles.cardTitle}>
            {isForgot ? 'Mot de passe oublié' : isSignUp ? 'Créer un compte' : 'Connexion'}
          </p>
          <p className={styles.cardSub}>
            {isForgot
              ? 'Entrez votre courriel — nous vous enverrons un lien de réinitialisation'
              : isSignUp
                ? 'Accédez à votre espace investisseur'
                : 'Entrez vos identifiants pour continuer'}
          </p>

          {!isForgot && (
          <div className={styles.tabs} role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'login'}
              className={`${styles.tab} ${mode === 'login' ? styles.tabActive : ''}`}
              onClick={() => { setMode('login'); setMessage(''); }}
            >
              Connexion
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'signup'}
              className={`${styles.tab} ${mode === 'signup' ? styles.tabActive : ''}`}
              onClick={() => { setMode('signup'); setMessage(''); }}
            >
              Inscription
            </button>
          </div>
          )}

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
            {!isForgot && (
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
            )}

            {mode === 'login' && (
              <button
                type="button"
                className={styles.forgotLink}
                onClick={() => { setMode('forgot'); setMessage(''); setIsError(false); }}
              >
                Mot de passe oublié ?
              </button>
            )}

            {message && (
              <p className={`${styles.message} ${isError ? styles.messageError : styles.messageInfo}`}>
                {message}
              </p>
            )}

            <button type="submit" className={styles.submit} disabled={loading}>
              {loading
                ? 'Chargement…'
                : isForgot
                  ? 'Envoyer le lien'
                  : isSignUp
                    ? 'Créer mon compte'
                    : 'Se connecter'}
            </button>

            {isForgot && (
              <button
                type="button"
                className={styles.backLink}
                onClick={() => { setMode('login'); setMessage(''); setIsError(false); }}
              >
                ← Retour à la connexion
              </button>
            )}
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
