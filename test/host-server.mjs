import http from 'node:http';
import fs from 'node:fs/promises';
import VectorTileSource from 'ol/source/VectorTile.js';
import { transform } from 'ol/proj.js';
import { register } from 'ol/proj/proj4.js';
import proj4 from 'proj4';
import { tileFixture } from './fixtures.mjs';

const argument = name => process.argv[process.argv.indexOf(name) + 1];
const exportPath = process.argv.includes('--html') ? argument('--html') : process.env.ORIGO_TEST_HTML;
if (!exportPath) throw new Error('Provide --html <local Origo HTML export> or ORIGO_TEST_HTML.');
const exported = await fs.readFile(exportPath, 'utf8');
const scripts = [...exported.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
const library = scripts.find(match => /\.ol\.Feature\s*=/.test(match[1]))?.[1];
if (!library || /MLY\|/.test(library)) throw new Error('No isolated, token-free Origo library script found.');
const css = [...exported.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map(match => match[1]).join('\n');
const root = new URL('../', import.meta.url);
const grid = new VectorTileSource({ maxZoom: 14 }).getTileGrid();
const lonLat = [14.16, 56.03];
proj4.defs('EPSG:3008', '+proj=tmerc +lat_0=0 +lon_0=13.5 +k=1 +x_0=150000 +y_0=0 +ellps=GRS80 +units=m +no_defs');
register(proj4);
const nativePoint = transform(lonLat, 'EPSG:4326', 'EPSG:3857');
const html = await fs.readFile(new URL('projection-host.html', import.meta.url));
const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    response.setHeader('Cache-Control', 'no-store');
    if (url.pathname === '/' || url.pathname === '/test/projection-host.html') {
      response.setHeader('Content-Type', 'text/html'); response.end(html);
    } else if (url.pathname === '/host-origo.js') {
      response.setHeader('Content-Type', 'application/javascript'); response.end(library);
    } else if (url.pathname === '/host-style.css') {
      response.setHeader('Content-Type', 'text/css'); response.end(css);
    } else if (url.pathname === '/utils/mapillaryCoverage.js') {
      response.setHeader('Content-Type', 'application/javascript');
      response.end(await fs.readFile(new URL('utils/mapillaryCoverage.js', root)));
    } else if (url.pathname === '/host-config.json') {
      const code = ['EPSG:3857', 'EPSG:3008', 'EPSG:4326'].includes(url.searchParams.get('crs')) ? url.searchParams.get('crs') : 'EPSG:3008';
      const resolution = code === 'EPSG:4326' ? 0.00001 : 1;
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({
        controls: [], groups: [], layers: [], source: {}, styles: {},
        projectionCode: code,
        center: transform(lonLat, 'EPSG:4326', code),
        zoom: 3, resolutions: [8, 4, 2, 1, 0.5].map(value => value * resolution),
        extent: code === 'EPSG:3008' ? [0, 6000000, 500000, 6500000] : code === 'EPSG:4326' ? [-180, -85, 180, 85] : grid.getExtent(),
        projectionExtent: code === 'EPSG:3008' ? [0, 6000000, 500000, 6500000] : code === 'EPSG:4326' ? [-180, -85, 180, 85] : grid.getExtent(),
        proj4Defs: [{ code: 'EPSG:3008', projection: proj4.defs('EPSG:3008') }]
      }));
    } else if (/^\/fixture-tile\/\d+\/\d+\/\d+$/.test(url.pathname)) {
      const coordinate = url.pathname.split('/').slice(2).map(Number);
      const extent = grid.getTileCoordExtent(coordinate);
      response.setHeader('Content-Type', 'application/vnd.mapbox-vector-tile');
      if (nativePoint[0] < extent[0] || nativePoint[0] >= extent[2] || nativePoint[1] < extent[1] || nativePoint[1] >= extent[3]) {
        response.statusCode = 204; response.end();
      } else {
        const point = [
          Math.round((nativePoint[0] - extent[0]) / (extent[2] - extent[0]) * 4096),
          Math.round((extent[3] - nativePoint[1]) / (extent[3] - extent[1]) * 4096)
        ];
        response.end(Buffer.from(tileFixture(point)));
      }
    } else { response.statusCode = 404; response.end(); }
  } catch { response.statusCode = 500; response.end('Fixture request failed.'); }
});
const port = process.argv.includes('--port') ? Number(argument('--port')) : 8341;
server.listen(port, '127.0.0.1', () => console.log(`Projection host fixture: http://127.0.0.1:${port}/test/projection-host.html`));