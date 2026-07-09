export const dynamic = 'force-dynamic';

export default function SetupPage() {
  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '2rem',
      fontFamily: 'system-ui, sans-serif',
      background: '#080b10',
      color: '#e8edf4',
    }}>
      <div style={{
        maxWidth: 480,
        background: '#0f1419',
        border: '1px solid #243040',
        borderRadius: 16,
        padding: '2rem',
        textAlign: 'center',
      }}>
        <div style={{ fontSize: '2.5rem', marginBottom: '0.75rem' }}>⚙️</div>
        <h1 style={{ fontSize: '1.25rem', marginBottom: '0.5rem' }}>Configuration initiale</h1>
        <p style={{ color: '#7d8fa8', fontSize: '0.9rem', lineHeight: 1.6, marginBottom: '1.5rem' }}>
          Une seule fois : initialise les tables vides pour que chaque utilisateur
          puisse uploader ses propres CSV après connexion.
        </p>
        <p style={{ color: '#7d8fa8', fontSize: '0.85rem' }}>
          Demande à l&apos;assistant de lancer la configuration — il t&apos;enverra un lien à ouvrir.
        </p>
      </div>
    </div>
  );
}
