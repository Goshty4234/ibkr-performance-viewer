# Liste de travail — à reprendre le mois prochain

État au 29 septembre 2026 : le portage Streamlit → Next.js + Supabase + moteur FastAPI est commité et poussé sur `main` (dernier commit : cb3a49e).

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

## Rappels de fonctionnement

- Ne jamais lancer `next build` pendant que le serveur de dev tourne : vérifier avec `node node_modules\typescript\bin\tsc --noEmit -p .`.
- Ne jamais modifier `engine/backtest_engine/legacy/*.py` à la main (fichiers générés).
- Moteur local : `http://127.0.0.1:8765/health`.
