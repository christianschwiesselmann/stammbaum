# Schwießelmann Familienwebseite

## Inhalt

- Kleine Chronologie der Schwießelmänner
- Vollständiger Stammbaum aus einer internen GED-Quelle
- Abschnitt „Lebenserinnerungen“ mit den Unterrubriken „Stahlgewitter“ und „Stallgeruch“
- Kontaktbereich für Familienmitglieder
- Impressum

## So funktioniert der Stammbaum

Die GED-Datei liegt in `data/schwiesselmann_stammbaum.ged` und wird in `js/gedParser.js` verarbeitet.

## Aktualisierung

Wenn die GED-Daten später geändert werden sollen, dann:

1. die Datei `data/schwiesselmann_stammbaum.ged` ersetzen,
2. die Seite neu laden.
   > Hinweis: Der Dateiname muss unverändert bleiben oder hier angepasst werden: `const DEFAULT_GED_PATH = "data/schwiesselmann_stammbaum.ged";`.
