# Liste de travail — à reprendre le mois prochain

État au 29 septembre 2026 : le portage Streamlit → Next.js + Supabase + moteur FastAPI est commité et poussé sur `main` (dernier commit : cb3a49e).

## 0. PRIORITÉ — Base de tickers permanente + section Tickers

Idée : chaque ticker appelé une fois est gardé en entier (historique complet), sans expiration. Un run reprend les tickers déjà en base ; s'ils ne sont pas à jour, le site demande : utiliser tel quel (fin du backtest au dernier jour disponible), compléter seulement les jours manquants sur Yahoo, ou tout retélécharger. Nouvelle section du site pour parcourir tous les tickers en base, même hors ligne : graphique dans le temps, moyennes mobiles, etc.

- [x] Stockage permanent par ticker (historique complet + date du dernier jour confirmé par Yahoo) — `engine/backtest_engine/price_store.py`.
- [x] On garde tout ce que la requête de prix renvoie : clôture, dividendes + ouverture, haut, bas, volume, splits (compressés à part, les runs ne lisent que clôture + dividendes).
- [x] Fiche Yahoo complète (≈ 70-80 champs : market cap, PER, BPA, rendement, actions, 52 sem., nom…) archivée chaque jour de mise à jour — `quote_store.py`. Yahoo ne donne pas l'historique du market cap / PER : on le construit à partir de maintenant.
- [x] Complément des jours manquants avec contrôle (10 jours de chevauchement, split ou écart → retéléchargement complet du ticker).
- [x] Fenêtre au lancement : utiliser tel quel / compléter / tout retélécharger.
- [x] Section Tickers : liste (nom, market cap, PER, état), recherche, graphique, 2 moyennes mobiles, bougies, volume, fiche + historique archivé.
- [x] Tests (dossier temporaire, 55 tickers) : complément = téléchargement complet à 0 écart (3 / 10 / 30 / 120 / 400 jours, prix + barres), 6 splits réels et 6 dividendes OK, écart simulé → retéléchargé, Yahoo injoignable → données gardées et pas marquées à jour, mode « tel quel » sans réseau.
- [ ] Après redémarrage du moteur : vérifier la section Tickers dans le navigateur et un run complet (les 6 075 tickers déjà en cache seront retéléchargés une fois en entier pour compléter les barres).
- [ ] Mesurer `/store/tickers` et `/store/status` sur 6 000 tickers (première lecture = migration des anciennes entrées).

## 0 ter. Données détaillées : décision (2 octobre 2026)

Pas de téléchargement de masse des fiches détaillées Yahoo (1 requête par ticker = spam pour peu de valeur).

- [x] Historique du nombre d'actions de **tout le marché** via la SEC (pas Yahoo) : 1 requête = toutes les entreprises pour un trimestre — `share_history.py`. Deux sources : nombre d'actions de la page de garde (4 764 tickers), sinon moyenne pondérée toutes classes du compte de résultat (+591 : META, GOOGL depuis 2022, PLTR, DELL…). ~160 requêtes une seule fois (~40 s), ensuite seuls les trimestres récents sont revérifiés, au plus une fois par semaine et seulement quand un run utilise le filtre ; si la SEC ne répond pas, la copie stockée sert. Couverture 5 355 / 6 075. Repli sur l'estimation pour le reste (sociétés étrangères en IFRS comme AZN / NVO / BP, fonds fermés, chiffre SEC incohérent avec Yahoo aujourd'hui).
- [ ] Limite connue : quand Yahoo enregistre un spin-off comme un « split » (DELL 2021), la moyenne pondérée n'est pas ajustée (la société n'a pas retraité ses chiffres) → market cap passée sous-estimée ~2× pour ces rares cas.
- [x] L'avenir se remplit tout seul : la fiche Yahoo archivée chaque jour contient `sharesOutstanding`.
- Fiches détaillées (secteur, PER, rendement…) : seulement pour la sélection finale (Allocations, déjà le cas : 1 appel groupé, gardé 24 h) et à la demande dans la section Tickers.
- [ ] Optionnel : utiliser les fiches archivées (`quote_store`) pour les indices de référence d'Allocations au lieu d'un nouvel appel.

## 0 bis. BUG — Filtre market cap ignoré quand Yahoo refuse

Constaté le 2 octobre 2026 sur un run « tout le marché US, 10 G$ minimum » : la récupération des market caps a reçu « 429 Too Many Requests » et le moteur a lancé le backtest **sans filtre** (simple avertissement). Il faut réessayer avec attente, et sinon arrêter le run avec un message clair au lieu de donner un résultat faux.

## 1. Test de charge « tout le marché américain »

Le code gère les milliers de tickers (paquets de 80, pause entre paquets, attente progressive en cas de refus Yahoo, pas de repli ticker par ticker, cache disque partagé), mais ce n'a **jamais été testé à cette échelle** (le cache ne contenait que 58 tickers).

- [ ] Backtest sur le S&P 500 (~500 tickers), en arrière-plan, logs dans `%TEMP%`.
- [ ] Si ça passe : tout le marché US (~6 000 tickers).
- [ ] Mesurer : durée du premier téléchargement, refus Yahoo, tickers manquants, mémoire du moteur, poids du résultat dans le navigateur.
- [ ] Vérifier que le deuxième run avec les mêmes tickers ne rappelle pas Yahoo (cache).
- [ ] Corriger ce qui coince (mémoire d'une tâche portfolio, taille des tableaux d'allocations, affichage).

## 2. Momentum sur toutes les actions au-dessus d'un market cap (ex. 10 G$)

But : aller au-delà du S&P 500 et attraper les « rising stars » avant leur entrée dans l'indice. On sait que le momentum marche sur le S&P 500 ; on veut voir ce qui se serait passé si une action entrait dans le momentum dès qu'elle dépasse un seuil de capitalisation, en coupant les petites compagnies.

- [ ] Backtest momentum sur un grand univers (tout le marché US) avec le filtre « Market cap minimum » à 10 G$ (dépend du test de charge du point 1).
- [ ] Vérifier que l'option market cap est bien prise en charge partout : moteur, variantes (« - MinCap 10B »), résultats, rapport, allocations du jour.
- [ ] Comparer avec le même momentum sur le S&P 500 seul (rendement, drawdown, rotation) et essayer plusieurs seuils (2, 5, 10, 20 G$).
- [ ] **Évaluer la fiabilité du seuil historique.** Le market cap passé est estimé : cap(date) ≈ cap d'aujourd'hui × (prix à cette date / prix d'aujourd'hui), avec le market cap actuel de Yahoo. Limites à mesurer :
  - émissions d'actions et rachats ignorés (le nombre d'actions n'est pas historique) ;
  - biais de survivance : les compagnies disparues ou radiées ne sont plus sur Yahoo, donc absentes de l'univers ;
  - compagnies sans market cap chez Yahoo exclues d'office.
- [ ] Contrôler l'estimation sur quelques cas connus (market cap réel à une date passée vs estimé), puis conclure : seuil représentatif ou seulement très approximatif.
- [ ] Si trop approximatif : chercher une source de nombre d'actions historique (ou de market cap historique) pour le rendre fiable.

## 3. Rapport complet détaillé pour la section Allocations

- [ ] Faire un rapport complet et détaillé (comme le rapport PDF du backtest) pour l'onglet Allocations.
- [ ] Contenu minimum : allocation du jour, calculateur d'achat, secteurs / industries, risque, fondamentaux, benchmarks, évolution des allocations, configuration utilisée.
- [ ] Vérifier que les chiffres du rapport sont identiques à ceux affichés dans l'onglet.

## 4. Section Comptes IBKR : tester et mettre à jour

- [ ] Tester toute la section Comptes IBKR (import des relevés, performance, affichage).
- [ ] La mettre à jour au niveau du reste du site (design, tri des tableaux, infobulles, fiabilité, vitesse).
- [ ] Corriger les bugs trouvés.
- [ ] Vérifier le terminal du serveur de dev, qui affiche souvent en rafale :
  `GET /ibkr/compte/00000000-0000-0000-0000-000000000000`, puis `/api/accounts`, `/api/statements`, `/api/nav-series`, `/api/twr-series` avec `portfolioAccountId=00000000-…`.
  L'identifiant tout à zéro ressemble à un compte factice (valeur par défaut) : vérifier d'où viennent ces appels (préchargement des liens, rechargement en boucle, onglet ouvert), s'ils sont normaux, et les supprimer s'ils sont inutiles (charge Supabase et serveur).

## 5. Mettre le site en ligne avec un moteur hébergé (ex. Oracle Cloud)

Aujourd'hui le moteur de calcul ne tourne que sur le PC (`127.0.0.1:8765`) : sans le PC allumé, pas de backtest. Le site sait déjà parler à un moteur « en ligne » (mode avec authentification), il faut l'héberger et le brancher.

- [ ] Choisir l'hébergeur (ex. Oracle Cloud, offre gratuite Ampere ARM) et vérifier CPU / mémoire suffisants pour les gros univers (voir point 1).
- [ ] Déployer le moteur FastAPI (Python, dépendances, cache disque des prix persistant, redémarrage automatique).
- [ ] Sécuriser : HTTPS, authentification obligatoire, limite de jobs simultanés, pas d'accès public sans compte.
- [ ] Brancher le site (Next.js + Supabase) sur ce moteur et garder le choix « Mon PC » / « En ligne ».
- [ ] Vérifier que Yahoo ne bloque pas l'adresse IP du serveur (les IP de cloud sont souvent plus limitées qu'une IP maison).
- [ ] Surveiller la consommation : disque du cache, mémoire, nettoyage des résultats et jobs expirés.

## 6. Moteur portable (calcul sur le PC du visiteur)

- [x] Windows : zip `MomentumBacktesterEngine-win64.zip` (Python embarqué + librairies + moteur, ~104 Mo ; une mise à jour du code seul fait ~0,6 Mo). Données dans `%LOCALAPPDATA%\MomentumBacktester`. Build local : `py -3.13 engine/tools/build_portable.py`.
- [x] Publication automatique : chaque push qui touche `engine/` construit le paquet, lance le test de non-régression avec le Python embarqué, et publie une Release seulement si le code ou les librairies ont changé (`.github/workflows/engine-portable.yml`).
- [x] Mise à jour automatique des moteurs installés (`engine/backtest_engine/updater.py`) : au démarrage, comparaison avec `manifest.json` de la dernière Release ; code changé → `engine-code.zip` (quelques Mo) ; Python / librairies changés → paquet complet ; empreinte SHA-256 vérifiée, import testé, bascule, retour automatique à la version précédente si elle ne démarre pas. Les données ne sont jamais touchées.
- [x] Compatibilité site ↔ moteur : `API_VERSION` (moteur) et `ENGINE_API` (`src/lib/engine/client.ts`). **Quand le site a besoin d'une nouveauté du moteur, augmenter les deux en même temps** : le site bloque alors le Run sur un moteur plus ancien et propose « Mettre à jour le moteur ».
- [x] Test de non-régression : `cd engine; py -3.13 -m tests.regression.run_regression` (9 configurations, prix figés dans `prices.zip`, hors ligne, fin au 30/09/2026). **Un changement voulu des résultats** : `--rebaseline`, puis commiter `tests/regression/baseline/` avec le code (sinon la publication du moteur échoue).
- [ ] Réparer `tests/parity/run_parity.py` (comparaison au code Streamlit d'origine) : ses enregistrements Yahoo datent d'avant la base de tickers, les 9 configurations plantent sur « Not recorded ».
- [ ] **Ajouter Mac** (Apple Silicon + Intel) : Python autonome (ex. python-build-standalone), lanceur `.command`, dossier de données `~/Library/Application Support/MomentumBacktester`, build sur un runner `macos-latest`.
- [ ] Signer l'exécutable Windows (évite l'avertissement SmartScreen) si le site devient public.
- Changer de domaine : ajouter la nouvelle adresse dans `engine/allowed_origins.txt` et pousser (les moteurs déjà installés la relisent au démarrage, pas de réinstallation) ; ajouter aussi l'adresse dans Supabase → Authentication → URL Configuration (Site URL + Redirect URLs) et dans les domaines Vercel.

## Rappels de fonctionnement

- Ne jamais lancer `next build` pendant que le serveur de dev tourne : vérifier avec `node node_modules\typescript\bin\tsc --noEmit -p .`.
- Ne jamais modifier `engine/backtest_engine/legacy/*.py` à la main (fichiers générés).
- Moteur local : `http://127.0.0.1:8765/health`.
