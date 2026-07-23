# Sprint-Kraftanalyse · Web-App (PWA)

Dieselbe Analyse wie das Python-Programm `sprint_kraft_analyse.py`, aber als
installierbare App fürs Smartphone (z. B. Samsung S22). Läuft komplett im
Browser – die Videos verlassen dein Gerät **nicht** (alles wird lokal gerechnet).

## Was sie kann
- Video **aus der Galerie** wählen und analysieren
- Pose-Erkennung (MediaPipe), Körperschwerpunkt (de Leva 1996)
- Butterworth-Filter → Geschwindigkeit → Beschleunigung → **Bodenreaktionskräfte**
- Video mit **Overlay** (Skelett, Kraftvektoren, Gelenkwinkel) + Abspielsteuerung
- **Seek-Leiste** mit Punkt zum Durchziehen + **Ton** (an/aus)
- **Reaktionszeit-Modus**: Lautstärke-Kurve der Tonspur, Startsignal per Ziehen
  finden (Startpunkt = lautester Punkt), Endpunkt setzen → Reaktionszeit
- **Kraftberechnung abschaltbar**: Haken auf der Startseite entfernen →
  nur der Reaktionszeit-Modus läuft (ohne Pose/Kraft, deutlich schneller)
- Metriken pro Bodenkontakt (t_c, Fv, Fh, R_f, J_h, P_max)
- 5 Diagramme + **JSON-Export**

---

## Aufs Handy bringen

Eine PWA muss über **HTTPS** ausgeliefert werden, damit Android sie als App
installieren kann. Wähle **einen** Weg:

### Variante A · GitHub Pages (kostenlos, dauerhaft) – empfohlen
1. GitHub-Konto anlegen, neues (auch privates) Repository erstellen.
2. Den **gesamten `webapp`-Ordner** hochladen (inkl. `pose_landmarker_full.task`).
3. Repo → *Settings* → *Pages* → *Branch: main / root* → speichern.
4. Nach ~1 Min bekommst du eine URL wie
   `https://deinname.github.io/sprint/`.
5. Diese URL auf dem S22 in **Chrome** öffnen.

### Variante B · Netlify Drop (am schnellsten)
1. <https://app.netlify.com/drop> öffnen (einmalig einloggen).
2. Den **`webapp`-Ordner** ins Fenster ziehen.
3. Du bekommst sofort eine HTTPS-URL → auf dem S22 in Chrome öffnen.

### Variante C · Schnelltest im WLAN (ohne Installation)
Nur zum Ausprobieren am selben WLAN, **ohne** App-Installation:
```
cd webapp
python -m http.server 8123
```
Am Handy `http://<PC-IP>:8123` öffnen (PC-IP per `ipconfig`). Hinweis: Über
HTTP lässt sich die App **nicht** installieren und nicht offline nutzen – dafür
brauchst du Variante A oder B.

---

## Als App installieren (Samsung S22)
1. Die HTTPS-URL in **Chrome** öffnen.
2. Menü (⋮) → **„App installieren"** bzw. **„Zum Startbildschirm hinzufügen"**.
3. Fertig – die App liegt mit eigenem Icon auf dem Homescreen und startet im
   Vollbild. Nach dem ersten Laden funktioniert sie auch **offline**.

## Benutzung
1. **Video aus Galerie wählen** antippen → dein aufgenommenes Sprint-Video wählen.
2. Körpermasse, Größe und Filter-Grenzfrequenz (6–10 Hz) eingeben.
   *(Nur Reaktionszeit messen? Haken bei „Kraftberechnung durchführen" entfernen –
   dann werden Pose-Erkennung und Kraftberechnung übersprungen.)*
3. **Analyse starten**. Bei aktivierter Kraftberechnung läuft die Pose-Erkennung
   Frame für Frame (Fortschrittsbalken); bei langen/hochfrequenten Videos dauert das etwas.
4. Ergebnis ansehen: Overlay-Video mit Seek-Leiste und Ton, Metriken, Diagramme, JSON-Export.

### Reaktionszeit messen
1. **Reaktion** antippen (im Reaktions-Only-Modus schon aktiv). Unten erscheint die
   **Lautstärke-Kurve** der Tonspur; der weiße Strich zeigt die aktuelle Videoposition.
2. **Über die Kurve ziehen**, um einen Bereich um das akustische Startsignal zu wählen –
   der Startpunkt springt automatisch auf den **lautesten Punkt** (den Startschuss/-piepser).
3. Mit **⏮ / ⏭** (Bild für Bild) oder der Seek-Leiste zur ersten Bewegung navigieren und
   **„Ende = hier"** setzen. „Seit Start" läuft dabei mit, die **Reaktionszeit** steht oben.
   Skelett/Winkel lassen sich auch hier über **Ansicht** und **Winkel** ein-/ausblenden.

## Für gute Ergebnisse filmen
- Kamera **statisch & seitlich** (90° zur Laufrichtung)
- Möglichst **Zeitlupe** (120 fps oder mehr)
- Ganzer Körper durchgehend und vollständig im Bild
- Gleichmäßige Beleuchtung

## Grenzen
Video-basierte inverse Dynamik liefert **Schätzwerte**, keine Kraftmessplatten-
Genauigkeit. Kalibrierung erfolgt über die Körpergröße (Nase–Knöchel ≈ 88 %).
Quellen: Weyand 2010, Morin 2011, de Leva 1996.
