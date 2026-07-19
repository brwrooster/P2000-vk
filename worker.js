// P2000 Post Veluwsekant - Worker: feed-endpoint (RSS + Atom) + statische pagina
const FEED = "https://112-nu.nl/brandweer/rss";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/melding") return meldingJSON();
    return env.ASSETS.fetch(request);
  }
};

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
    // nieuwste brandweermelding: titel bevat p1 / p2
    // testmodus: nieuwste brandweermelding (alle capcodes, P1/P2)
    const melding = items.find(it => /\bP\s*[12]\b/i.test(it.desc || it.title)) || null;
    return new Response(JSON.stringify({ melding, count: items.length }), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ melding: null, error: String(e) }), { headers });
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
