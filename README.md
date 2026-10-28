# Tunnel de Vente « Détox & Ventre Plat 21 Jours »

Tunnel de vente mobile-first haute conversion connecté en temps réel à l'**API Maketou** (Moneroo Mobile Money) et au moteur **Meta Andromeda** (Pixel + Conversions API Server-Side).

## 🚀 Fonctionnalités Clés
- **Format Court « 2 Coups de Pouce » :** Hauteur compacte <= 240vh pour éliminer la friction et maximiser la conversion sur mobile.
- **Zéro Emoji hors Témoignages :** Design épuré MIT Media Lab / Stripe avec icônes vectorielles SVG Lucide.
- **Paiement Express Intégré :** Formulaire 3 champs avec normalisation intelligente des numéros de téléphone africains (Bénin +229 avec `01`, Côte d'Ivoire +225, Sénégal +221, etc.).
- **Vérification Atomique & Sas Anti-Doublon :** Déduplication stricte Pixel & CAPI via `/verify-purchase`.
- **Preuves Visuelles Réelles :** Mockup 3D, comparatif Avant/Après, lecteur vidéo 20s et carrousel tactile d'avis vérifiés.

## 🛠️ Installation Locale

1. Cloner le dépôt :
```bash
git clone https://github.com/urielhgb7-arch/detox-ventre-plat-21-jours.git
cd detox-ventre-plat-21-jours
```

2. Installer les dépendances :
```bash
npm install
```

3. Configurer l'environnement :
Copier `.env.example` en `.env` et renseigner vos clés secrètes.

4. Lancer le serveur :
```bash
npm start
```
Accès sur `http://localhost:3000` (ou le port défini dans `.env`).

## ☁️ Déploiement en Production (Render, Railway, VPS, Heroku)
1. Créer un nouveau service Web depuis ce dépôt GitHub.
2. Commande de build : `npm install`
3. Commande de démarrage : `npm start`
4. Ajouter les variables d'environnement listées dans `.env.example` (en définissant `APP_BASE_URL` avec votre URL HTTPS de production).
