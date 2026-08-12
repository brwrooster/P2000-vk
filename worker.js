// P2000 Post Veluwsekant - Worker: feed-endpoint (RSS + Atom) + statische pagina
const FEED = "https://112-nu.nl/brandweer/rss";

/* ---------- Ploeg- en dienst-berekening (Nederlandse lokale tijd) ---------- */
const PLOEGEN = ["D", "A", "B", "C"];
const PLOEG_ANKER_MS = Date.UTC(2026, 5, 17); // 17 juni 2026 = D-ploeg, lokale kalenderdag

function nlDatumTijd(datum) {
  // Geeft {jaar, maand(0-11), dag, uur} terug in Europe/Amsterdam-tijd, ongeacht de UTC-klok van de Worker
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Amsterdam",
    year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", hour12: false
  });
  const stukken = {};
  for (const d of fmt.formatToParts(datum)) stukken[d.type] = d.value;
  return {
    jaar: parseInt(stukken.year, 10),
    maand: parseInt(stukken.month, 10) - 1,
    dag: parseInt(stukken.day, 10),
    uur: parseInt(stukken.hour, 10) === 24 ? 0 : parseInt(stukken.hour, 10)
  };
}

function dienstDagSleutel(datum) {
  // Dienst loopt 07:00-07:00: voor 07:00 hoort het bij de vorige kalenderdag
  const nl = nlDatumTijd(datum);
  let dagDatum = new Date(Date.UTC(nl.jaar, nl.maand, nl.dag));
  if (nl.uur < 7) dagDatum = new Date(dagDatum.getTime() - 86400000);
  return dagDatum.toISOString().slice(0, 10); // "2026-07-28"
}

function berekenPloeg(datum) {
  const sleutel = dienstDagSleutel(datum);
  const dagMs = Date.UTC(
    parseInt(sleutel.slice(0, 4), 10),
    parseInt(sleutel.slice(5, 7), 10) - 1,
    parseInt(sleutel.slice(8, 10), 10)
  );
  const dagen = Math.round((dagMs - PLOEG_ANKER_MS) / 86400000);
  return PLOEGEN[((dagen % 4) + 4) % 4];
}

/* Werkt de gecombineerde tellingen bij met één nieuwe melding */
function werkTellingenBij(bestaand, nu, ruweTekst) {
  const dienstSleutel = dienstDagSleutel(nu);
  const ploeg = berekenPloeg(nu);
  const jaar = nlDatumTijd(nu).jaar;

  let t = bestaand || {};
  let dienst = t.dienst;
  if (!dienst || dienst.datum !== dienstSleutel) {
    dienst = { datum: dienstSleutel, ploeg: ploeg, aantal: 0, meldingen: [] };
  }
  dienst.aantal += 1;
  if (!Array.isArray(dienst.meldingen)) dienst.meldingen = [];
  dienst.meldingen.push({ ts: nu.getTime(), text: ruweTekst });
  if (dienst.meldingen.length > 30) dienst.meldingen = dienst.meldingen.slice(-30);

  let jaarTelling = t.jaar;
  if (!jaarTelling || jaarTelling.jaar !== jaar) {
    jaarTelling = { jaar: jaar, totaal: 0, A: 0, B: 0, C: 0, D: 0 };
  }
  jaarTelling.totaal += 1;
  jaarTelling[ploeg] = (jaarTelling[ploeg] || 0) + 1;

  return { dienst: dienst, jaar: jaarTelling };
}

/* Bij het ophalen: als de opgeslagen dienst niet meer de huidige dienst is
   (er is nog geen nieuwe melding geweest sinds de wissel om 07:00), toon dan
   een lege dienst-telling voor de weergave - zonder de opslag zelf aan te passen.
   Zo blijft het scherm altijd kloppen, en kost dit geen extra schrijfactie. */
function actualiseerTellingenVoorWeergave(tellingen) {
  if (!tellingen) return tellingen;
  const nu = new Date();
  const huidigeDienstSleutel = dienstDagSleutel(nu);
  const huidigJaar = nlDatumTijd(nu).jaar;

  let dienst = tellingen.dienst;
  if (dienst && dienst.datum !== huidigeDienstSleutel) {
    dienst = { datum: huidigeDienstSleutel, ploeg: berekenPloeg(nu), aantal: 0, meldingen: [] };
  }

  let jaarTelling = tellingen.jaar;
  if (jaarTelling && jaarTelling.jaar !== huidigJaar) {
    jaarTelling = { jaar: huidigJaar, totaal: 0, A: 0, B: 0, C: 0, D: 0 };
  }

  return { dienst: dienst, jaar: jaarTelling };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/log") return logAPI(request, env);
    if (url.pathname === "/api/melding") return meldingJSON();
    if (url.pathname === "/api/taken") return takenAPI(request, env);
    if (url.pathname === "/api/pi") return piAPI(request, env, ctx);
    if (url.pathname === "/api/route") return routeAPI(request);
    return env.ASSETS.fetch(request);
  }
};

/* Routeberekening via Valhalla (bus-profiel: busbanen worden meegenomen).
   Loopt via de Worker omdat de browser directe aanvragen blokkeert. */
async function routeAPI(request) {
  const headers = {
    "content-type": "application/json; charset=UTF-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*"
  };
  try {
    const url = new URL(request.url);
    const opdracht = url.searchParams.get("json");
    const soort = url.searchParams.get("soort") === "matrix"
      ? "sources_to_targets"
      : "route";
    if (!opdracht) {
      return new Response(JSON.stringify({ error: "geen opdracht" }), { headers });
    }
    const doel = "https://valhalla1.openstreetmap.de/" + soort +
                 "?json=" + encodeURIComponent(opdracht);
    const antwoord = await fetch(doel, {
      headers: { "user-agent": "p2000-veluwsekant/1.0" }
    });
    const tekst = await antwoord.text();
    return new Response(tekst, { headers });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { headers });
  }
}

/* Meldingen van de eigen ontvanger (Raspberry Pi via seriële poort).
   Pi doet POST met { text, sleutel }, scherm doet GET. */
const PI_SLEUTEL = "veluwsekant2026";   // eenvoudige beveiliging

async function piAPI(request, env, ctx) {
  const headers = {
    "content-type": "application/json; charset=UTF-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type"
  };
  if (request.method === "OPTIONS") return new Response(null, { headers });
  if (!env.CONFIG) {
    return new Response(JSON.stringify({ error: "geen opslag ingesteld" }), { headers });
  }
  try {
    if (request.method === "POST") {
      const body = await request.json();
      if (body.sleutel !== PI_SLEUTEL) {
        return new Response(JSON.stringify({ error: "ongeldige sleutel" }), { status: 403, headers });
      }
      const melding = {
        text: String(body.text || "").trim(),
        ts: Date.now(),
        id: "pi-" + Date.now()
      };
      if (!melding.text) {
        return new Response(JSON.stringify({ error: "lege melding" }), { headers });
      }

      // Bij meldingen die via de 112-nu-feed komen (bronId meegegeven): voorkom
      // dat meerdere open schermen dezelfde melding elk apart laten meetellen.
      let magTellen = true;
      if (body.bronId) {
        const laatsteBronId = await env.CONFIG.get("laatste_feed_bron_id");
        if (laatsteBronId === body.bronId) {
          magTellen = false; // al geteld door een ander scherm
        } else {
          await env.CONFIG.put("laatste_feed_bron_id", body.bronId);
        }
      }

      await env.CONFIG.put("laatste_pi_melding", JSON.stringify(melding));

      // Log melding naar KV
      const nu = Date.now();
      const logEntry = {
        ts: nu,
        text: melding.text,
        date: new Date(nu).toISOString()
      };
      
      // Haal bestaande logs op
      let logs = [];
      try {
        const bestaande = await env.CONFIG.get("melding_logs");
        if (bestaande) logs = JSON.parse(bestaande);
      } catch (e) {}
      
      // Check: Is dezelfde melding van de afgelopen 2 minuten al gelogd?
      const twoMinutesAgo = nu - (2 * 60 * 1000);
      const isDuplicate = logs.some(log => 
        log.text === melding.text && log.ts > twoMinutesAgo
      );
      
      if (!isDuplicate) {
        // Voeg nieuwe melding toe
        logs.push(logEntry);
        
        // Verwijder meldingen ouder dan 7 dagen
        const zevenDagenGeleden = nu - (7 * 24 * 60 * 60 * 1000);
        logs = logs.filter(log => log.ts > zevenDagenGeleden);
        
        // Sla terug op (max 500 logs)
        if (logs.length > 500) logs = logs.slice(-500);
        await env.CONFIG.put("melding_logs", JSON.stringify(logs));
      }

      // Tellingen bijwerken
      if (!body.test && magTellen) {
        const nuDatum = new Date();
        const bestaandeTellingen = await env.CONFIG.get("tellingen");
        const nieuweTellingen = werkTellingenBij(
          bestaandeTellingen ? JSON.parse(bestaandeTellingen) : null,
          nuDatum,
          melding.text
        );
        await env.CONFIG.put("tellingen", JSON.stringify(nieuweTellingen));
      }

      return new Response(JSON.stringify({ ok: true, id: melding.id }), { headers });
    }

    // Kort (1 seconde) cachen op de rand van het netwerk: als meerdere schermen
    // (telefoon + TV, of straks meerdere posten) bijna gelijktijdig pollen, delen
    // ze binnen dat ene seconde-venster hetzelfde antwoord, in plaats van dat
    // elk scherm apart de opslag bevraagt. Dit heeft geen enkele invloed op de
    // snelheid van een alarm: de eerstvolgende poll (max. 2 seconden later) ziet
    // een nieuwe melding gewoon meteen.
    const cache = caches.default;
    const cacheKey = new Request(request.url, request);
    const gecached = await cache.match(cacheKey);
    if (gecached) return gecached;

    const opgeslagen = await env.CONFIG.get("laatste_pi_melding");
    const antwoord = new Response(opgeslagen || JSON.stringify({ text: null }), {
      headers: Object.assign({}, headers, { "cache-control": "public, max-age=1" })
    });
    if (ctx && ctx.waitUntil) ctx.waitUntil(cache.put(cacheKey, antwoord.clone()));
    return antwoord;
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { headers });
  }
}

/* Taken centraal bewaren (KV), zodat elk scherm dezelfde lijst toont + themeMode */
async function takenAPI(request, env) {
  const headers = {
    "content-type": "application/json; charset=UTF-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,PUT,OPTIONS",
    "access-control-allow-headers": "content-type"
  };
  if (request.method === "OPTIONS") return new Response(null, { headers });
  if (!env.CONFIG) {
    return new Response(JSON.stringify({ error: "geen opslag ingesteld" }), { headers });
  }
  try {
    if (request.method === "PUT") {
      const body = await request.json();
      // Sla taken op
      await env.CONFIG.put("taken", JSON.stringify({
        tasks: body.tasks || [],
        capcodes: body.capcodes || [],
        posts: body.posts || {},
        units: body.units || {},
        holdMin: body.holdMin || 5
      }));
      // Sla themeMode apart op
      if (body.themeMode) {
        await env.CONFIG.put("themeMode", body.themeMode);
      }
      return new Response(JSON.stringify({ ok: true }), { headers });
    }
    
    // GET: haal taken + tellingen + themeMode op
    const opgeslagen = await env.CONFIG.get("taken");
    const tellingenRuw = await env.CONFIG.get("tellingen");
    const themeMode = await env.CONFIG.get("themeMode") || "auto";
    
    const data = opgeslagen ? JSON.parse(opgeslagen) : { tasks: null, capcodes: [], posts: {}, units: {}, holdMin: 5 };
    data.tellingen = tellingenRuw ? actualiseerTellingenVoorWeergave(JSON.parse(tellingenRuw)) : null;
    data.themeMode = themeMode;
    
    return new Response(JSON.stringify(data), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { headers });
  }
}

/* Meldingenlog ophalen (afgelopen 7 dagen) */
async function logAPI(request, env) {
  const headers = {
    "content-type": "application/json; charset=UTF-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*"
  };
  if (!env.CONFIG) {
    return new Response(JSON.stringify({ error: "geen opslag ingesteld" }), { headers });
  }
  try {
    const logs = await env.CONFIG.get("melding_logs");
    const data = logs ? JSON.parse(logs) : [];
    
    // Sorteer van nieuw naar oud
    data.sort((a, b) => b.ts - a.ts);
    
    return new Response(JSON.stringify({
      count: data.count,
      logs: data,
      generated: new Date().toISOString()
    }), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e), logs: [] }), { headers });
  }
}

async function meldingJSON() {
  const headers = {
    "content-type": "application/json; charset=UTF-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*"
  };
  try {
    const r = await fetch(FEED, { headers: { "user-agent": "p2000-veluwsekant/1.0" } });
    const xml = await r.text();
    const items = parseEntries(xml);
    // filteren gebeurt in de pagina (instelbaar); hier alleen de recente meldingen
    return new Response(JSON.stringify({ meldingen: items.slice(0, 40), count: items.length }), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ meldingen: [], error: String(e) }), { headers });
  }
}

// Leest zowel RSS (<item>) als Atom (<entry>)
function parseEntries(xml) {
  const isAtom = /<entry[\s>]/i.test(xml);
  const name = isAtom ? "entry" : "item";
  const parts = xml.split(new RegExp("<" + name + "[\\s>]", "i")).slice(1);
  const out = [];
  for (const part of parts) {
    const block = part.split(new RegExp("</" + name + ">", "i"))[0];
    const title = clean(tag(block, "title"));
    if (!title) continue;
    const desc = clean(tag(block, "summary") || tag(block, "content") || tag(block, "description"));
    const pub = clean(tag(block, "published") || tag(block, "updated") || tag(block, "pubDate"));
    const id = clean(tag(block, "id") || tag(block, "guid") || linkHref(block)) || title;
    out.push({ title, desc, pub, id });
  }
  return out;
}

function tag(block, name) {
  const m = block.match(new RegExp("<" + name + "[^>]*>([\\s\\S]*?)<\\/" + name + ">", "i"));
  return m ? m[1] : "";
}

function linkHref(block) {
  const m = block.match(/<link[^>]*href="([^"]+)"/i);
  return m ? m[1] : "";
}

function clean(s) {
  return (s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&#x27;/gi, "'")
    .replace(/\s+/g, " ").trim();
}
