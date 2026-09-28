import Link from 'next/link';

export default function NotFoundCompte() {
  return (
    <div style={{ padding: '2rem', textAlign: 'center' }}>
      <h1 style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>Compte introuvable</h1>
      <p style={{ color: 'var(--text-muted)', marginBottom: '1.5rem' }}>
        Ce compte n&apos;existe pas ou a été supprimé.
      </p>
      <Link href="/ibkr" className="btn btn-primary">← Retour aux comptes IBKR</Link>
    </div>
  );
}
