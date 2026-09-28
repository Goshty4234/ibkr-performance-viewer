import Header from './Header';
import styles from './AppShell.module.css';

interface Props {
  children: React.ReactNode;
  email?: string | null;
  guest?: boolean;
}

export default function AppShell({ children, email, guest = false }: Props) {
  return (
    <div className={styles.shell}>
      <Header email={email} guest={guest} />
      <main className={styles.main}>{children}</main>
    </div>
  );
}
