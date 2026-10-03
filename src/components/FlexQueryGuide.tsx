import styles from './FlexQueryGuide.module.css';

/** How to build the IBKR Flex Query the importer understands (fields match src/lib/flex-csv.ts). */
export default function FlexQueryGuide() {
  return (
    <details className={styles.guide}>
      <summary>Comment créer le fichier IBKR (Flex Query) ?</summary>
      <div className={styles.body}>
        <p>
          Dans le portail IBKR : <b>Performance &amp; Reports → Flex Queries → Activity Flex Query → Create</b>.
          Donne un nom à la requête, puis règle :
        </p>

        <h4>1. Section « Net Asset Value (NAV) in Base »</h4>
        <p>Coche ces champs (les autres sont inutiles) :</p>
        <ul className={styles.fields}>
          <li>Account ID</li>
          <li>Currency</li>
          <li>Report Date</li>
          <li>Cash</li>
          <li>Stock</li>
          <li>Options</li>
          <li>Total <small>(tout en bas de la liste)</small></li>
          <li>Account Alias <small>(facultatif)</small></li>
        </ul>
        <p>Laisse « Exclude prior report date » et « Exclude long and short breakout » décochés.</p>

        <h4>2. Section « Cash Transactions »</h4>
        <p>
          Dans « Options », coche seulement <b>Deposits &amp; Withdrawals</b> (les dividendes, intérêts et frais
          ne servent pas ici), et choisis <b>Detail</b> (pas Summary). Champs à cocher :
        </p>
        <ul className={styles.fields}>
          <li>Account ID</li>
          <li>Currency</li>
          <li>Asset Class</li>
          <li>FX Rate To Base</li>
          <li>Settle Date <small>(ou Date/Time)</small></li>
          <li>Type</li>
          <li>Description</li>
          <li>Amount</li>
        </ul>
        <p>Elle sert à repérer tes dépôts, retraits et transferts pour le calcul du rendement (TWR).</p>

        <h4>3. Configuration</h4>
        <ul>
          <li><b>Format</b> : CSV</li>
          <li><b>Period</b> : Last 365 Calendar Days (ou une plage de dates personnalisée au moment de lancer la requête)</li>
          <li><b>Date Format</b> : yyyyMMdd ou yyyy-MM-dd</li>
          <li><b>Breakout by Day</b> : <b>Yes</b> (indispensable : une NAV par jour)</li>
          <li><b>Include Currency Rates</b> : Yes</li>
          <li><b>Display Account Alias in Place of Account ID</b> : No</li>
          <li>Le reste : valeurs par défaut</li>
        </ul>

        <h4>4. Importer</h4>
        <p>
          Enregistre la requête, lance-la (« Run », format CSV), puis glisse le fichier ici.
          <b> Un seul compte par fichier</b> : refais l’opération pour chaque compte.
        </p>
      </div>
    </details>
  );
}
