// P2000 Post Veluwsekant - Worker: feed-endpoint (RSS + Atom) + statische pagina
const FEED = "https://112-nu.nl/brandweer/rss";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/melding") return meldingJSON();
    if (url.pathname === "/api/taken") return takenAPI(request, env);
    if (url.pathname === "/api/pi") return piAPI(request, env);
    return env.ASSETS.fetch(request);
  }
};

/* Meldingen van de eigen ontvanger (Raspberry Pi via seriële poort).
   Pi doet POST met { text, sleutel }, scherm doet GET. */
const PI_SLEUTEL = "veluwsekant2026";   // eenvoudige beveiliging

async function piAPI(request, env) {
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
      await env.CONFIG.put("laatste_pi_melding", JSON.stringify(melding));
      return new Response(JSON.stringify({ ok: true, id: melding.id }), { headers });
    }
    const opgeslagen = await env.CONFIG.get("laatste_pi_melding");
    return new Response(opgeslagen || JSON.stringify({ text: null }), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { headers });
  }
}

/* Taken centraal bewaren (KV), zodat elk scherm dezelfde lijst toont */
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
      const body = await request.text();
      JSON.parse(body); // validatie
      await env.CONFIG.put("taken", body);
      return new Response(JSON.stringify({ ok: true }), { headers });
    }
    const opgeslagen = await env.CONFIG.get("taken");
    return new Response(opgeslagen || JSON.stringify({ tasks: null }), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { headers });
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
