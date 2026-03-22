# Tournées Journal - Instructions d'installation

## Contenu du dossier
- `index.html` — Application principale
- `app.js` — Logique de l'application
- `style.css` — Interface visuelle
- `manifest.json` + `sw.js` — Fichiers PWA (installation sur l'écran d'accueil)
- `exemple.csv` — Exemple de fichier CSV à adapter

## Étapes pour utiliser l'application sur votre téléphone

### Option 1 : GitHub Pages (RECOMMANDÉ, gratuit, fonctionne offline)

1. Créez un compte sur https://github.com
2. Créez un nouveau dépôt "tournees-journal" (public)
3. Glissez-déposez tous les fichiers du dossier JournalApp dans le dépôt
4. Allez dans Settings > Pages > Branch: main > Save
5. Votre URL sera : https://[votre-pseudo].github.io/tournees-journal
6. Sur votre téléphone Android : ouvrez Chrome, allez sur cette URL, menu ⋮ > "Ajouter à l'écran d'accueil"
7. Sur iPhone : ouvrez Safari, allez sur cette URL, bouton Partager > "Sur l'écran d'accueil"

### Option 2 : Serveur local (sans internet)
Sur Android, installez "Web Server for Android" depuis le Play Store,
pointez-le vers ce dossier, et ouvrez l'IP locale dans Chrome.

---

## Utilisation de l'application

### 1. Importer vos adresses
- Préparez votre CSV avec les colonnes : **nom, adresse, ville, code_postal, tournee**
- La colonne "tournee" indique le numéro/nom de la tournée (1, 2, 3, 4...)
- Allez dans ⚙️ Paramètres > Importer un CSV
- Sélectionnez votre fichier

### 2. Géocoder les adresses (conversion adresse → GPS)
- ⚙️ Paramètres > Géocoder les adresses > Démarrer
- Environ 1 adresse/seconde, donc ~4 minutes pour 240 adresses
- Les coordonnées sont sauvegardées, inutile de recommencer

### 3. Configurer les jours de chaque tournée
- ⚙️ Paramètres > Gérer les tournées > Cliquer sur une tournée
- Cochez les jours de la semaine et/ou les jours du mois
- Les tournées du jour apparaissent automatiquement en haut de l'écran

### 4. Lancer une tournée
- Depuis l'écran d'accueil, tapez sur votre tournée
- La carte s'affiche avec tous les arrêts optimisés
- Tapez sur un arrêt pour voir le détail

### 5. Pendant la livraison
- **✅ LIVRÉ** : marque et passe automatiquement au suivant
- **❌ NON LIVRÉ** : marque et passe au suivant
- **⏭ PASSER** : reporte cet arrêt à plus tard dans la tournée
- **🗺 Navigation** : ouvre Google Maps avec l'adresse
- **🔄 Réorganiser** : recalcule l'ordre depuis votre position actuelle

### 6. Contrainte horaire
- Sur un arrêt, tapez "⏰ Contrainte horaire"
- Entrez l'heure souhaitée (ex: 09:00)
- L'optimisation garantira d'arriver à cet arrêt à l'heure

---

## Format CSV détaillé

Séparateurs acceptés : virgule (,) ou point-virgule (;)

```
nom,adresse,ville,code_postal,tournee
M. Dupont,12 Rue de la Paix,Paris,75001,1
Mme Martin,45 Avenue Hugo,Lyon,69001,2
```

La colonne "tournee" peut être un numéro (1, 2, 3) ou un nom (A, B, Matin, Soir).
