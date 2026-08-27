# Denon / Marantz AVR

Contrôlez un ampli-tuner (AVR) Denon ou Marantz depuis Gladys : alimentation, volume, muet et
source. Compatible avec le protocole « AVR Control » partagé par (presque) toute la gamme des
amplis réseau Denon/Marantz — pas limité à un modèle précis.

## Vue d'ensemble

L'intégration parle directement à votre ampli sur le réseau local (Telnet, port TCP 23) — pas
de compte cloud, pas de dépendance internet. L'ampli pousse lui-même chaque changement d'état
(alimentation, volume, muet, source) dès qu'il se produit, que ce soit depuis Gladys, la
télécommande physique ou l'application Denon/HEOS, si bien que le tableau de bord reste
synchronisé en temps réel.

Voici ce qui apparaît par ampli :

- **Alimentation** — marche/arrêt, contrôlable.
- **Volume** — 0-100 %, contrôlable (converti depuis l'échelle interne de l'ampli, -80 dB à +18 dB).
- **Muet** — marche/arrêt, contrôlable.
- **Source** — un menu déroulant des codes d'entrée de l'ampli (ex. `TUNER`, `BD`, `NET`),
  directement sur le tableau de bord. L'action **Sélectionner l'entrée** décrite ci-dessous fait
  exactement la même chose et reste disponible en alternative — utile si votre instance Gladys
  est sur une version plus ancienne qui n'affiche pas encore le menu déroulant. Vous pouvez
  renommer ou masquer des entrées — voir Configuration ci-dessous.
- **Mode sonore** — un menu déroulant des modes surround/sonores (ex. `MOVIE`, `STEREO`,
  `PURE DIRECT`). Moins uniforme d'un ampli à l'autre que les autres contrôles — si un mode que
  vous utilisez depuis la télécommande n'apparaît pas, il manque probablement à la liste
  générique fournie par cette intégration.
- **Lecture / Pause / Suivant / Précédent** — des boutons qui contrôlent la lecture sur une
  source réseau/USB/streaming (Qobuz, Spotify Connect via HEOS, radio internet...). Sans effet
  sur une source qui n'est pas un lecteur (une entrée TV, par exemple). **Il faut une carte
  Musique, pas la liste d'appareils classique** : sur votre tableau de bord, ajoutez une carte et
  choisissez le type **Musique**, puis cet ampli comme appareil — c'est ce qui affiche
  réellement les boutons lecture/pause/suivant. Dans la liste d'appareils classique, ils
  apparaissent juste comme des lignes sans valeur visible, c'est normal à cet endroit.
- **En cours de lecture** — une ligne « Artiste - Titre » en lecture seule, renseignée
  automatiquement pendant la lecture en streaming.

## Prérequis

- Un ampli-tuner Denon ou Marantz avec une connexion réseau (Ethernet/Wi-Fi).
- La **veille réseau** (parfois appelée veille « ECO ») activée dans le menu de configuration de
  l'ampli. Sans cela, l'ampli disparaît complètement du réseau une fois éteint et Gladys ne peut
  plus le joindre (y compris pour le rallumer).
- Gladys et l'ampli sur le même réseau local/VLAN, avec le multicast autorisé entre eux
  (nécessaire pour la découverte automatique, voir ci-dessous).

## Configuration

1. Ouvrez l'onglet **Découverte** de l'intégration et lancez un scan. Les amplis Denon/Marantz
   répondent automatiquement (SSDP/UPnP) — aucune IP à saisir, aucun compte. L'ampli devrait
   apparaître avec son vrai nom et son modèle.
2. Ajoutez l'appareil découvert. Gladys maintient ensuite une connexion persistante avec lui.
3. **Si rien n'est trouvé** : votre réseau bloque probablement le multicast entre segments
   (VLAN, plusieurs cartes réseau sur l'hôte Gladys, certains Wi-Fi maillés...). Ouvrez l'onglet
   **Configuration** de l'intégration et renseignez manuellement l'adresse IP de l'ampli,
   enregistrez, puis relancez un scan : il apparaîtra comme entrée de secours. Plusieurs amplis
   que le scan ne trouve pas (par exemple sur des réseaux différents) ? Séparez leurs adresses
   par des virgules, ex. `192.168.1.50, 192.168.2.50` — chacune devient sa propre entrée de
   secours. Une IP fixe ou une réservation DHCP pour chaque ampli est alors recommandée, car
   l'entrée manuelle ne suit pas automatiquement les changements d'IP.
4. Deux actions sont disponibles depuis l'écran de configuration pour chaque ampli ajouté :
   - **Tester la connexion** — interroge l'ampli et rapporte son état actuel (alimentation,
     volume, muet, source, mode sonore).
   - **Sélectionner l'entrée** — choisissez une entrée dans la liste standard des codes source
     Denon/Marantz et basculez dessus.
5. **Renommer ou masquer des sources dans le menu déroulant** (onglet Configuration, avancé) :
   le menu montre des codes génériques comme `SAT/CBL` ou `GAME`, pas ce qui est réellement
   branché. Renseignez des paires `CODE=Label` séparées par des virgules pour les renommer — ex.
   `SAT/CBL=Chromecast` si c'est ce qui est branché sur cette entrée — ou `CODE=` (rien après le
   `=`) pour retirer une entrée que vous n'utilisez jamais, ex. `SAT/CBL=Chromecast, GAME=`. Une
   fois enregistré, relancez un scan Découverte et cliquez sur **Mettre à jour** sur l'appareil —
   les choix du menu font partie de la structure de l'appareil, ils ne se rafraîchissent pas
   automatiquement avec la configuration.

## Dépannage

- **Le scan ne trouve rien** : vérifiez que Gladys et l'ampli sont sur le même segment réseau et
  que le multicast/UPnP n'est pas filtré par votre routeur ou vos switchs, puis utilisez l'IP
  manuelle de secours (voir ci-dessus).
- **Détecté mais les commandes ne s'appliquent pas / pas de retour d'état** : vérifiez que le
  Telnet (port 23) n'est pas désactivé ou bloqué par un pare-feu sur l'interface réseau de
  l'ampli, et qu'aucun autre contrôleur n'accapare la session Telnet au point d'en bloquer de
  nouvelles (rare, mais certains modèles limitent le nombre de clients Telnet simultanés).
- **Ampli injoignable une fois éteint** : activez la veille réseau / veille ECO dans le menu de
  configuration de l'ampli (voir Prérequis).
- L'intégration journalise tout ce qu'elle fait : consultez les logs de l'intégration depuis
  l'interface Gladys (ou `docker logs` sur l'hôte) avec `LOG_LEVEL=debug` pour le détail complet,
  y compris chaque ligne Telnet envoyée et reçue.
- **Mode sonore, boutons de lecture ou lecture en cours ne fonctionnent pas comme attendu** : ces
  fonctions reposent sur des parties du protocole qui varient plus d'un modèle/firmware à l'autre
  que alimentation/volume/muet/source. Comparez ce que votre télécommande envoie réellement avec
  ce que cette intégration attend, via les logs de débogage ci-dessus.
