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

Quatre éléments apparaissent par ampli :

- **Alimentation** — marche/arrêt, contrôlable.
- **Volume** — 0-100 %, contrôlable (converti depuis l'échelle interne de l'ampli, -80 dB à +18 dB).
- **Muet** — marche/arrêt, contrôlable.
- **Source** — ligne d'état en lecture seule affichant le code d'entrée exact renvoyé par l'ampli
  (ex. `TUNER`, `BD`, `NET`). Pour changer d'entrée, utilisez l'action **Sélectionner l'entrée**
  décrite ci-dessous.

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
   (VLAN, certains Wi-Fi maillés...). Ouvrez l'onglet **Configuration** de l'intégration et
   renseignez manuellement l'adresse IP de l'ampli, enregistrez, puis relancez un scan : il
   apparaîtra comme entrée de secours. Une IP fixe ou une réservation DHCP pour l'ampli est alors
   recommandée, car l'entrée manuelle ne suit pas automatiquement les changements d'IP.
4. Deux actions sont disponibles depuis l'écran de configuration pour chaque ampli ajouté :
   - **Tester la connexion** — interroge l'ampli et rapporte son état actuel (alimentation,
     volume, muet, source).
   - **Sélectionner l'entrée** — choisissez une entrée dans la liste standard des codes source
     Denon/Marantz et basculez dessus.

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
