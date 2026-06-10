/**
 * gedParser.js – GEDCOM-Datei-Parser für die Schwießelmann-Familienwebseite
 * ==========================================================================
 *
 * Was ist GEDCOM?
 *   GEDCOM (Genealogical Data Communication) ist das Standard-Dateiformat
 *   für Genealogie-Programme. Jede Zeile hat die Form:
 *     LEVEL TAG [VALUE]
 *   Ebene 0 = neue Hauptentität (Person/Familie)
 *   Ebene 1 = Felder der Entität (Name, Geschlecht, Ereignisse…)
 *   Ebene 2 = Unterfelder von Ereignissen (Datum, Ort)
 *
 * Ausgabe von parseGed():
 *   {
 *     people:      { "@I1@": Person, "@I2@": Person, … }
 *     families:    { "@F1@": Family, "@F2@": Family, … }
 *     peopleByName: [ { id, display, rawName, birth, death, sex }, … ]  (alphabetisch)
 *   }
 *
 * Person-Objekt:
 *   { id, name (raw), sex ("M"/"F"), famc [], fams [], birth, death }
 *   birth/death = { date: string, place: string }
 *   famc = Familien, in denen Person Kind ist (Family As Child)
 *   fams = Familien, in denen Person Elternteil ist (Family As Spouse)
 *
 * Family-Objekt:
 *   { id, husb (personId), wife (personId), chil [personId…], marr { date, place } }
 *
 * Nur die für die Darstellung nötigen Felder werden ausgelesen.
 * Alle anderen GEDCOM-Tags werden ignoriert.
 *
 * Exportiertes Interface (window.GedParser):
 *   parseGed(text)          – parst einen GED-String, gibt { people, families, peopleByName } zurück
 *   formatName(name)        – entfernt GEDCOM-Slashes aus dem Namen (z.B. "/Müller/" → "Müller")
 *   buildLookup(data)       – erstellt einen Namens-Index für schnelle Suche
 *   getDisplayYears(person) – Geburts- und Todesjahr als "YYYY – YYYY" (für Anzeige)
 *   getBirthYear(person)    – Geburtsjahr als Zahl (für Sortierung), null wenn unbekannt
 */
(function () {

  /**
   * Whitespace am Anfang und Ende entfernen.
   * @param {string} v
   * @returns {string}
   */
  function cleanValue(v) {
    return (v || "").trim();
  }

  /**
   * Parst einen vollständigen GEDCOM-Text.
   *
   * Algorithmus:
   *   – Zeile für Zeile lesen
   *   – Ebene-0-Zeilen starten neue Personen- oder Familien-Objekte
   *   – Ebene-1-Zeilen befüllen die Felder des aktuellen Objekts
   *   – Ebene-2-Zeilen befüllen die Unterfelder von Ereignissen (BIRT/DEAT/MARR)
   *
   * @param {string} text – Roher GEDCOM-Dateiinhalt
   * @returns {{ people, families, peopleByName }}
   */
  function parseGed(text) {
    // Zeilenenden normalisieren (Windows \r\n → \n)
    const lines = String(text || "").replace(/\r/g, "").split("\n");

    const people   = {};   // personId → Person-Objekt
    const families = {};   // familyId → Family-Objekt

    let current     = null;  // aktuell gebautes Objekt (Person oder Familie)
    let currentType = null;  // "INDI" | "FAM" | null
    let event       = null;  // aktuell offenes Ereignis: "BIRT" | "DEAT" | "MARR"
    let eventLevel  = null;  // Ebene des Ereignis-Tags (immer 1)

    /**
     * Startet eine neue Person.
     * @param {string} id – GEDCOM-Referenz, z.B. "@I42@"
     */
    function startPerson(id) {
      currentType = "INDI";
      current = people[id] = {
        id,
        name:  "",            // Rohname inkl. Slashes: "Johann /Müller/"
        sex:   "",            // "M" oder "F"
        famc:  [],            // Familien, in denen Person Kind ist
        fams:  [],            // Familien, in denen Person Elternteil/Ehepartner ist
        birth: { date: "", place: "" },
        death: { date: "", place: "" },
        raw:   {}             // Reserviert für zukünftige Erweiterungen
      };
      event      = null;
      eventLevel = null;
    }

    /**
     * Startet eine neue Familie.
     * @param {string} id – GEDCOM-Referenz, z.B. "@F7@"
     */
    function startFamily(id) {
      currentType = "FAM";
      current = families[id] = {
        id,
        husb: "",             // personId des Ehemanns
        wife: "",             // personId der Ehefrau
        chil: [],             // Liste aller Kinder-personIds
        marr: { date: "", place: "" },
        raw:  {}
      };
      event      = null;
      eventLevel = null;
    }

    // Zeilenweise parsen
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue; // Leerzeilen überspringen

      // ── Ebene-0-Zeilen: neue Entität ─────────────────────────────────────
      // Format: 0 [@XREF@] TAG [VALUE]
      const match0 = line.match(/^0(?:\s+(@[^@]+@))?\s+([A-Z0-9_]+)?(?:\s+(.*))?$/);
      if (match0) {
        const [, xref, tag = "", value = ""] = match0;
        if      (tag === "INDI" && xref) startPerson(xref);
        else if (tag === "FAM"  && xref) startFamily(xref);
        else {
          // Sonstige Ebene-0-Tags (HEAD, TRLR, NOTE…) – ignorieren
          current     = null;
          currentType = null;
          event       = null;
          eventLevel  = null;
        }
        continue;
      }

      if (!current) continue; // Wir sind in keiner relevanten Sektion

      // ── Ebene-1/2-Zeilen: Felder befüllen ────────────────────────────────
      // Format: LEVEL TAG [VALUE]
      const m = line.match(/^(\d+)\s+([A-Z0-9_]+)(?:\s+(.*))?$/);
      if (!m) continue;

      const level = Number(m[1]);
      const tag   = m[2];
      const value = cleanValue(m[3]);

      // Ereignisse wie Geburt, Tod oder Hochzeit merken.
      // Die zugehörigen DATE- und PLAC-Zeilen kommen erst eine Ebene tiefer.
      if (level === 1) {
        if (["BIRT", "DEAT", "MARR"].includes(tag)) {
          event      = tag;
          eventLevel = level;
          continue;
        }

        // Sobald ein anderes Feld beginnt (z.B. RESI),
        // darf das vorherige Ereignis nicht weiterverwendet werden.
        // Sonst könnten Datumsangaben falsch als Geburtsdatum übernommen werden.
        event      = null;
        eventLevel = null;
      }

      if (currentType === "INDI") {
        // ── Person-Felder ────────────────────────────────────────────────────
        if      (level === 1 && tag === "NAME") current.name = value;  // "Vorname /Nachname/"
        else if (level === 1 && tag === "SEX")  current.sex  = value;  // "M" | "F"
        else if (level === 1 && tag === "FAMC") current.famc.push(value); // Kind in Familie
        else if (level === 1 && tag === "FAMS") current.fams.push(value); // Elternteil in Familie
        else if (event && level === (eventLevel || 1) + 1) {
          // Unterfeld eines Ereignisses (BIRT oder DEAT)
          const target = event === "BIRT" ? current.birth : current.death;
          if (tag === "DATE") target.date  = value; // z.B. "12 APR 1843"
          if (tag === "PLAC") target.place = value; // z.B. "Hamburg, Deutschland"
        }
      } else if (currentType === "FAM") {
        // ── Familien-Felder ──────────────────────────────────────────────────
        if      (level === 1 && tag === "HUSB") current.husb = value;        // personId Ehemann
        else if (level === 1 && tag === "WIFE") current.wife = value;        // personId Ehefrau
        else if (level === 1 && tag === "CHIL") current.chil.push(value);    // Kind-personId
        else if (event === "MARR" && level === (eventLevel || 1) + 1) {
          // Heiratsdaten
          if (tag === "DATE") current.marr.date  = value;
          if (tag === "PLAC") current.marr.place = value;
        }
      }
    }

    // ── Hilfsindex: Alphabetische Personenliste ───────────────────────────────
    // Wird für die Suche und das Dropdown verwendet.
    const peopleByName = Object.values(people).map(p => ({
      id:      p.id,
      display: formatName(p.name), // Sauber formatierter Name ohne Slashes
      rawName: p.name,             // Rohname (für fuzzy-Suche)
      birth:   p.birth,
      death:   p.death,
      sex:     p.sex
    }));

    // Alphabetisch nach Anzeigename sortieren (Deutsch: ä/ö/ü korrekt)
    peopleByName.sort((a, b) => a.display.localeCompare(b.display, "de"));

    return { people, families, peopleByName };
  }

  /**
   * Entfernt GEDCOM-Slashnotation aus dem Namen.
   * GEDCOM kodiert Nachnamen mit Slashes: "Johann /Schwießelmann/"
   * → Ausgabe: "Johann Schwießelmann"
   *
   * @param {string} name
   * @returns {string}
   */
  function formatName(name) {
    return String(name || "")
      .replace(/\//g, "")   // Slashes entfernen
      .replace(/\s+/g, " ") // Mehrfachspaces normieren
      .trim();
  }

  /**
   * Erstellt einen Namens-Index für O(1)-Suche nach Personen-IDs.
   * Gibt eine Map zurück: lowercase-Name → [personId, …]
   *
   * @param {{ peopleByName: Array }} data – Ausgabe von parseGed()
   * @returns {{ nameToIds: Map }}
   */
  function buildLookup(data) {
    const nameToIds = new Map();
    for (const person of data.peopleByName) {
      const key = person.display.toLowerCase();
      if (!nameToIds.has(key)) nameToIds.set(key, []);
      nameToIds.get(key).push(person.id);
    }
    return { nameToIds };
  }

  /**
   * Gibt Geburts- und Todesjahr einer Person als lesbaren String zurück.
   * Beispiele: "1843 – 1912" | "1901 – ?" | ""
   *
   * @param {object} person – Person-Objekt aus parseGed()
   * @returns {string}
   */
  function getDisplayYears(person) {
    const birth = person.birth?.date || "";
    const death = person.death?.date || "";
    if (!birth && !death) return "";
    return `${birth || "?"}${death ? " – " + death : ""}`;
  }

  /**
   * Extrahiert das Geburtsjahr als Zahl (für Sortierung).
   * Gibt null zurück wenn kein Datum vorhanden.
   *
   * @param {object} person
   * @returns {number|null}
   */
  function getBirthYear(person) {
    const date = person.birth?.date || "";
    const m    = date.match(/(\d{4})/);
    return m ? Number(m[1]) : null;
  }

  // Öffentliche API
  window.GedParser = {
    parseGed,
    formatName,
    buildLookup,
    getDisplayYears,
    getBirthYear
  };

})();
