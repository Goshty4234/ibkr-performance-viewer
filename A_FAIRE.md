# Liste de travail — à reprendre plus tard

État au 2 octobre 2026 : tout est commité et poussé sur `main` (dernier commit : 5dda2a5). Déjà en place et retiré de la liste : base de tickers permanente + section Tickers, historique SEC du nombre d'actions, section Enregistrements (portfolio seul ou run complet), moteur portable Windows avec mise à jour automatique, test de non-régression avant chaque publication.

## 0. À vérifier au prochain démarrage

- [ ] Redémarrer `run_all.py` (le moteur de dev tourne encore l'ancien code : le site le voit « trop ancien » et bloque le Run).
- [ ] Vérifier la section Tickers dans le navigateur et un run complet (les 6 075 tickers déjà en cache seront retéléchargés une fois en entier pour compléter les barres).
- [ ] Mesurer `/store/tickers` et `/store/status` sur 6 000 tickers (première lecture = migration des anciennes entrées).
- [ ] Retélécharger une fois le moteur portable si la version 1.0.0 est installée quelque part (elle ne sait pas se mettre à jour, et son MWRR sort « N/A »).

## 1. BUG — Filtre market cap ignoré quand Yahoo refuse

Constaté le 2 octobre 2026 sur un run « tout le marché US, 10 G$ minimum » : la récupération des market caps a reçu « 429 Too Many Requests » et le moteur a lancé le backtest **sans filtre** (simple avertissement). Il faut réessayer avec attente, et sinon arrêter le run avec un message clair au lieu de donner un résultat faux.

## 2. Test de charge « tout le marché américain »

Le code gère les milliers de tickers (paquets de 80, pause entre paquets, attente progressive en cas de refus Yahoo, cache disque partagé), mais un run complet à cette échelle n'a pas encore été validé de bout en bout.

- [ ] Backtest sur le S&P 500 (~500 tickers), puis tout le marché US (~6 000 tickers), en arrière-plan, logs dans `%TEMP%`.
- [ ] Mesurer : durée du premier téléchargement, refus Yahoo, tickers manquants, mémoire du moteur, poids du résultat dans le navigateur.
- [ ] Vérifier que le deuxième run avec les mêmes tickers ne rappelle pas Yahoo (base de tickers).
- [ ] Corriger ce qui coince (mémoire d'une tâche portfolio, taille des tableaux d'allocations, affichage).

## 3. Momentum sur toutes les actions au-dessus d'un market cap (ex. 10 G$)

But : attraper les « rising stars » avant leur entrée dans le S&P 500, en coupant les petites compagnies.

- [ ] Backtest momentum sur tout le marché US avec « Market cap minimum » à 10 G$ (dépend des points 1 et 2).
- [ ] Vérifier que l'option est prise en charge partout : moteur, variantes (« - MinCap 10B »), résultats, rapport, allocations du jour.
- [ ] Comparer avec le même momentum sur le S&P 500 seul (rendement, drawdown, rotation) et plusieurs seuils (2, 5, 10, 20 G$).
- [ ] Limites restantes du market cap historique (le nombre d'actions vient maintenant de la SEC pour 5 355 / 6 075 tickers) :
  - biais de survivance : les compagnies disparues ou radiées ne sont plus sur Yahoo, donc absentes de l'univers ;
  - sociétés étrangères en IFRS (AZN, NVO, BP…), fonds fermés : repli sur l'estimation par le prix ;
  - spin-off enregistré comme « split » par Yahoo (DELL 2021) : market cap passée sous-estimée ~2× pour ces rares cas.
- [ ] Optionnel : utiliser les fiches archivées (`quote_store`) pour les indices de référence d'Allocations au lieu d'un nouvel appel.

## 4. NOUVEAU — Score momentum « proportionnel par fenêtre » (plafonné au poids de chaque fenêtre)

Problème : aujourd'hui une action qui explose une seule fenêtre (ex. +100 000 % sur 120 jours) peut passer devant alors qu'elle s'effondre sur les autres fenêtres.

Idée : chaque fenêtre donne au plus son propre poids au score final.

1. Pour chaque fenêtre, on calcule le rendement de chaque action.
2. On normalise par rapport à la meilleure action de cette fenêtre : la meilleure reçoit 100 % du poids de la fenêtre, les autres proportionnellement (score = rendement ÷ meilleur rendement).
3. Score final = somme sur les fenêtres de (poids de la fenêtre × score normalisé). Maximum possible 100 : une action première dans toutes les fenêtres.

Exemple : fenêtres 365-30 à 50 %, 180-30 à 30 %, 120-30 à 20 %. Sur 365-30, rendements 100 %, 50 %, 25 % → scores 100 %, 50 %, 25 % du poids 50 → 50, 25 et 12,5 points. Idem pour les autres fenêtres, puis on additionne.

- [ ] Décider des cas limites :
  - rendements négatifs : mettre à 0, ou normaliser entre le pire et le meilleur (min-max) ;
  - meilleur rendement ≤ 0 dans une fenêtre ;
  - une action extrême écrase les autres vers 0 dans sa fenêtre : envisager aussi une variante par rang (percentile), plus robuste, à comparer.
- [ ] Ajouter l'option dans le moteur (désactivée par défaut, pour que les anciens résultats et la non-régression ne bougent pas), dans l'éditeur de portfolio (avec infobulle), dans l'export / import JSON et dans le rapport.
- [ ] Ajouter une configuration de test dans `engine/tests/regression` et comparer avec la pondération actuelle (rendement, drawdown, rotation).

## 5. Monte Carlo sur vraies actions — fait (4 octobre 2026)

Remplace l'ancien Monte Carlo à actions simulées. Chaque tirage prend N actions au hasard dans un univers réel (S&P 500 actuel, actions américaines, tickers des portfolios ou liste perso) et fait rouler tous les portfolios sur ces mêmes actions, comme un run normal (mêmes options : entrée S&P 500, market cap minimum, filtres…), plus une référence équipondérée. Résultat : toutes les courbes, le face-à-face par tirage (part des tirages gagnés, écart de CAGR), les distributions.

- [ ] Le lancer sur le S&P 500 (50 tirages × 30 actions) et vérifier le temps réel sur le PC.
- [ ] Idées : biais de survivance (ajouter les compagnies sorties de l'indice si on trouve leurs prix), coûts de transaction, tirages stratifiés par secteur.

## 6. Rapport complet détaillé pour la section Allocations

- [ ] Faire un rapport complet et détaillé (comme le rapport PDF du backtest) pour l'onglet Allocations.
- [ ] Contenu minimum : allocation du jour, calculateur d'achat, secteurs / industries, risque, fondamentaux, benchmarks, évolution des allocations, configuration utilisée.
- [ ] Vérifier que les chiffres du rapport sont identiques à ceux affichés dans l'onglet.

## 7. Section Comptes IBKR : tester et mettre à jour

- [ ] Tester toute la section Comptes IBKR (import des relevés, performance, affichage).
- [ ] La mettre à jour au niveau du reste du site (design, tri des tableaux, infobulles, fiabilité, vitesse).
- [ ] Corriger les bugs trouvés.
- [ ] Vérifier le terminal du serveur de dev, qui affiche souvent en rafale :
  `GET /ibkr/compte/00000000-0000-0000-0000-000000000000`, puis `/api/accounts`, `/api/statements`, `/api/nav-series`, `/api/twr-series` avec `portfolioAccountId=00000000-…`.
  L'identifiant tout à zéro ressemble à un compte factice (valeur par défaut) : vérifier d'où viennent ces appels, s'ils sont normaux, et les supprimer s'ils sont inutiles (charge Supabase et serveur).

## 8. Moteur hébergé en ligne (ex. Oracle Cloud)

Le moteur tourne aujourd'hui sur le PC de chacun (moteur portable). Un moteur en ligne permettrait de calculer sans rien installer. Le site sait déjà parler à un moteur « en ligne » (mode avec authentification).

- [ ] Choisir l'hébergeur (ex. Oracle Cloud, offre gratuite Ampere ARM) et vérifier CPU / mémoire pour les gros univers (point 2).
- [ ] Déployer le moteur FastAPI (image Docker déjà prête : `engine/Dockerfile`), cache disque persistant, redémarrage automatique.
- [ ] Sécuriser : HTTPS, authentification obligatoire, limite de jobs simultanés, pas d'accès public sans compte.
- [ ] Vérifier que Yahoo ne bloque pas l'adresse IP du serveur (les IP de cloud sont souvent plus limitées).
- [ ] Surveiller la consommation : disque du cache, mémoire, nettoyage des résultats et jobs expirés.

## 9. Moteur portable : suite

- [ ] **Ajouter Mac** (Apple Silicon + Intel) : Python autonome (ex. python-build-standalone), lanceur `.command`, dossier de données `~/Library/Application Support/MomentumBacktester`, build sur un runner `macos-latest`.
- [ ] Signer l'exécutable Windows (évite l'avertissement SmartScreen) si le site devient public.
- [ ] Réparer `tests/parity/run_parity.py` (comparaison au code Streamlit d'origine) : ses enregistrements Yahoo datent d'avant la base de tickers, les 9 configurations plantent sur « Not recorded ».

## Rappels de fonctionnement

- **Moteur accéléré** : `backtest_engine/accel/single_backtest_fast.py` est une copie de `single_backtest` (legacy) où seules les lectures de prix changent (tableaux numpy au lieu de `.loc` jour par jour). Si le fichier legacy est régénéré depuis Streamlit, reporter le changement dans la copie ; `ENGINE_LEGACY_LOOP=1` fait tourner l'ancienne fonction pour comparer. Le test de non-régression tourne à chaque publication du moteur ; `py -3.13 -m tests.montecarlo.test_real_draws` (depuis engine/) vérifie qu'un tirage du Monte Carlo égale un run normal.

- Ne jamais lancer `next build` pendant que le serveur de dev tourne : vérifier avec `node node_modules\typescript\bin\tsc --noEmit -p .`.
- Ne jamais modifier `engine/backtest_engine/legacy/*.py` à la main (fichiers générés).
- Moteur local : `http://127.0.0.1:8765/health`.
- **Changement voulu des résultats du moteur** : `cd engine; py -3.13 -m tests.regression.run_regression --rebaseline`, puis commiter `tests/regression/baseline/` avec le code (sinon la publication du moteur échoue).
- **Le site a besoin d'une nouveauté du moteur** : augmenter `API_VERSION` (`engine/backtest_engine/__init__.py`) et `ENGINE_API` (`src/lib/engine/client.ts`) ensemble.
- **Changer de domaine** : ajouter la nouvelle adresse dans `engine/allowed_origins.txt` et pousser (les moteurs installés la relisent au démarrage) ; l'ajouter aussi dans Supabase → Authentication → URL Configuration (Site URL + Redirect URLs) et dans les domaines Vercel.
- Publication du moteur portable : automatique à chaque push qui touche `engine/` (seulement si le code ou les librairies ont changé). Build local : `py -3.13 engine/tools/build_portable.py`.
