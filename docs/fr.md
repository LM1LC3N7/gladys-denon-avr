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
- **Index de source** — le même contrôle de source, mais sous forme de nombre plutôt qu'un menu
  déroulant : 0 correspond à la première entrée actuellement affichée dans le menu Source
  ci-dessus, 1 à la deuxième, etc. Si vous masquez une entrée (voir Configuration ci-dessous),
  tout ce qui suit se décale d'un cran — la numérotation correspond toujours à ce qui est
  réellement visible dans le menu au moment donné. Cette fonctionnalité existe pour les
  **scènes** : voir « Automatiser la source/le mode sonore depuis une scène » ci-dessous pour
  savoir si vous en avez besoin, selon votre version de Gladys.
- **Mode sonore** — un menu déroulant des modes surround/sonores (ex. `MOVIE`, `STEREO`,
  `PURE DIRECT`). Moins uniforme d'un ampli à l'autre que les autres contrôles — si un mode que
  vous utilisez depuis la télécommande n'apparaît pas, il manque probablement à la liste
  générique fournie par cette intégration.
- **Lecture / Pause / Suivant / Précédent** — des boutons qui contrôlent la lecture sur une
  source réseau/USB/streaming (Qobuz, Spotify Connect, TIDAL, radio internet...). Sans effet
  sur une source qui n'est pas un lecteur (une entrée TV, par exemple). **Il faut une carte
  Musique, pas la liste d'appareils classique** : sur votre tableau de bord, ajoutez une carte et
  choisissez le type **Musique**, puis cet ampli comme appareil — c'est ce qui affiche
  réellement les boutons lecture/pause/suivant. Dans la liste d'appareils classique, ils
  apparaissent juste comme des lignes sans valeur visible, c'est normal à cet endroit. Sur un
  ampli équipé HEOS, ces boutons passent par HEOS dès que possible, car c'est le seul chemin qui
  fonctionne réellement pour les sources gérées par HEOS comme Qobuz ou Spotify Connect — voir
  « Support HEOS » ci-dessous.
- **En cours de lecture** — une ligne « Artiste - Titre » en lecture seule, renseignée
  automatiquement pendant la lecture en streaming.

## Automatiser la source/le mode sonore depuis une scène

Dans une scène, c'est l'action générique **« Contrôler un appareil »** qui permet de régler
Source/Mode sonore/Index de source — il n'existe aucune action de scène pour les boutons propres
au manifeste d'une intégration (**Sélectionner l'entrée** ici), sur aucune version de Gladys.

- **Sur Gladys 4.86.1 ou plus récent**, « Contrôler un appareil » affiche déjà un vrai menu
  déroulant avec les libellés pour Source et Mode sonore, exactement comme le tableau de bord :
  choisissez l'appareil, puis la fonctionnalité, puis la valeur. L'Index de source fonctionne
  aussi si vous préférez fixer un simple nombre.
- **Sur une version plus ancienne de Gladys**, ce menu déroulant n'est soit pas proposé, soit
  n'accepte pas la valeur — utilisez plutôt **l'Index de source** : c'est un simple nombre, que
  « Contrôler un appareil » a toujours su régler, et qui correspond à la même entrée que le menu
  déroulant (position dans la liste Source _actuellement visible_, 0 = première entrée).
- **Si « Contrôler un appareil » n'affiche strictement rien pour cet ampli** (ni menu Source/Mode
  sonore, ni Index de source) : essayez d'abord un **rafraîchissement forcé / de vider le cache
  du navigateur** — confirmé une fois comme étant la vraie cause : un bundle front mis en cache
  affichait un sélecteur totalement vide pour cet appareil alors que d'autres intégrations (MQTT,
  Zigbee2MQTT) fonctionnaient normalement, corrigé instantanément en vidant le cache, sans aucun
  changement de configuration. Toujours rien après ça ? L'appareil a probablement été ajouté avant
  que cette intégration ne propose l'Index de source, combiné à une version de Gladys antérieure à
  4.86.1 — ouvrez l'onglet **Découverte** de l'intégration, lancez un scan, puis cliquez sur
  **Mettre à jour** sur l'appareil, comme tout autre changement de structure (voir Configuration
  ci-dessous).

## Support HEOS

Les amplis Denon/Marantz équipés d'un module HEOS (la plupart des modèles réseau récents) font
tourner HEOS comme un service séparé, à côté du contrôle Telnet classique utilisé pour tout le
reste de cette page. Les sources de streaming comme Qobuz, Spotify Connect, TIDAL ou TuneIn sont
en réalité lues _via_ HEOS — les commandes de transport classiques que cette intégration
utilisait auparavant n'ont strictement aucun effet dessus.

Depuis cette version, les boutons Lecture/Pause/Suivant/Précédent parlent automatiquement à HEOS
quand l'ampli le supporte : rien à configurer, rien à activer. Si HEOS n'est pas joignable (pas
de module HEOS, ou son port réseau bloqué), les boutons basculent automatiquement sur les
commandes classiques, qui continuent de fonctionner pour les sources Net/USB non-HEOS de
l'ampli.

Une fois HEOS confirmé pour votre ampli, il devient aussi la source de l'état de lecture et du
titre/artiste « En cours de lecture » — actualisés à la fois quand HEOS pousse un changement et
via une vérification en arrière-plan toutes les 30 secondes, pour que le tableau de bord se
remette à jour tout seul en moins d'une demi-minute même si une notification est manquée (cela
peut arriver si la connexion HEOS se coupe brièvement, un comportement connu de HEOS sur une
connexion inactive).

**Limites** : ceci est implémenté à partir du protocole réseau propre à HEOS (non officiel, mais
largement utilisé), recoupé avec la bibliothèque derrière l'intégration HEOS officielle de Home
Assistant — non testé par le développeur sur une vraie session de streaming HEOS, car cela
nécessite un compte de streaming payant réel. Si les boutons ne font rien chez vous alors que
l'ampli est joignable, merci de le signaler (avec les logs de débogage mentionnés plus bas) pour
que ce soit corrigé.

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
     volume, muet, source avec son index — voir « Index de source » ci-dessus —, mode sonore).
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
- **Les boutons de lecture ne font toujours rien sur Qobuz/Spotify Connect/TIDAL** : vérifiez les
  logs de débogage à la recherche d'une ligne mentionnant « HEOS player id ... matched » peu
  après la connexion de l'ampli — si elle n'y est pas, le service HEOS CLI de cet ampli (port 1255) n'était pas joignable (pare-feu, modèle plus ancien sans HEOS, ou HEOS pas encore prêt)
  et l'intégration est repassée silencieusement sur les commandes classiques, qui n'atteignent
  pas les sources gérées par HEOS.
