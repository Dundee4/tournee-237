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
- Préparez votre CSV avec les colonnes : **nom, adresse, journal**
- La colonne "journal" indique le code du journal à déposer (ex: `19A LANDES`, `LE MONDE`, `LE POINT S1`)
- Une ligne = un couple (client, journal). Si un client reçoit plusieurs journaux, mettez une ligne par journal avec le même nom+adresse : l'import les fusionnera automatiquement en un seul client abonné à plusieurs journaux.
- Optionnel : prenom, ville, code_postal, notes
- Allez dans ⚙️ Paramètres > Importer un CSV
- Sélectionnez votre fichier (⚠️ remplace les clients actuels — une sauvegarde locale est faite automatiquement)

### 2. Géocoder les adresses (conversion adresse → GPS)
- ⚙️ Paramètres > Géocoder les adresses > Démarrer
- Environ 1 adresse/seconde
- Les coordonnées sont sauvegardées, inutile de recommencer
- Un nouveau client ajouté à la main est géocodé immédiatement à l'enregistrement

### 3. Sélection quotidienne et génération de la tournée
- Sur l'écran d'accueil, cochez les journaux à distribuer aujourd'hui (jusqu'à ~5)
- Tapez sur "▶️ Générer la tournée" : l'app fusionne par adresse les clients concernés (un client abonné à 2 journaux cochés = un seul arrêt), exclut les clients dont le statut n'est pas "actif", optimise et fige l'ordre
- La carte s'affiche avec tous les arrêts optimisés ; tapez sur un arrêt pour voir le détail

### 4. Pendant la livraison
- **✅ LIVRÉ** : marque et passe automatiquement au suivant
- **❌ NON LIVRÉ** : marque et passe au suivant
- **🚫 Pas livré — raison client** : marque l'arrêt et ouvre la mise à jour du statut persistant du client (vacances, décédé, résilié, autre)
- **⏭ PASSER** : reporte cet arrêt à plus tard dans la tournée
- **🗺 Navigation** : ouvre Google Maps avec l'adresse
- **🔄 Réorganiser** : recalcule l'ordre depuis votre position actuelle

### 5. Contrainte horaire
- Sur un arrêt, tapez "⏰ Contrainte horaire"
- Entrez l'heure souhaitée (ex: 09:00)
- L'optimisation garantira d'arriver à cet arrêt à l'heure

### 6. Gérer les clients
- ⚙️ Paramètres > Gérer les clients : rechercher, modifier (adresse, journaux, statut) ou supprimer un client
- ⚙️ Paramètres > Exporter une sauvegarde (JSON) : télécharge une copie de tous vos clients

---

## Format CSV détaillé

Séparateurs acceptés : virgule (,) ou point-virgule (;)

```
nom,prenom,adresse,ville,code_postal,journal
M. Dupont,Jean,12 Rue de la Paix,Paris,75001,19A LANDES
M. Dupont,Jean,12 Rue de la Paix,Paris,75001,LE MONDE
Mme Martin,,45 Avenue Hugo,Lyon,69001,LE POINT S1
```

Ici, M. Dupont recevra 2 journaux (19A LANDES + LE MONDE) et n'apparaîtra qu'une seule fois dans l'app.
