import styles from './Header.module.css';

interface Props {
  onSignOut: () => void;
  statementCount: number;
}

export default function Header({ onSignOut, statementCount }: Props) {
  return (
    <header className={styles.header}>
      <div>
        <h1>IBKR Performance</h1>
        <p className={styles.sub}>
          {statementCount > 0
            ? `${statementCount} statement${statementCount > 1 ? 's' : ''} enregistré${statementCount > 1 ? 's' : ''}`
            : 'Importez votre premier Activity Statement'}
        </p>
      </div>
      <button type="button" className="btn btn-ghost" onClick={onSignOut}>
        Déconnexion
      </button>
    </header>
  );
}
