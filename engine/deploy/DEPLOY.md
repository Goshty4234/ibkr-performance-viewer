# Mettre le moteur en ligne

Le site détecte tout seul le moteur à utiliser :

1. **Mon PC** : si `Lancer le moteur.bat` tourne, le site utilise `http://127.0.0.1:8765` (gratuit, le plus rapide).
2. **En ligne** : sinon, il utilise l'URL cloud configurée (Paramètres → Moteur, ou `NEXT_PUBLIC_ENGINE_CLOUD_URL` sur Vercel).

Le moteur en ligne est **le même code** que sur ton PC, emballé dans une image Docker. Changer d'hébergeur =
relancer la même commande ailleurs et coller la nouvelle URL dans Paramètres. Rien d'autre à modifier.

---

## Option A — n'importe quel serveur Linux avec Docker (recommandé)

Il faut un serveur (VM) Linux accessible depuis Internet, ports 80 et 443 ouverts.

```bash
# 1. Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER && newgrp docker

# 2. Le code (seul le dossier engine/ est utilisé)
git clone https://github.com/Goshty4234/ibkr-performance-viewer.git
cd ibkr-performance-viewer/engine/deploy

# 3. Configuration
cp .env.example .env
nano .env        # ENGINE_DOMAIN, SUPABASE_URL, SUPABASE_ANON_KEY

# 4. Démarrage (HTTPS automatique)
docker compose up -d --build
docker compose logs -f engine
```

Test : `https://TON_DOMAINE/health` doit répondre `{"status":"ok",...}`.
Ensuite, sur le site : **Paramètres → Moteur → URL cloud** = `https://TON_DOMAINE`.

Mise à jour du moteur : `git pull && docker compose up -d --build`.

### Nom de domaine gratuit

Caddy a besoin d'un nom de domaine pour le certificat HTTPS :

- **sslip.io** (zéro inscription) : IP `203.0.113.7` → `203-0-113-7.sslip.io`.
- **DuckDNS** : `monbacktest.duckdns.org`, gratuit.
- Ou un sous-domaine de ton propre domaine (enregistrement A vers l'IP du serveur).

---

## Exemple gratuit : Oracle Cloud « Always Free »

Oracle offre gratuitement une VM ARM Ampere jusqu'à **4 vCPU / 24 Go de RAM**, sans limite de durée
(plus puissant que Streamlit Community Cloud).

1. Crée un compte sur [cloud.oracle.com](https://cloud.oracle.com) (carte demandée pour vérification, pas débitée
   tant que tu restes sur les ressources « Always Free »).
2. **Compute → Instances → Create instance**
   - Image : *Canonical Ubuntu 24.04*
   - Shape : *Ampere → VM.Standard.A1.Flex*, 4 OCPU, 24 Go
   - Ajoute ta clé SSH.
   - Si « Out of capacity » : réessaie plus tard ou prends 2 OCPU / 12 Go.
3. **Ouvrir les ports 80/443**
   - Réseau : *Virtual Cloud Network → Security List → Add Ingress Rules* : `0.0.0.0/0`, TCP, ports `80,443`.
   - Sur la VM (Ubuntu d'Oracle bloque tout par défaut) :

     ```bash
     sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
     sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
     sudo netfilter-persistent save
     ```
4. Suis l'**option A** ci-dessus. Avec 4 vCPU, tu peux mettre `ENGINE_MAX_JOBS=2`.

## Autres hébergeurs (si le budget change)

| Hébergeur | Prix indicatif | Remarque |
|---|---|---|
| Oracle Always Free | 0 $ | 4 vCPU ARM / 24 Go |
| Hetzner CAX21 | ~7 €/mois | 4 vCPU ARM / 8 Go, très bon rapport |
| Hetzner CCX (dédié) | ~15–60 €/mois | vCPU dédiés, pour gros backtests |
| Ton propre PC/serveur maison | 0 $ | même commande Docker, + DuckDNS |

Toutes ces options utilisent exactement la même procédure (option A).

---

## Option B — GitHub Actions (plan B sans serveur)

Pour un très gros backtest ponctuel sans aucun serveur : le workflow `.github/workflows/backtest.yml`
lance le moteur sur une machine GitHub (jusqu'à 6 h par run, gratuit selon ton quota GitHub).

1. Dans le site, **Exporter JSON** et sauvegarde le fichier dans le dépôt, par ex. `backtests/request.json`
   (le JSON d'export Streamlit fonctionne aussi).
2. GitHub → **Actions → Backtest → Run workflow**, indique le chemin du fichier.
3. À la fin, télécharge l'artefact `backtest-result-…` (dézippe-le pour obtenir `result.json.gz`), puis sur le site :
   **Résultats → Ouvrir un fichier résultat**.

---

## Sécurité

- `ENGINE_AUTH=supabase` (par défaut en cloud) : seuls les utilisateurs connectés à ton site peuvent lancer un
  backtest (le jeton Supabase est vérifié à chaque requête).
- Mode invité du site (« Essayer le backtester sans compte ») : désactivé côté moteur par défaut. Mets
  `ENGINE_ALLOW_GUESTS=1` dans `.env` pour que les visiteurs sans compte puissent lancer des backtests sur le
  moteur cloud ; chaque IP est limitée à `ENGINE_GUEST_MAX_QUEUE` jobs actifs (2 par défaut) et ne peut pas
  vider les caches.
- CORS : seuls `*.vercel.app`, `localhost` et `ENGINE_ALLOWED_ORIGINS` sont acceptés.
- Les résultats sont effacés du serveur après `ENGINE_RESULT_TTL_H` heures. L'historique permanent est dans
  Supabase (ton compte).
