/**
 * app.js – Schwießelmann Familienwebseite
 * ========================================
 * Haupt-JavaScript für den interaktiven Stammbaum.
 *
 * Aufbau:
 *   1. Zustand (state)
 *   2. Hilfsfunktionen (esc, normalize, setStatus, …)
 *   3. Datenzugriff (parentFamsOf, spouseIn, findRootFam)
 *   4. Layout-Engine (buildFamNode → measureNode → placeNode)
 *   5. Rendering (renderTree, drawNode, makeCard, SVG-Linien)
 *   6. Detail-Panel (renderDetail)
 *   7. Suche mit Highlighting (applySearch, highlightMatches)
 *   8. Drag-to-scroll
 *   9. Init
 */

(() => {
  // ── 1. DOM-Referenzen & Zustand ──────────────────────────────────────────

  const treeContainer   = document.getElementById("treeContainer");
  const detailPanel     = document.getElementById("detailPanel");
  const statIndividuals = document.getElementById("statIndividuals");
  const statFamilies    = document.getElementById("statFamilies");
  const personSearch    = document.getElementById("personSearch");
  const personList      = document.getElementById("personList");
  const matchSelect     = document.getElementById("matchSelect");

  const DEFAULT_GED_PATH = "data/schwiesselmann_stammbaum.ged";

  /**
   * Globaler Anwendungszustand.
   * @property {object|null}  data            – Geparstes GED-Objekt (GedParser.parseGed)
   * @property {string|null}  rootFamId       – ID der obersten anzuzeigenden Familie
   * @property {Set<string>}  expanded        – Menge der aufgeklappten Familien-IDs
   * @property {string|null}  selectedPersonId – Aktuell selektierte Person (Karte + Detail)
   * @property {Set<string>}  highlightedIds  – Alle Personen-IDs, die durch Suche markiert sind
   * @property {string}       searchTerm      – Aktueller Suchbegriff
   */
  const state = {
    data:             null,
    rootFamId:        null,
    expanded:         new Set(),
    selectedPersonId: null,
    highlightedIds:   new Set(),
    searchTerm:       ""
  };

  // ── 2. Hilfsfunktionen ───────────────────────────────────────────────────

  /** HTML-Sonderzeichen escapen (für innerHTML-Inhalte) */
  function esc(s) {
    return String(s ?? "")
      .replace(/&/g,"&amp;").replace(/</g,"&lt;")
      .replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
  }

  /** Status-Zeile im Stammbaum-Werkzeugkasten aktualisieren */
  function setStatus(title, text) {
    const a = document.getElementById("statStatus");
    const b = document.getElementById("statusText");
    if (a) a.textContent = title;
    if (b) b.textContent = text;
  }

  /** Statistik-Zahlen (Personen / Familien) aktualisieren */
  function updateStats() {
    if (!state.data) return;
    statIndividuals.textContent = Object.keys(state.data.people).length;
    statFamilies.textContent    = Object.keys(state.data.families).length;
  }

  /** Anzeigename einer Person (Slashnotation entfernt) */
  function personLabel(p) { return GedParser.formatName(p.name) || p.id; }

  /** Geburts- und Todesjahr als kurzen String, z.B. "1843 – 1912" */
  function personYears(p) {
    const b = (p.birth?.date || "").match(/(\d{4})/)?.[1] || "";
    const d = (p.death?.date || "").match(/(\d{4})/)?.[1] || "";
    return b ? b + (d ? " – " + d : "") : d ? "† " + d : "";
  }

  /**
   * Text normalisieren für Suche:
   * Kleinbuchstaben, ß→ss, Sonderzeichen entfernen, Leerzeichen normieren.
   */
  function normalize(v) {
    return String(v || "").toLowerCase()
      .replace(/\u00df/g,"ss")
      .replace(/[^\p{L}\p{N}\s]+/gu," ")
      .replace(/\s+/g," ").trim();
  }

  // ── 3. Datenzugriff ──────────────────────────────────────────────────────

  /**
   * Gibt alle FAMS-Familien zurück, in denen personId Elternteil ist
   * UND die mindestens ein Kind haben.
   */
  function parentFamsOf(personId) {
    const p = state.data.people[personId];
    if (!p) return [];
    return (p.fams || [])
      .map(id => state.data.families[id])
      .filter(f => f && (f.chil || []).length > 0);
  }

  /**
   * Gibt den Ehepartner von personId in einer bestimmten Familie zurück,
   * oder null wenn keiner vorhanden.
   */
  function spouseIn(fam, personId) {
    const sid = fam.husb === personId ? fam.wife
              : fam.wife === personId ? fam.husb : null;
    return sid ? state.data.people[sid] : null;
  }

  /**
   * Sucht die älteste Wurzelfamilie:
   * Ein Paar, dessen Mitglieder selbst in keiner Familie als Kind (FAMC) erscheinen.
   * Fallback: älteste Familie mit Kindern überhaupt.
   */
  function findRootFam() {
    // Alle Personen, die irgendwo als Kind gelistet sind
    const childSet = new Set();
    Object.values(state.data.families).forEach(f =>
      (f.chil || []).forEach(id => childSet.add(id)));

    // Familien, deren Eltern KEINE Kinder in anderen Familien sind
    const candidates = Object.values(state.data.families).filter(f => {
      if (!(f.chil || []).length) return false;
      return !(f.husb && childSet.has(f.husb)) && !(f.wife && childSet.has(f.wife));
    });

    const pool = candidates.length
      ? candidates
      : Object.values(state.data.families).filter(f => (f.chil || []).length);

    // Sortierung nach frühestem Geburtsjahr der Elternteile
    pool.sort((a, b) => {
      const yr = fam => {
        const ids = [fam.husb, fam.wife].filter(Boolean);
        const ys  = ids.map(id => GedParser.getBirthYear(state.data.people[id])).filter(y => y != null);
        return ys.length ? Math.min(...ys) : 9999;
      };
      return yr(a) - yr(b);
    });

    return pool[0] || null;
  }

  // ── 4. Layout-Engine ─────────────────────────────────────────────────────
  //
  // Ablauf:
  //   buildFamNode(famId) → Baut den Baum als verschachtelte Objekte auf
  //   measureNode(node)   → Berechnet die Breite jedes Knotens (bottom-up)
  //   placeNode(node)     → Weist Pixel-Koordinaten zu (top-down)
  //
  // Datenstrukturen:
  //
  //   FamNode = {
  //     famId:    string,        – GED-Familien-ID
  //     husb:     Person|null,   – Ehemann (Person-Objekt aus GED)
  //     wife:     Person|null,   – Ehefrau
  //     // Wichtig: childIsHusb/childIsWife merken, auf welcher Seite das Kind steht,
  //     //          damit beim Aufklappen Mann/Frau nicht vertauscht werden.
  //     childPersonId: string|null,  – ID der Person, die in dieser Familie das "Kind von oben" ist
  //     children: ChildSlot[]|null,  – null = zugeklappt, Array = aufgeklappt
  //     x, y, w:  number             – Pixelwerte (werden in place/measure gesetzt)
  //   }
  //
  //   ChildSlot = {
  //     person:       Person,       – das Kind selbst
  //     spousePerson: Person|null,  – Ehepartner des Kindes (falls vorhanden)
  //     subFamId:     string|null,  – ID der Familie, in der das Kind Elternteil ist
  //     subFamNode:   FamNode|null, – aufgeklappte Unterfamilie (oder null)
  //     x, y, w:      number
  //   }

  const CW   = 160; // Kartenbreite in Pixeln
  const CH   = 72;  // Kartenhöhe in Pixeln
  const HGAP = 24;  // Horizontaler Abstand zwischen Geschwister-Gruppen
  const CGAP = 20;  // Abstand zwischen Ehemann- und Ehefrau-Karte
  const VGAP = 76;  // Vertikaler Abstand zwischen Elternzeile und Kinderzeile
  const PAD  = 48;  // Außenabstand (Rand des Canvas)

  /**
   * Baut den FamNode-Baum auf Basis des aktuellen state.expanded-Sets.
   *
   * @param {string}      famId         – zu bauende Familie
   * @param {string|null} childPersonId – ID der Person, die von oben als Kind kommt
   *                                      (damit ihre Position in der Karte stabil bleibt)
   */
  function buildFamNode(famId, childPersonId = null) {
    const fam = state.data.families[famId];
    if (!fam) return null;

    const node = {
      famId,
      husb:          fam.husb ? state.data.people[fam.husb] : null,
      wife:          fam.wife ? state.data.people[fam.wife] : null,
      childPersonId, // Welche Person kam als Kind von oben?
      children:      null,
      w: 0, x: 0, y: 0
    };

    // Nur aufklappen wenn diese Familie im expanded-Set steht
    if (state.expanded.has(famId)) {
      // Erstelle Slots für alle Kinder
      const slots = (fam.chil || [])
        .map(id => state.data.people[id])
        .filter(Boolean)
        .map(child => {
          // Suche die Partnerfamilie des Kindes (erste mit Kindern)
          const subFams = parentFamsOf(child.id);
          const subFam  = subFams[0] || null;
          const spouse  = subFam ? spouseIn(subFam, child.id) : null;

          // Rekursiv aufbauen, childPersonId = child.id damit Position stabil bleibt
          const subNode = (subFam && state.expanded.has(subFam.id))
            ? buildFamNode(subFam.id, child.id)
            : null;

          return {
            person:       child,
            spousePerson: spouse,
            subFamId:     subFam?.id || null,
            subFamNode:   subNode,
            x: 0, y: 0, w: 0
          };
        });

      // Deduplizierung: Personen, die bereits als Ehepartner in einem anderen Slot
      // erscheinen, nicht nochmals als eigenständiges Kind anzeigen.
      const spouseIds = new Set(
        slots.filter(s => s.spousePerson).map(s => s.spousePerson.id)
      );

      node.children = slots.filter(s => !spouseIds.has(s.person.id));
    }

    return node;
  }

  /**
   * Berechnet rekursiv die Gesamtbreite jedes FamNode (bottom-up).
   * Ergebnis wird in node.w und slot.w gespeichert.
   */
  function measureNode(node) {
    // Zugeklappt: Breite hängt davon ab ob ein oder zwei Elternteile vorhanden sind
    if (!node.children || !node.children.length) {
      node.w = (node.husb && node.wife) ? CW * 2 + CGAP : CW;
      return;
    }

    let total = 0;
    for (const slot of node.children) {
      let slotW;
      if (slot.subFamNode) {
        // Rekursiv messen
        measureNode(slot.subFamNode);
        slotW = slot.subFamNode.w;
      } else if (slot.spousePerson) {
        // Kind + Ehepartner nebeneinander
        slotW = CW * 2 + CGAP;
      } else {
        // Einzelkind ohne Partner
        slotW = CW;
      }
      slot.w = slotW;
      total += slotW;
    }
    // Lücken zwischen den Slots addieren
    total += HGAP * (node.children.length - 1);
    // Mindestbreite: Paar oder Einzelperson
    const minW = (node.husb && node.wife) ? CW * 2 + CGAP : CW;
    node.w = Math.max(total, minW);
  }

  /**
   * Weist jedem FamNode und ChildSlot Pixel-Koordinaten zu (top-down).
   * node.x/y = obere-linke Ecke des Gesamtblocks.
   */
  function placeNode(node, leftX, topY) {
    node.x = leftX;
    node.y = topY;

    if (!node.children || !node.children.length) return;

    const childY  = topY + CH + VGAP;
    const childrenTotalW = node.children.reduce((s, sl) => s + sl.w, 0)
                          + HGAP * (node.children.length - 1);
    // Kinder zentriert unter dem Elternblock platzieren
    let cursor = leftX + (node.w - childrenTotalW) / 2;

    for (const slot of node.children) {
      slot.x = cursor;
      slot.y = childY;
      // Wenn diese Unterfamilie aufgeklappt ist, rekursiv platzieren
      if (slot.subFamNode) {
        placeNode(slot.subFamNode, cursor, childY);
      }
      cursor += slot.w + HGAP;
    }
  }

  // ── 5. Rendering ─────────────────────────────────────────────────────────

  /**
   * Haupt-Renderfunktion: löscht den Container und zeichnet den Baum neu.
   *
   * @param {number} [restoreScrollLeft] – Scroll-X nach dem Rendern wiederherstellen
   * @param {number} [restoreScrollTop]  – Scroll-Y nach dem Rendern wiederherstellen
   */
  function renderTree(restoreScrollLeft, restoreScrollTop) {
    treeContainer.innerHTML = "";

    if (!state.data || !state.rootFamId) {
      treeContainer.innerHTML = `<div class="empty-state"><h3>Keine Daten geladen</h3></div>`;
      return;
    }

    // Baum aufbauen, messen, platzieren
    const root = buildFamNode(state.rootFamId, null);
    if (!root) return;
    measureNode(root);
    placeNode(root, PAD, PAD);

    // Canvas-Größe aus dem Bounding-Box des gesamten Baums bestimmen
    const { maxX, maxY } = computeBounds(root);
    const canvasW = maxX + PAD;
    const canvasH = maxY + PAD;

    // Wrapper-Div (relativ positioniert, so groß wie der Canvas)
    const wrap = document.createElement("div");
    wrap.style.cssText = `position:relative;width:${canvasW}px;height:${canvasH}px;`;

    // SVG für Verbindungslinien (liegt unter den Karten)
    const svg = document.createElementNS("http://www.w3.org/2000/svg","svg");
    svg.setAttribute("width",  canvasW);
    svg.setAttribute("height", canvasH);
    svg.style.cssText = "position:absolute;top:0;left:0;pointer-events:none;overflow:visible;";
    wrap.appendChild(svg);

    // Baum zeichnen (rekursiv)
    drawNode(root, wrap, svg, /*isRoot=*/true);

    treeContainer.appendChild(wrap);

    // Scroll-Position wiederherstellen oder Initial-Zentrierung
    if (restoreScrollLeft !== undefined) {
      treeContainer.scrollLeft = restoreScrollLeft;
      treeContainer.scrollTop  = restoreScrollTop;
    } else {
      // Beim ersten Laden: Elternpaar horizontal zentrieren
      const coupleCenter = root.x + root.w / 2;
      treeContainer.scrollLeft = Math.max(0, coupleCenter - treeContainer.clientWidth / 2);
      treeContainer.scrollTop  = 0;
    }
  }

  /**
   * Berechnet die rechte und untere Grenze aller Knoten rekursiv.
   * Wird für die Canvas-Größe benötigt.
   */
  function computeBounds(node) {
    let maxX = node.x + node.w;
    let maxY = node.y + CH;
    if (node.children) {
      for (const slot of node.children) {
        maxX = Math.max(maxX, slot.x + slot.w);
        maxY = Math.max(maxY, slot.y + CH);
        if (slot.subFamNode) {
          const sub = computeBounds(slot.subFamNode);
          maxX = Math.max(maxX, sub.maxX);
          maxY = Math.max(maxY, sub.maxY);
        }
      }
    }
    return { maxX, maxY };
  }

  /** SVG-Linie zeichnen */
  function svgLine(svg, x1, y1, x2, y2, cls) {
    const l = document.createElementNS("http://www.w3.org/2000/svg","line");
    l.setAttribute("x1",x1); l.setAttribute("y1",y1);
    l.setAttribute("x2",x2); l.setAttribute("y2",y2);
    l.setAttribute("class", cls || "tree-line");
    svg.appendChild(l);
  }

  /** SVG-Kreis zeichnen (Eheverbindungs-Symbol) */
  function svgCircle(svg, cx, cy, r, cls) {
    const c = document.createElementNS("http://www.w3.org/2000/svg","circle");
    c.setAttribute("cx",cx); c.setAttribute("cy",cy); c.setAttribute("r",r);
    c.setAttribute("class", cls || "tree-ring");
    svg.appendChild(c);
  }

  /**
   * Zeichnet einen FamNode:
   *   – Elternpaar (Husb links, Wife rechts – stabil, auch nach Aufklappen)
   *   – Verbindungslinie zwischen den Karten
   *   – Aufklapp-Button (▼/▲)
   *   – Wenn aufgeklappt: Verbindungslinien zu Kindern + alle Kinder-Slots
   *
   * WICHTIG – Positions-Stabilität:
   *   node.childPersonId gibt an, welche Person in dieser Familie "von oben" kommt.
   *   Diese Person bleibt IMMER auf ihrer Seite (husb=links, wife=rechts) – unabhängig
   *   davon, ob die Familie aufgeklappt wird oder nicht.
   *   Dadurch wird das Vertauschen von Mann/Frau beim Aufklappen verhindert.
   */
  function drawNode(node, wrap, svg, isRoot) {
    const { husb, wife, children, x, y, w } = node;

    // Elternpaar horizontal zentrieren innerhalb des Gesamtblocks.
    // Bei nur einem Elternteil: einzelne Karte zentriert, kein Verbindungsring.
    const hasBoth       = !!(husb && wife);
    const coupleW       = hasBoth ? CW * 2 + CGAP : CW;
    const coupleLeftX   = x + (w - coupleW) / 2;
    const husbX         = coupleLeftX;
    const wifeX         = hasBoth ? coupleLeftX + CW + CGAP : coupleLeftX; // bei Einzel: gleiche pos
    const coupleCenterX = coupleLeftX + coupleW / 2;
    const coupleMidY    = y + CH / 2;

    // Karten zeichnen
    if (husb) makeCard(wrap, husb, husbX, y, { isRoot });
    if (wife) makeCard(wrap, wife, wifeX, y, { isRoot });

    // Horizontale Verbindungslinie zwischen den Elternkarten + Ring-Symbol (nur bei Paar)
    if (hasBoth) {
      svgLine(svg, husbX + CW, coupleMidY, wifeX, coupleMidY, "tree-line tree-line--couple");
      svgCircle(svg, husbX + CW + CGAP / 2, coupleMidY, 5, "tree-ring");
    }

    // Aufklapp-Button (▼ = zugeklappt, ▲ = aufgeklappt)
    // Wird zentriert unter dem Ehepaar-Verbindungsring platziert
    if (node.famId) {
      const fam     = state.data.families[node.famId];
      const hasKids = (fam?.chil || []).length > 0;
      if (hasKids) {
        const isExp = state.expanded.has(node.famId);
        const btn   = document.createElement("button");
        btn.className = "tree-toggle" + (isExp ? " tree-toggle--open" : "");
        btn.title     = isExp ? "Kinder ausblenden" : "Kinder anzeigen";
        btn.style.cssText = `left:${coupleCenterX - 13}px;top:${y + CH + 8}px;`;
        btn.innerHTML = isExp ? "▲" : "▼";
        btn.setAttribute("data-fam-toggle", node.famId);
        btn.addEventListener("click", e => {
          e.stopPropagation();
          toggleExpand(node.famId, isExp, btn);
        });
        wrap.appendChild(btn);
      }
    }

    // Wenn aufgeklappt: Kinder zeichnen
    if (children && children.length) {
      const childY     = y + CH + VGAP;
      // Abzweige-Y: Punkt auf halbem Weg zwischen Elternkarte und Kindkarte
      const stemBottom = y + CH + VGAP * 0.42;

      // Vertikaler Stamm von Elternmitte nach unten bis zur Querebene
      svgLine(svg, coupleCenterX, y + CH, coupleCenterX, stemBottom, "tree-line");

      // X-Mitte jedes Kind-Slots berechnen (für horizontale Querlinie und Tropflinien)
      const childCenters = children.map(slot => {
        if (slot.subFamNode) {
          // Aufgeklappte Unterfamilie: Mitte des Gesamtblocks
          return slot.x + slot.subFamNode.w / 2;
        } else if (slot.spousePerson) {
          // Kind + Ehepartner: Mitte zwischen beiden Karten (immer 2 Karten)
          return slot.x + (CW * 2 + CGAP) / 2;
        } else {
          // Einzelkind ohne Partner: Mitte der einzelnen Karte
          return slot.x + CW / 2;
        }
      });

      // Horizontale Querlinie über alle Kinder
      const barL = childCenters[0];
      const barR = childCenters[childCenters.length - 1];
      if (barL !== barR) {
        svgLine(svg, barL, stemBottom, barR, stemBottom, "tree-line");
      }

      // Tropflinien von Querlinie zu jeder Kindkarte
      for (const cx of childCenters) {
        svgLine(svg, cx, stemBottom, cx, childY, "tree-line");
      }

      // Jeden Kind-Slot zeichnen
      for (let i = 0; i < children.length; i++) {
        const slot = children[i];

        if (slot.subFamNode) {
          // Kind ist selbst Elternteil einer aufgeklappten Familie:
          // → als kompletten Familienblock rekursiv zeichnen
          // → KEINE separate Kind-Karte, da die Person als husb/wife im subFamNode steckt
          drawNode(slot.subFamNode, wrap, svg, /*isRoot=*/false);

        } else {
          // Kind als einfache Karte zeichnen
          const childHasFams = parentFamsOf(slot.person.id).length > 0;

          // Bestimme die korrekte Seite des Kindes (husb=links, wife=rechts),
          // damit die Position vor und nach dem Aufklappen identisch ist.
          let childX  = slot.x;
          let spouseX = slot.x + CW + CGAP;
          if (slot.subFamId && slot.spousePerson) {
            const subFam = state.data.families[slot.subFamId];
            if (subFam && subFam.wife === slot.person.id) {
              // Kind ist die Frau in der Unterfamilie → Kind rechts, Ehepartner links
              childX  = slot.x + CW + CGAP;
              spouseX = slot.x;
            }
          }

          makeCard(wrap, slot.person, childX, slot.y, { expandable: childHasFams });

          // Ehepartner-Karte des Kindes (falls vorhanden, aber noch nicht aufgeklappt)
          if (slot.spousePerson) {
            makeCard(wrap, slot.spousePerson, spouseX, slot.y, { isSpouse: true });
            // Verbindungslinie + Ring zwischen Kind und Ehepartner
            const lineL = Math.min(childX, spouseX) + CW;
            const lineR = Math.max(childX, spouseX);
            svgLine(svg, lineL, slot.y + CH/2, lineR, slot.y + CH/2, "tree-line tree-line--couple");
            svgCircle(svg, lineL + (lineR - lineL) / 2, slot.y + CH/2, 4, "tree-ring");
          }

          // Aufklapp-Button für die Unterfamilie des Kindes
          if (childHasFams && slot.subFamId) {
            const isSubExp = state.expanded.has(slot.subFamId);
            // Button zentriert auf den Verbindungsring (Paar) oder Kartenmitte (Einzelkind)
            const btnCx = slot.spousePerson
              ? slot.x + CW + CGAP / 2   // Mitte zwischen Kind- und Ehepartnerkarte
              : childX + CW / 2;          // Mitte der einzelnen Kind-Karte (berücksichtigt childX)
            const btn   = document.createElement("button");
            btn.className     = "tree-toggle" + (isSubExp ? " tree-toggle--open" : "");
            btn.title         = isSubExp ? "Kinder ausblenden" : "Kinder anzeigen";
            btn.style.cssText = `left:${btnCx - 13}px;top:${slot.y + CH + 8}px;`;
            btn.setAttribute("data-fam-toggle", slot.subFamId);
            btn.innerHTML     = isSubExp ? "▲" : "▼";
            btn.addEventListener("click", e => {
              e.stopPropagation();
              toggleExpand(slot.subFamId, isSubExp, btn);
            });
            wrap.appendChild(btn);
          }
        }
      }
    }
  }

  /**
   * Klappt eine Familie auf oder zu.
   * Beim Zuklappen werden alle Nachkommen-Familien ebenfalls geschlossen.
   * Nach dem Re-Render wird die Scroll-Position so angepasst, dass der
   * geklickte Aufklapp-Button an derselben Bildschirmposition bleibt.
   */
  function toggleExpand(famId, currentlyExpanded, triggerBtn) {
    // Bildschirmposition des Buttons vor dem Render merken
    let btnScreenLeft = null;
    let btnScreenTop  = null;
    if (triggerBtn) {
      const rect = triggerBtn.getBoundingClientRect();
      const containerRect = treeContainer.getBoundingClientRect();
      btnScreenLeft = rect.left - containerRect.left;
      btnScreenTop  = rect.top  - containerRect.top;
    }

    if (currentlyExpanded) {
      collapseDescendants(famId);
    } else {
      state.expanded.add(famId);
    }

    // Baum neu rendern (Scroll wird danach angepasst)
    renderTree(treeContainer.scrollLeft, treeContainer.scrollTop);

    // Nach dem Render: neuen Button mit gleichem famId suchen und Scroll korrigieren
    if (triggerBtn && btnScreenLeft !== null) {
      const newBtn = treeContainer.querySelector(`[data-fam-toggle="${CSS.escape(famId)}"]`);
      if (newBtn) {
        const containerRect = treeContainer.getBoundingClientRect();
        const newRect = newBtn.getBoundingClientRect();
        const newScreenLeft = newRect.left - containerRect.left;
        const newScreenTop  = newRect.top  - containerRect.top;
        treeContainer.scrollLeft += newScreenLeft - btnScreenLeft;
        treeContainer.scrollTop  += newScreenTop  - btnScreenTop;
      }
    }
  }

  /**
   * Entfernt eine Familie und alle ihre Nachkommen-Familien aus dem expanded-Set.
   * Wird rekursiv aufgerufen.
   */
  function collapseDescendants(famId) {
    state.expanded.delete(famId);
    const fam = state.data.families[famId];
    if (!fam) return;
    for (const childId of (fam.chil || [])) {
      for (const sf of parentFamsOf(childId)) {
        collapseDescendants(sf.id);
      }
    }
  }

  /**
   * Erstellt eine Personen-Karte und hängt sie in wrap ein.
   *
   * CSS-Klassen nach Zustand:
   *   tree-card--selected    – aktuell angeklickte Person
   *   tree-card--highlighted – Suchtreffer (aber nicht selected)
   *   tree-card--root        – oberstes Elternpaar
   *   tree-card--male        – männlich (blauer Rand)
   *   tree-card--female      – weiblich (rosa Rand)
   *   tree-card--spouse      – Ehepartner-Karte (optisch etwas zurückgenommen)
   */
  function makeCard(wrap, person, x, y, opts = {}) {
    const isSelected    = state.selectedPersonId  === person.id;
    const isHighlighted = state.highlightedIds.has(person.id);

    const card = document.createElement("div");
    card.className = [
      "tree-card",
      isSelected    ? "tree-card--selected"    : "",
      isHighlighted && !isSelected ? "tree-card--highlighted" : "",
      opts.isRoot   ? "tree-card--root"        : "",
      person.sex === "M" ? "tree-card--male"   : "",
      person.sex === "F" ? "tree-card--female" : "",
      opts.isSpouse ? "tree-card--spouse"      : "",
    ].filter(Boolean).join(" ");

    card.style.cssText = `left:${x}px;top:${y}px;width:${CW}px;min-height:${CH}px;`;
    card.innerHTML = `
      <div class="tree-card__name">${esc(personLabel(person))}</div>
      ${personYears(person) ? `<div class="tree-card__years">${esc(personYears(person))}</div>` : ""}
    `;

    // Klick: Person selektieren, Detail anzeigen, Highlighting neu setzen
    card.addEventListener("click", () => {
      state.selectedPersonId = person.id;
      // Nur Klassen neu setzen, kein komplettes Re-Render
      wrap.querySelectorAll(".tree-card--selected")
          .forEach(el => el.classList.remove("tree-card--selected"));
      card.classList.add("tree-card--selected");
      renderDetail(person.id);
    });

    wrap.appendChild(card);
  }

  // ── 6. Detail-Panel ──────────────────────────────────────────────────────

  /**
   * Füllt das rechte Detail-Panel mit Informationen zur gewählten Person:
   * Geschlecht, Geburt, Tod, Eltern, Partner, Kinder.
   * Kinder und Partner sind anklickbare Links.
   */
  function renderDetail(personId) {
    if (!state.data || !personId) return;
    const person = state.data.people[personId];
    if (!person) return;

    const families   = (person.fams || []).map(id => state.data.families[id]).filter(Boolean);
    const parentFams = (person.famc || []).map(id => state.data.families[id]).filter(Boolean);

    // Elternteil-Zeile
    let parHtml = "";
    if (parentFams.length) {
      const pf = parentFams[0];
      const f  = pf.husb ? personLabel(state.data.people[pf.husb]) : "";
      const m  = pf.wife ? personLabel(state.data.people[pf.wife]) : "";
      parHtml  = `<p><strong>Eltern:</strong> ${esc([f,m].filter(Boolean).join(" & ") || "—")}</p>`;
    }

    // Familien-Zeilen (Partner + Heirat + Kinder)
    let famHtml = "";
    for (const fam of families) {
      const sp   = spouseIn(fam, personId);
      const kids = (fam.chil || []).map(id => state.data.people[id]).filter(Boolean);
      const marr = fam.marr?.date
        ? fam.marr.date + (fam.marr.place ? " · " + fam.marr.place : "")
        : "";
      famHtml += `<div class="detail-family">
        ${sp   ? `<p><strong>Partner:</strong> <a href="#" class="detail-link" data-id="${esc(sp.id)}">${esc(personLabel(sp))}</a></p>` : ""}
        ${marr ? `<p><strong>Heirat:</strong> ${esc(marr)}</p>` : ""}
        ${kids.length
          ? `<p><strong>Kinder (${kids.length}):</strong><br>
             ${kids.map(k => `<a href="#" class="detail-link" data-id="${esc(k.id)}">${esc(personLabel(k))}</a>`).join(", ")}</p>`
          : ""}
      </div>`;
    }

    detailPanel.innerHTML = `
      <h3>${esc(personLabel(person))}</h3>
      <p class="detail-sex">${person.sex==="M" ? "♂ Männlich" : person.sex==="F" ? "♀ Weiblich" : ""}</p>
      <p><strong>Geburt:</strong> ${esc(person.birth?.date||"—")}${person.birth?.place ? " · "+esc(person.birth.place) : ""}</p>
      <p><strong>Tod:</strong> ${esc(person.death?.date||"—")}${person.death?.place ? " · "+esc(person.death.place) : ""}</p>
      ${parHtml}${famHtml}
    `;

    // Links in Detail-Panel verdrahten
    detailPanel.querySelectorAll(".detail-link").forEach(a => {
      a.addEventListener("click", e => {
        e.preventDefault();
        state.selectedPersonId = a.dataset.id;
        renderDetail(a.dataset.id);
      });
    });
  }

  // ── 7. Suche mit Highlighting ─────────────────────────────────────────────

  /**
   * Aktualisiert state.highlightedIds basierend auf dem Suchbegriff
   * und rendert den Baum neu, um die Highlights zu zeigen.
   *
   * Sonderfall: genau 1 Treffer → Person sofort selektieren + Detail anzeigen.
   */
  function applySearch(value) {
    state.searchTerm = value.trim();
    const q = normalize(state.searchTerm);

    if (!q) {
      // Leere Suche: alles zurücksetzen
      state.highlightedIds.clear();
      refreshSearchDropdown([]);
      setStatus("Bereit", "Stammbaum bereit");
      renderTree(treeContainer.scrollLeft, treeContainer.scrollTop);
      return;
    }

    // Alle Personen suchen, die den Begriff enthalten
    const people  = state.data?.peopleByName || [];
    const matches = people.filter(p =>
      normalize(p.display + " " + p.rawName).includes(q)
    );

    // Highlighted-Set neu aufbauen
    state.highlightedIds = new Set(matches.map(p => p.id));

    // Dropdown befüllen
    refreshSearchDropdown(matches);

    if (matches.length === 0) {
      setStatus("Keine Treffer", "Suchbegriff ändern");
    } else if (matches.length === 1) {
      // Genau 1 Treffer → direkt selektieren
      setStatus("1 Treffer", matches[0].display);
      state.selectedPersonId = matches[0].id;
      renderDetail(matches[0].id);
    } else {
      setStatus(`${matches.length} Treffer`, "Im Stammbaum hervorgehoben");
    }

    // Baum neu zeichnen (Scroll-Position erhalten)
    renderTree(treeContainer.scrollLeft, treeContainer.scrollTop);
  }

  /**
   * Befüllt das Suchvorschlag-Dropdown mit den aktuellen Treffern.
   * @param {Array} matches – Array von {id, display, rawName}
   */
  function refreshSearchDropdown(matches) {
    // Datalist für Browser-Autocomplete
    const people = state.data?.peopleByName || [];
    personList.innerHTML = people.slice(0, 300)
      .map(p => `<option value="${esc(p.display)}"></option>`).join("");

    // Select-Dropdown für Treffer-Navigation
    matchSelect.innerHTML = "";
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = matches.length ? `${matches.length} Treffer` : "Keine Auswahl";
    matchSelect.appendChild(empty);
    matches.slice(0, 80).forEach(p => {
      const o = document.createElement("option");
      o.value = p.id; o.textContent = p.display;
      matchSelect.appendChild(o);
    });
  }

  /**
   * Person per ID auswählen (aus Dropdown oder extern).
   * Setzt selectedPersonId, aktualisiert Suche, rendert Detail + Baum.
   */
  function selectById(id) {
    if (!state.data || !id) return;
    state.selectedPersonId = id;
    const p = state.data.people[id];
    if (!p) return;

    personSearch.value = personLabel(p);
    state.searchTerm   = personSearch.value;
    setStatus("Ausgewählt", personLabel(p));
    renderDetail(id);
    // Nur die selektierte Person als highlighted zeigen
    state.highlightedIds = new Set([id]);
    renderTree(treeContainer.scrollLeft, treeContainer.scrollTop);
  }

  // Event-Listener für Suchfeld und Dropdown
  personSearch.addEventListener("input",  () => applySearch(personSearch.value));
  personSearch.addEventListener("change", () => applySearch(personSearch.value));
  matchSelect.addEventListener("change",  () => selectById(matchSelect.value));

  // ── 8. Drag-to-Scroll ────────────────────────────────────────────────────
  // Erlaubt das Verschieben des Baums durch Klicken und Ziehen auf dem Hintergrund.

  let isDragging = false, dragStartX, dragStartY, dragScrollL, dragScrollT;

  treeContainer.addEventListener("mousedown", e => {
    // Kein Drag starten wenn auf Karte oder Button geklickt
    if (e.target.closest(".tree-card") || e.target.closest(".tree-toggle")) return;
    isDragging  = true;
    dragStartX  = e.pageX;
    dragStartY  = e.pageY;
    dragScrollL = treeContainer.scrollLeft;
    dragScrollT = treeContainer.scrollTop;
    treeContainer.style.cursor = "grabbing";
    e.preventDefault();
  });

  document.addEventListener("mouseup", () => {
    isDragging = false;
    treeContainer.style.cursor = "grab";
  });

  document.addEventListener("mousemove", e => {
    if (!isDragging) return;
    treeContainer.scrollLeft = dragScrollL - (e.pageX - dragStartX);
    treeContainer.scrollTop  = dragScrollT - (e.pageY - dragStartY);
  });

  // ── 9. Initialisierung ───────────────────────────────────────────────────

  /**
   * Lädt die GED-Datei, parst sie, findet die Wurzelfamilie
   * und rendert den Stammbaum zum ersten Mal.
   */
  async function init() {
    try {
      const res = await fetch(DEFAULT_GED_PATH);
      if (!res.ok) throw new Error("GED-Datei nicht gefunden: " + DEFAULT_GED_PATH);

      state.data = GedParser.parseGed(await res.text());

      updateStats();
      setStatus("Bereit", "Stammbaum geladen");
      refreshSearchDropdown([]);

      // Wurzelfamilie bestimmen und Baum rendern
      const rootFam = findRootFam();
      if (rootFam) {
        state.rootFamId = rootFam.id;
        state.expanded.clear(); // Beim Start alles zugeklappt
      }

      renderTree();

      // Initialer Hinweistext im Detail-Panel
      detailPanel.innerHTML = `
        <h3>Details</h3>
        <p class="muted">Klicke eine Person an, um Informationen anzuzeigen.</p>
        <p class="muted" style="margin-top:8px;font-size:12px;">
          ▼ = Kinder anzeigen &nbsp;·&nbsp; ▲ = Kinder ausblenden
        </p>`;

    } catch(err) {
      console.error("[Stammbaum] Fehler beim Laden:", err);
      setStatus("Fehler", "Stammbaum konnte nicht geladen werden");
      treeContainer.innerHTML = `
        <div class="empty-state">
          <h3>Ladefehler</h3>
          <p>${esc(err.message)}</p>
        </div>`;
    }
  }

  init();

})();
