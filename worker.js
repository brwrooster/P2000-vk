// P2000 Post Veluwsekant - Worker: feed-endpoint + statische pagina
const FEED = "https://alarmeringen.nl/feeds/region/flevoland.rss";

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
    const items = parseItems(xml);
    // nieuwste brandweermelding: titel begint met p1 / p2
    const melding = items.find(it => /^\s*p\s*[12]\b/i.test(it.title)) || null;
    return new Response(JSON.stringify({ melding }), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ melding: null, error: String(e) }), { headers });
  }
}

function parseItems(xml) {
  const items = [];
  const parts = xml.split(/<item[ >]/i).slice(1);
  for (const part of parts) {
    const block = part.split(/<\/item>/i)[0];
    const title = clean(tag(block, "title"));
    if (!title) continue;
    items.push({
      title,
      desc: clean(tag(block, "description")),
      pub: clean(tag(block, "pubDate")),
      id: clean(tag(block, "guid") || tag(block, "link")) || title
    });
  }
  return items;
}

function tag(block, name) {
  const m = block.match(new RegExp("<" + name + "[^>]*>([\\s\\S]*?)<\\/" + name + ">", "i"));
  return m ? m[1] : "";
}

function clean(s) {
  return (s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&#x27;/gi, "'")
    .replace(/\s+/g, " ").trim();
}
