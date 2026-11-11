import assert from 'node:assert/strict';
import test from 'node:test';
import MVT from 'ol/format/MVT.js';
import Feature from 'ol/Feature.js';
import Point from 'ol/geom/Point.js';
import LineString from 'ol/geom/LineString.js';
import RenderFeature from 'ol/render/Feature.js';
import VectorTileSource from 'ol/source/VectorTile.js';
import VectorSource from 'ol/source/Vector.js';
import { fromLonLat, get as getProjection, transform } from 'ol/proj.js';
import { register } from 'ol/proj/proj4.js';
import proj4 from 'proj4';
import { tileFixture } from './fixtures.mjs';
import {
  createProjectedCoverage, decodeTile, getImageId, markerRotation, matchesOrganization, selectTiles
} from '../utils/mapillaryCoverage.js';

proj4.defs('EPSG:3008', '+proj=tmerc +lat_0=0 +lon_0=13.5 +k=1 +x_0=150000 +y_0=0 +ellps=GRS80 +units=m +no_defs');
proj4.defs('EPSG:3006', '+proj=utm +zone=33 +ellps=GRS80 +units=m +no_defs');
proj4.defs('EPSG:32633', '+proj=utm +zone=33 +datum=WGS84 +units=m +no_defs');
register(proj4);

test('real MVT tile pixels decode and reproject into registered coordinate systems', () => {
  const grid = new VectorTileSource({ maxZoom: 14 }).getTileGrid();
  const tile = grid.getTileCoordForCoordAndZ(fromLonLat([14.16, 56.03]), 14);
  const extent = grid.getTileCoordExtent(tile);
  const center = [(extent[0] + extent[2]) / 2, (extent[1] + extent[3]) / 2];
  for (const code of ['EPSG:3857', 'EPSG:3008', 'EPSG:3006', 'EPSG:4326', 'EPSG:32633']) {
    const [feature] = decodeTile(tileFixture(), extent, code, new MVT({ featureClass: Feature }));
    const coordinates = feature.getGeometry().getCoordinates();
    const expected = code === 'EPSG:3857' ? center : proj4('EPSG:3857', code, center);
    assert.ok(Math.abs(coordinates[0] - expected[0]) < 0.00001, code);
    assert.ok(Math.abs(coordinates[1] - expected[1]) < 0.00001, code);
    assert.equal(feature.get('id'), '9007199254740993');
    assert.equal(feature.get('layer'), 'image');
  }
});

test('decodes tile pixels in native coordinates before transforming geometry', () => {
  const calls = [];
  const geometry = {
    transform(from, to) { calls.push([from, to]); },
    getFlatCoordinates() { return [150000, 6200000]; }
  };
  const feature = { getGeometry: () => geometry };
  const extent = [0, 0, 10, 10];
  const format = {
    readFeatures(data, options) {
      assert.equal(data, 'tile');
      assert.equal(options.extent, extent);
      assert.equal(options.featureProjection, 'EPSG:3857');
      assert.equal(options.dataProjection, undefined);
      return [feature];
    }
  };
  assert.deepEqual(decodeTile('tile', extent, 'EPSG:3008', format), [feature]);
  assert.deepEqual(calls, [['EPSG:3857', 'EPSG:3008']]);
});

test('rejects non-finite transformed geometry', () => {
  const format = {
    readFeatures: () => [{ getGeometry: () => ({
      transform() {}, getFlatCoordinates: () => [Infinity, NaN]
    }) }]
  };
  assert.throws(() => decodeTile('tile', [0, 0, 1, 1], 'INVALID', format), /domain/);
});

function makeMap(code, resolution, centerLonLat = [14.16, 56.03], size = [800, 600]) {
  const projection = getProjection(code);
  let center = transform(centerLonLat, 'EPSG:4326', projection);
  const listeners = new Map();
  return {
    getSize: () => size,
    getView: () => ({ getProjection: () => projection, getCenter: () => center }),
    getCoordinateFromPixel: pixel => [
      center[0] + (pixel[0] - size[0] / 2) * resolution,
      center[1] - (pixel[1] - size[1] / 2) * resolution
    ],
    setCenter(lonLat) { center = transform(lonLat, 'EPSG:4326', projection); },
    on(name, listener) { listeners.set(name, listener); },
    un(name) { listeners.delete(name); },
    listeners
  };
}

test('tile selection uses native resolution for projected and geographic maps', () => {
  const grid = new VectorTileSource({ maxZoom: 14 }).getTileGrid();
  const expected = grid.getTileCoordForCoordAndZ(fromLonLat([14.16, 56.03]), 14).join('/');
  for (const code of ['EPSG:3857', 'EPSG:3008', 'EPSG:3006', 'EPSG:4326', 'EPSG:32633']) {
    const map = makeMap(code, code === 'EPSG:4326' ? 0.00001 : 1);
    const coordinates = selectTiles(map, grid, transform);
    assert.ok(coordinates.some(coordinate => coordinate.join('/') === expected), code);
    assert.ok(coordinates.every(coordinate => coordinate[0] === 14), code);
    assert.ok(coordinates.length <= 128);
  }
});

test('tile selection splits the dateline and keeps canonical tile indices', () => {
  const grid = new VectorTileSource({ maxZoom: 14 }).getTileGrid();
  const map = makeMap('EPSG:4326', 0.0001, [179.99, 0]);
  const coordinates = selectTiles(map, grid, transform);
  assert.ok(coordinates.some(coordinate => coordinate[1] === 0));
  assert.ok(coordinates.some(coordinate => coordinate[1] === (2 ** coordinate[0]) - 1));
  assert.ok(coordinates.every(([zoom, column, row]) => column >= 0 && row >= 0 && column < 2 ** zoom && row < 2 ** zoom));
});

test('tile selection coarsens before exceeding its request budget', () => {
  const grid = new VectorTileSource({ maxZoom: 14 }).getTileGrid();
  const coordinates = selectTiles(makeMap('EPSG:3008', 20, [14, 56], [3000, 2000]), grid, transform, 4);
  assert.ok(coordinates.length <= 4);
  assert.throws(() => selectTiles(makeMap('EPSG:4326', 1), grid, () => [NaN, Infinity]), /valid transformation/);
});

test('projected coverage caches tiles, deduplicates points and detaches listeners', async () => {
  const map = makeMap('EPSG:3008', 1);
  const source = new VectorSource();
  const nativeSource = new VectorTileSource({ maxZoom: 14, url: 'https://example.test/{z}/{x}/{y}' });
  const errors = [];
  let requests = 0;
  const controller = createProjectedCoverage({
    map, source, nativeSource, transform, format: new MVT({ featureClass: Feature }),
    reportError: message => errors.push(message),
    request: () => {
      requests += 1;
      return { promise: Promise.resolve(tileFixture()), abort() {} };
    }
  });
  await controller.start();
  assert.deepEqual(errors, []);
  assert.equal(source.getFeatures().length, 1);
  assert.equal(source.getFeatures()[0].get('id'), '9007199254740993');
  const firstRequests = requests;
  await controller.update();
  assert.equal(requests, firstRequests);
  assert.equal(map.listeners.size, 3);
  controller.stop();
  assert.equal(map.listeners.size, 0);
  assert.equal(source.getFeatures().length, 0);
  await controller.start();
  assert.equal(requests, firstRequests);
  assert.equal(source.getFeatures().length, 1);
  controller.dispose();
});

test('stopping coverage aborts requests and prevents late responses from rendering', async () => {
  const map = makeMap('EPSG:3008', 1);
  const source = new VectorSource();
  const nativeSource = new VectorTileSource({ maxZoom: 14, url: 'https://example.test/{z}/{x}/{y}' });
  const responses = [];
  let aborted = 0;
  const controller = createProjectedCoverage({
    map, source, nativeSource, transform, format: new MVT({ featureClass: Feature }),
    reportError: message => assert.fail(message),
    request: () => ({
      promise: new Promise(resolve => responses.push(resolve)),
      abort() { aborted += 1; }
    })
  });
  const loading = controller.start();
  assert.ok(responses.length > 0);
  assert.ok(responses.length <= 6);
  controller.stop();
  responses.forEach(resolve => resolve(tileFixture()));
  await loading;
  assert.equal(aborted, responses.length);
  assert.equal(source.getFeatures().length, 0);
});

test('authorization failure stops further tile requests and reports no token', async () => {
  const source = new VectorSource();
  const errors = [];
  const controller = createProjectedCoverage({
    map: makeMap('EPSG:3008', 1), source, transform,
    nativeSource: new VectorTileSource({ maxZoom: 14, url: 'https://example.test/{z}/{x}/{y}?access_token=secret' }),
    format: new MVT({ featureClass: Feature }),
    reportError: message => errors.push(message),
    request: () => ({ promise: Promise.reject({ status: 401 }), abort() {} })
  });
  await controller.start();
  await controller.update();
  assert.equal(errors.length, 1);
  assert.match(errors[0], /authorization/);
  assert.ok(!errors[0].includes('secret'));
  controller.dispose();
});

test('only image points are selectable for both OpenLayers feature representations', () => {
  const point = new Feature({ geometry: new Point([1, 2]), id: 'image', organization_id: '123', layer: 'image' });
  assert.equal(getImageId(point, 123), 'image');
  assert.equal(getImageId(point, undefined), 'image');
  assert.equal(getImageId(point, 456), undefined);
  assert.equal(matchesOrganization(point, null), true);
  point.set('layer', 'overview');
  assert.equal(getImageId(point), undefined);
  const line = new Feature({ geometry: new LineString([[1, 2], [3, 4]]), id: 'sequence', image_id: 'image' });
  assert.equal(getImageId(line), undefined);
  const render = new RenderFeature('Point', [1, 2], null, 2, { id: 'render-image', layer: 'image' });
  assert.equal(getImageId(render), 'render-image');
});

test('marker bearing follows local north rather than assuming projected grid north', () => {
  const position = { lng: 14.16, lat: 56.03 };
  assert.ok(Math.abs(markerRotation(position, 0, 'EPSG:3857', transform)) < 0.000001);
  assert.ok(Math.abs(markerRotation(position, 90, 'EPSG:3857', transform) - Math.PI / 2) < 0.000001);
  const north = markerRotation(position, 0, 'EPSG:3008', transform);
  assert.ok(Math.abs(north) > 0.001);
  assert.ok(Math.abs(north) < 0.1);
});

test('a valid world-wide geographic viewport stays within the tile budget', () => {
  const grid = new VectorTileSource({ maxZoom: 14 }).getTileGrid();
  const coordinates = selectTiles(makeMap('EPSG:4326', 0.4, [0, 0], [900, 400]), grid, transform);
  assert.ok(coordinates.length > 0);
  assert.ok(coordinates.length <= 128);
});

test('concurrency and memory limits remain bounded', async () => {
  const errors = [];
  let running = 0;
  let maximum = 0;
  const controller = createProjectedCoverage({
    map: makeMap('EPSG:3008', 10, [14, 56], [2000, 1500]), source: new VectorSource(), transform,
    nativeSource: new VectorTileSource({ maxZoom: 14, url: 'https://example.test/{z}/{x}/{y}' }),
    format: new MVT({ featureClass: Feature }), reportError: message => errors.push(message),
    limits: { concurrency: 2, maxTiles: 16, cacheTiles: 2 },
    request: () => {
      running += 1;
      maximum = Math.max(maximum, running);
      return { promise: Promise.resolve().then(() => { running -= 1; return new ArrayBuffer(0); }), abort() {} };
    }
  });
  await controller.start();
  assert.equal(maximum, 2);
  assert.deepEqual(errors, []);
  controller.dispose();
});

for (const [description, options, response, pattern] of [
  ['oversized tile', { cacheBytes: 4 }, new ArrayBuffer(8), /memory budget/],
  ['too many features', { maxFeatures: 0 }, tileFixture(), /feature budget/],
  ['malformed tile', {}, new Uint8Array([255, 255, 255]).buffer, /./]
]) {
  test(`reports ${description} without rendering partial results`, async () => {
    const errors = [];
    const source = new VectorSource();
    const controller = createProjectedCoverage({
      map: makeMap('EPSG:3008', 1), source, transform,
      nativeSource: new VectorTileSource({ maxZoom: 14, url: 'https://example.test/{z}/{x}/{y}' }),
      format: new MVT({ featureClass: Feature }), reportError: message => errors.push(message),
      limits: options,
      request: () => ({ promise: Promise.resolve(response), abort() {} })
    });
    await controller.start();
    assert.equal(source.getFeatures().length, 0);
    assert.equal(errors.length, 1);
    assert.match(errors[0], pattern);
    controller.dispose();
  });
}

test('a transient tile error is retried once and then succeeds', async () => {
  let attempts = 0;
  const errors = [];
  const controller = createProjectedCoverage({
    map: makeMap('EPSG:3008', 1, [14, 56], [10, 10]), source: new VectorSource(), transform,
    nativeSource: new VectorTileSource({ maxZoom: 14, url: 'https://example.test/{z}/{x}/{y}' }),
    format: new MVT({ featureClass: Feature }), reportError: message => errors.push(message),
    request: () => {
      attempts += 1;
      return { promise: attempts === 1 ? Promise.reject({ status: 503 }) : Promise.resolve(new ArrayBuffer(0)), abort() {} };
    }
  });
  await controller.start();
  assert.equal(attempts, 2);
  assert.deepEqual(errors, []);
  controller.dispose();
});

test('rate limiting pauses the whole queue before making further requests', async () => {
  const times = [];
  const errors = [];
  const controller = createProjectedCoverage({
    map: makeMap('EPSG:3008', 3, [14, 56], [2000, 1500]), source: new VectorSource(), transform,
    nativeSource: new VectorTileSource({ maxZoom: 14, url: 'https://example.test/{z}/{x}/{y}' }),
    format: new MVT({ featureClass: Feature }), reportError: message => errors.push(message),
    limits: { concurrency: 1, maxTiles: 8 },
    request: () => {
      times.push(Date.now());
      return { promise: times.length === 1 ? Promise.reject({ status: 429, retryAfter: '0.5' }) : Promise.resolve(new ArrayBuffer(0)), abort() {} };
    }
  });
  await controller.start();
  assert.ok(times.length > 2);
  assert.ok(times.slice(1).every(time => time - times[0] >= 450));
  assert.deepEqual(errors, []);
  controller.dispose();
});

test('long server cooldowns stop the queue instead of retrying early', async () => {
  const errors = [];
  const controller = createProjectedCoverage({
    map: makeMap('EPSG:3008', 1), source: new VectorSource(), transform,
    nativeSource: new VectorTileSource({ maxZoom: 14, url: 'https://example.test/{z}/{x}/{y}' }),
    format: new MVT({ featureClass: Feature }), reportError: message => errors.push(message),
    request: () => ({ promise: Promise.reject({ status: 429, retryAfter: '3600' }), abort() {} })
  });
  await controller.start();
  assert.equal(errors.length, 1);
  assert.match(errors[0], /quota/);
  controller.dispose();
});