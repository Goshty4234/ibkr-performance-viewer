# IBKR Performance Viewer

Application web long terme pour suivre la performance de vos comptes **Interactive Brokers** en TWRR, avec comparaison aux indices (S&P 500, Nasdaq, S&P/TSX).

**Stack :** Next.js 15 · Supabase (auth + base de données) · Vercel

---

## Ce que fait l'app

- Connexion sécurisée (email / mot de passe)
- Import de Activity Statements IBKR (CSV, multi-fichiers)
- Performance **TWRR** — insensible aux dépôts, retraits et transferts
- Comparaison benchmark (SPY, QQQ, XIU)
- Sélection de plage de dates et filtre par compte
- Données persistées dans **Supabase** (accessibles partout, sur des années)

---

## Setup en 3 étapes

### 1. Supabase

1. Créez un projet sur [supabase.com](https://supabase.com)
2. Allez dans **SQL Editor** → collez le contenu de `supabase/schema.sql` → **Run**
3. Allez dans **Authentication → Providers** → activez **Email**
4. Dans **Authentication → URL Configuration**, ajoutez :
   - Site URL : `http://localhost:3000` (dev) puis votre URL Vercel en prod
   - Redirect URLs : `http://localhost:3000/auth/callback` et `https://votre-app.vercel.app/auth/callback`
5. Copiez vos clés dans **Project Settings → API** :
   - Project URL
   - `anon` public key

### 2. Variables d'environnement

```bash
cp .env.local.example .env.local
```

Remplissez `.env.local` :

```
NEXT_PUBLIC_SUPABASE_URL=https://xxxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGci...
```

### 3. Lancer en local

```bash
npm install
npm run dev
```

Ouvrez [http://localhost:3000](http://localhost:3000)

---

## Déploiement GitHub + Vercel

### GitHub

```bash
git init
git add .
git commit -m "IBKR Performance Viewer"
git branch -M main
git remote add origin https://github.com/VOTRE-USERNAME/ibkr-performance-viewer.git
git push -u origin main
```

### Vercel

1. [vercel.com](https://vercel.com) → **Add New Project**
2. Importez votre repo GitHub
3. Framework : **Next.js** (détecté automatiquement)
4. Ajoutez les variables d'environnement :
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
5. **Deploy**

### Après le déploiement

1. Copiez l'URL Vercel (ex. `https://ibkr-viewer.vercel.app`)
2. Dans Supabase → **Authentication → URL Configuration** :
   - Site URL : votre URL Vercel
   - Redirect URLs : `https://ibkr-viewer.vercel.app/auth/callback`

---

## Utilisation

1. Créez un compte sur l'app
2. Dans IBKR : **Reports → Activity Statement → CSV**
3. Glissez vos fichiers CSV dans l'app
4. Ajustez la période et comparez au S&P 500

**Astuce :** exportez des statements **mensuels** pour une courbe plus détaillée qu'un seul statement annuel.

---

## Structure du projet

```
src/
  app/           # Pages Next.js + API routes
  components/    # UI (Dashboard, Chart, etc.)
  lib/           # Parser IBKR, TWRR, Supabase
supabase/
  schema.sql     # Schéma base de données
```

---

## Confidentialité

- Vos statements sont stockés dans **votre** projet Supabase
- Row Level Security : chaque utilisateur ne voit que ses données
- Les prix des benchmarks viennent de Yahoo Finance via l'API interne
