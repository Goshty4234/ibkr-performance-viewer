# Liste de travail — à reprendre le mois prochain

État au 29 septembre 2026 : le portage Streamlit → Next.js + Supabase + moteur FastAPI est commité et poussé sur `main` (dernier commit : cb3a49e).

## 1. Test de charge « tout le marché américain »

Le code gère les milliers de tickers (paquets de 80, pause entre paquets, attente progressive en cas de refus Yahoo, pas de repli ticker par ticker, cache disque partagé), mais ce n'a **jamais été testé à cette échelle** (le cache ne contenait que 58 tickers).

- [ ] Backtest sur le S&P 500 (~500 tickers), en arrière-plan, logs dans `%TEMP%`.
- [ ] Si ça passe : tout le marché US (~6 000 tickers).
- [ ] Mesurer : durée du premier téléchargement, refus Yahoo, tickers manquants, mémoire du moteur, poids du résultat dans le navigateur.
- [ ] Vérifier que le deuxième run avec les mêmes tickers ne rappelle pas Yahoo (cache).
- [ ] Corriger ce qui coince (mémoire d'une tâche portfolio, taille des tableaux d'allocations, affichage).

## 2. Rapport complet détaillé pour la section Allocations

- [ ] Faire un rapport complet et détaillé (comme le rapport PDF du backtest) pour l'onglet Allocations.
- [ ] Contenu minimum : allocation du jour, calculateur d'achat, secteurs / industries, risque, fondamentaux, benchmarks, évolution des allocations, configuration utilisée.
- [ ] Vérifier que les chiffres du rapport sont identiques à ceux affichés dans l'onglet.

## 3. Section Comptes IBKR : tester et mettre à jour

- [ ] Tester toute la section Comptes IBKR (import des relevés, performance, affichage).
- [ ] La mettre à jour au niveau du reste du site (design, tri des tableaux, infobulles, fiabilité, vitesse).
- [ ] Corriger les bugs trouvés.

## Rappels de fonctionnement

- Ne jamais lancer `next build` pendant que le serveur de dev tourne : vérifier avec `node node_modules\typescript\bin\tsc --noEmit -p .`.
- Ne jamais modifier `engine/backtest_engine/legacy/*.py` à la main (fichiers générés).
- Moteur local : `http://127.0.0.1:8765/health`.
