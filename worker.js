/**
 * P2000 Kazernescherm Worker
 * Voeding voor P2000-scherm op Veluwsekant
 * - Ontvangt meldingen van Pi (serieel)
 * - Cacht geen index.html (dus logo's updaten direct)
 * - Cacht wel KV data en API's
 */

const KV_NAMESPACE = 'p2000-config'; // Jouw KV namespace ID

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // ===== HTML serveren (GEEN CACHE!) =====
    if (path === '/' || path === '/index.html') {
      const htmlResponse = await env.ASSETS.fetch(
        new Request('https://example.com/index.html', request)
      );
      
      // KRITIEK: Geen caching voor index.html
      return new Response(htmlResponse.body, {
        status: htmlResponse.status,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'public, max-age=0, no-cache, must-revalidate',
          'Content-Security-Policy': "default-src 'self' https: data: 'unsafe-inline'",
          ...Object.fromEntries(htmlResponse.headers)
        }
      });
    }

    // ===== API endpoints =====
    
    // Melding ontvangen van Pi
    if (path === '/api/pi' && request.method === 'POST') {
      try {
        const body = await request.json();
        const sleutel = body.sleutel;
        
        // Validatie
        if (sleutel !== 'veluwsekant2026') {
          return new Response(JSON.stringify({ ok: false, error: 'Invalid key' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        // Opslaan in KV
        const text = body.text || '';
        const timestamp = new Date().toISOString();
        
        await env.p2000_config.put(`laatste_pi_melding`, JSON.stringify({
          text,
          timestamp,
          test: body.test || false
        }));

        return new Response(JSON.stringify({ ok: true }), {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // Melding ophalen
    if (path === '/api/melding') {
      try {
        const melding = await env.p2000_config.get('laatste_pi_melding');
        const data = melding ? JSON.parse(melding) : null;
        
        return new Response(JSON.stringify(data || {}), {
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=5' // Kort cachen
          }
        });
      } catch (e) {
        return new Response(JSON.stringify({}), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // ===== Config ophalen/opslaan (taken, capcodes, themeMode, etc) =====
    if (path === '/api/taken') {
      // GET: Config laden
      if (request.method === 'GET') {
        try {
          const configData = await env.p2000_config.get('p2000_config');
          const config = configData ? JSON.parse(configData) : {};
          
          return new Response(JSON.stringify({
            tasks: config.tasks || [],
            capcodes: config.capcodes || [],
            posts: config.posts || {},
            units: config.units || {},
            holdMin: config.holdMin || 5,
            themeMode: config.themeMode || 'auto'
          }), {
            headers: {
              'Content-Type': 'application/json',
              'Cache-Control': 'public, max-age=5'
            }
          });
        } catch (e) {
          return new Response(JSON.stringify({ 
            tasks: [], capcodes: [], posts: {}, units: {}, holdMin: 5, themeMode: 'auto' 
          }), {
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }
      
      // PUT: Config opslaan
      if (request.method === 'PUT') {
        try {
          const body = await request.json();
          
          // Opslaan in KV
          await env.p2000_config.put('p2000_config', JSON.stringify({
            tasks: body.tasks || [],
            capcodes: body.capcodes || [],
            posts: body.posts || {},
            units: body.units || {},
            holdMin: body.holdMin || 5,
            themeMode: body.themeMode || 'auto',
            updatedAt: new Date().toISOString()
          }));
          
          return new Response(JSON.stringify({ ok: true }), {
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' }
          });
        } catch (e) {
          return new Response(JSON.stringify({ ok: false, error: e.message }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }
    }

    // ===== Assets serveren (CSS, JS, PNG) =====
    if (path.match(/\.(css|js|png|jpg|gif|woff|woff2)$/i)) {
      const assetResponse = await env.ASSETS.fetch(request);
      return new Response(assetResponse.body, {
        status: assetResponse.status,
        headers: {
          'Cache-Control': 'public, max-age=86400', // 24 uur
          ...Object.fromEntries(assetResponse.headers)
        }
      });
    }

    // ===== 404 =====
    return new Response('Not Found', { status: 404 });
  }
};
