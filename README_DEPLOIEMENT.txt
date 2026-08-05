CENTRE DE REGULATION V17 — DEPLOIEMENT CLOUDFLARE

1. Ouvrir PowerShell dans ce dossier.
2. Se connecter si nécessaire : npx wrangler login
3. Créer la base : npx wrangler d1 create centre-regulation-db
4. Copier l'UUID affiché dans wrangler.toml à la place de REMPLACER_PAR_VOTRE_DATABASE_ID.
5. Créer les tables : npx wrangler d1 execute centre-regulation-db --remote --file=.\schema.sql
6. Définir le mot de passe de mise à jour : npx wrangler secret put UPDATE_PASSWORD
7. Déployer : npx wrangler deploy
8. Vérifier : https://VOTRE-WORKER.workers.dev/api/health

MISES A JOUR SUIVANTES SANS NODE.JS
- Ouvrir l'application.
- Cliquer sur ☁ MISE A JOUR.
- Choisir le nouveau HTML complet.
- Saisir le mot de passe administrateur.
- Installer.

Les données D1 sont conservées lors des mises à jour HTML.
