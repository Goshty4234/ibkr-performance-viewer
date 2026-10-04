import type { ReactNode } from 'react';
import styles from './FlexQueryGuide.module.css';

/**
 * Step-by-step recipe for the IBKR Flex Query the importer reads (field names match
 * src/lib/flex-csv.ts and ibkr-flex-combined.ts: a NAV block and a Change in NAV block,
 * CSV, one column-header row per block, rows starting with the account id).
 */

function Yes({ children, note }: { children: ReactNode; note?: string }) {
  return (
    <li className={styles.yes}>
      <span className={styles.mark} aria-label="à cocher">✔</span>
      <span>{children}{note && <small> {note}</small>}</span>
    </li>
  );
}

function No({ children, note }: { children: ReactNode; note?: string }) {
  return (
    <li className={styles.no}>
      <span className={styles.mark} aria-label="ne pas cocher">✘</span>
      <span>{children}{note && <small> {note}</small>}</span>
    </li>
  );
}

function Setting({ name, value, note }: { name: string; value: string; note?: string }) {
  return (
    <tr>
      <td>{name}</td>
      <td><b>{value}</b>{note && <small> {note}</small>}</td>
    </tr>
  );
}

export default function FlexQueryGuide({ defaultOpen = false, prominent = false }: { defaultOpen?: boolean; prominent?: boolean }) {
  return (
    <details className={`${styles.guide} ${prominent ? styles.prominent : ''}`} open={defaultOpen || undefined}>
      <summary>
        {prominent ? '📄 Première étape : comment obtenir ton fichier CSV IBKR (Flex Query) ? Guide pas à pas' : 'Comment créer le fichier IBKR (Flex Query) ? Guide pas à pas'}
      </summary>
      <div className={styles.body}>
        <p className={styles.lead}>
          Suis exactement ce guide : il te donne <b>quoi cocher</b> (✔) et <b>quoi laisser décoché</b> (✘).
          Un seul fichier suffit pour un compte, avec deux sections : la valeur du compte jour par jour,
          et le rendement officiel de IBKR (avec tous tes dépôts, retraits et transferts de titres, déjà exclus).
        </p>

        <h4>Étape 1 : ouvrir la création</h4>
        <ol>
          <li>Connecte-toi au portail IBKR (Client Portal).</li>
          <li>Va dans <b>Performance &amp; Reports → Flex Queries</b>.</li>
          <li>Dans le bloc <b>Activity Flex Query</b>, clique sur le <b>+</b> (Create).</li>
          <li><b>Query Name</b> : écris ce que tu veux, par exemple <code>Performance Viewer</code>.</li>
        </ol>

        <h4>Étape 2 : choisir les deux sections</h4>
        <p>Dans la grande liste « Sections », coche seulement ces deux-là :</p>
        <ul className={styles.list}>
          <Yes>Net Asset Value (NAV) in Base</Yes>
          <Yes note="(c’est elle qui donne le rendement exact et tous les transferts de titres)">Change in NAV</Yes>
          <No note="(pas besoin : Change in NAV contient déjà les dépôts, retraits et transferts)">Cash Transactions, Transfers</No>
          <No note="(ce sont d’autres sections, avec des noms qui se ressemblent)">Cash Report, Trades, Open Positions, Statement of Funds, etc.</No>
        </ul>
        <p>Chaque section cochée s’ouvre avec ses propres options : voir les étapes 3 et 4.</p>

        <h4>Étape 3 : section « Net Asset Value (NAV) in Base »</h4>
        <p>Ne clique <b>pas</b> sur « Select All ». Coche un par un :</p>
        <ul className={styles.list}>
          <Yes>Account ID</Yes>
          <Yes>Currency</Yes>
          <Yes>Report Date</Yes>
          <Yes>Cash</Yes>
          <Yes>Stock</Yes>
          <Yes>Options</Yes>
          <Yes note="(tout en bas de la liste, après Crypto : ne l’oublie pas)">Total</Yes>
          <Yes note="(facultatif : le nom de ton compte)">Account Alias</Yes>
          <No>Tous les autres champs (Model, Bonds, Funds, Accruals, Crypto…)</No>
          <No>Les deux cases du haut : « Exclude prior report date » et « Exclude long and short breakout » restent décochées</No>
        </ul>

        <h4>Étape 4 : section « Change in NAV »</h4>
        <p>Garde les options du haut par défaut. Dans la liste des champs (toujours sans « Select All »), coche :</p>
        <ul className={styles.list}>
          <Yes>Account ID</Yes>
          <Yes>From Date</Yes>
          <Yes>To Date</Yes>
          <Yes>Starting Value</Yes>
          <Yes>Ending Value</Yes>
          <Yes note="(le rendement journalier officiel de IBKR : le champ le plus important)">TWR</Yes>
          <Yes note="(tes dépôts et retraits d’argent)">Deposits &amp; Withdrawals</Yes>
          <Yes note="(les titres qui entrent ou sortent de ton compte)">Asset Transfers</Yes>
          <Yes note="(les transferts d’argent entre tes comptes)">Internal Cash Transfers</Yes>
          <No>Tous les autres champs (Mtm, Realized, Dividends, Commissions, Interest…)</No>
        </ul>
        <p><small>Avec « Breakout by Day » à Yes (étape 5), IBKR écrit une ligne par jour, c’est ce qu’il faut.</small></p>

        <h4>Étape 5 : réglages du bas de la page</h4>
        <p><b>Filters</b> : ne touche à rien (aucun symbole).</p>
        <table className={styles.table}>
          <tbody>
            <tr><th colSpan={2}>Delivery Configuration</th></tr>
            <Setting name="Accounts" value="ton compte" note="(déjà choisi)" />
            <Setting name="Models" value="rien (Optional)" />
            <Setting name="Format" value="CSV" />
            <Setting name="Include header and trailer records?" value="No" />
            <Setting name="Include column headers?" value="Yes" note="(indispensable)" />
            <Setting name="Display single column header row?" value="No" />
            <Setting name="Include section code and line descriptor?" value="No" note="(sinon le site ne lit aucune ligne)" />
            <Setting name="Period" value="Last 365 Calendar Days" />
            <tr><th colSpan={2}>General Configuration</th></tr>
            <Setting name="Date Format" value="yyyyMMdd" note="(ou yyyy-MM-dd)" />
            <Setting name="Time Format" value="ne change rien" />
            <Setting name="Date/Time Separator" value="ne change rien" />
            <Setting name="Profit and Loss" value="Default" />
            <Setting name="Include Offsetting Trade/Cancel Pairs?" value="No" />
            <Setting name="Include Currency Rates?" value="Yes" />
            <Setting name="Include Audit Trail Fields?" value="No" />
            <Setting name="Display Account Alias in Place of Account ID?" value="No" note="(le site a besoin du numéro de compte)" />
            <Setting name="Breakout by Day?" value="Yes" note="(indispensable : une valeur par jour)" />
          </tbody>
        </table>
        <p>Clique ensuite sur <b>Continue</b>, vérifie le résumé, puis <b>Create</b>.</p>

        <h4>Étape 6 : lancer la requête et importer</h4>
        <ol>
          <li>Dans la liste de tes Activity Flex Queries, clique sur la flèche <b>Run</b> de ta requête.</li>
          <li>Choisis le format <b>CSV</b> et la période voulue, puis <b>Run</b>. Pour plus d’un an d’historique, choisis une plage de dates personnalisée, ou lance plusieurs périodes.</li>
          <li>Télécharge le fichier, puis glisse-le dans la zone d’import ci-dessus.</li>
        </ol>

        <h4>À savoir</h4>
        <ul>
          <li><b>Un seul compte par fichier.</b> Si tu as plusieurs comptes, refais l’opération pour chacun.</li>
          <li>Si le site dit « format non reconnu », vérifie en priorité : <i>Include column headers = Yes</i>, <i>Include section code = No</i>, <i>Breakout by Day = Yes</i> et le champ <i>Total</i>.</li>
          <li>Cocher des champs en plus ne casse rien : ils sont ignorés, le fichier est juste plus gros.</li>
        </ul>
      </div>
    </details>
  );
}
