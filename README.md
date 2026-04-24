# JobHunter AI – Setup Anleitung

## Was du brauchst
- Windows PC der im Hintergrund läuft
- iPhone im gleichen WLAN
- Anthropic API Key (platform.anthropic.com, ~3–5€/Monat)

---

## Schritt 1: Node.js installieren
1. Geh auf **https://nodejs.org**
2. Den „LTS" Button klicken und installieren
3. PC neu starten

---

## Schritt 2: JobHunter starten
1. Diesen Ordner irgendwo auf dem PC speichern (z.B. `C:\JobHunter`)
2. Doppelklick auf **`start.bat`**
3. Ein schwarzes Fenster öffnet sich mit der IP-Adresse

Das Fenster zeigt dir sowas:
```
  PC Browser:  http://localhost:3000
  📱 iPhone:   http://192.168.1.42:3000   ← Diese Adresse!
```

---

## Schritt 3: iPhone verbinden
1. iPhone und PC ins **gleiche WLAN**
2. Safari auf dem iPhone öffnen
3. Die Adresse aus dem schwarzen Fenster eingeben (z.B. `http://192.168.1.42:3000`)
4. Seite lädt → **Teilen** (Quadrat mit Pfeil) → **„Zum Home-Bildschirm"**
5. Fertig! App hat jetzt ein eigenes Icon

---

## Schritt 4: API Key eintragen
1. In der App auf **⚙️ Settings** tippen
2. API Key eingeben (von platform.anthropic.com)
3. Speichern

---

## Schritt 5: Autostart (optional)
Damit der Server automatisch startet wenn du den PC einschaltest:

1. `Windows + R` drücken
2. `shell:startup` eingeben → Enter
3. Eine Verknüpfung von `start.bat` in diesen Ordner kopieren

---

## Kosten
- Node.js: kostenlos
- Server: kostenlos (läuft lokal)
- Anthropic API: ~0,15 Cent pro Anschreiben
  - 100 Bewerbungen/Monat ≈ 0,15€
  - 500 Bewerbungen/Monat ≈ 0,75€
  - 1500 Bewerbungen/Monat ≈ 2–3€

---

## Problemlösung

**„Kein Server gefunden" auf dem iPhone**
→ Beide Geräte im gleichen WLAN? 
→ start.bat läuft noch?
→ IP-Adresse korrekt eingegeben?

**„API Key fehlt"**
→ Settings → API Key eintragen → Speichern

**Port bereits belegt**
→ In server.js die Zeile `PORT: 3000` auf z.B. `3000` ändern
