import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import babel from '@babel/core';
import Feature from 'ol/Feature.js';
import MVT from 'ol/format/MVT.js';
import Point from 'ol/geom/Point.js';
import LineString from 'ol/geom/LineString.js';
import RenderFeature from 'ol/render/Feature.js';
import * as layer from 'ol/layer.js';
import * as source from 'ol/source.js';
import * as style from 'ol/style.js';
import { get as getProjection, transform } from 'ol/proj.js';
import { register } from 'ol/proj/proj4.js';
import proj4 from 'proj4';
import * as coverage from '../utils/mapillaryCoverage.js';

proj4.defs('EPSG:3008', '+proj=tmerc +lat_0=0 +lon_0=13.5 +k=1 +x_0=150000 +y_0=0 +ellps=GRS80 +units=m +no_defs');
register(proj4);
const code = babel.transformSync(fs.readFileSync(new URL('../origomapillary.js', import.meta.url), 'utf8'), {
  babelrc: false, configFile: false,
  presets: [['@babel/preset-env', { targets: { node: '22' }, modules: 'commonjs' }]]
}).code;

function host(projectionCode, options = {}) {
  const nodes = new Map();
  const controls = [];
  const layers = [];
  const listeners = new Map();
  const warnings = [];
  let nextId = 0;
  let projection = getProjection(projectionCode);
  const center = () => transform([14.16, 56.03], 'EPSG:4326', projection);
  const map = {
    getSize: () => [100, 100],
    getView: () => ({ getProjection: () => projection, getCenter: center }),
    getCoordinateFromPixel: pixel => [center()[0] + (pixel[0] - 50) * (projection.getUnits() === 'degrees' ? 0.00001 : 1), center()[1] - (pixel[1] - 50) * (projection.getUnits() === 'degrees' ? 0.00001 : 1)],
    on(name, handler) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(handler);
    },
    un(name, handler) { listeners.get(name)?.delete(handler); },
    fire(name, event) { [...(listeners.get(name) || [])].forEach(handler => handler(event)); },
    addLayer(value) { assert.ok(!layers.includes(value)); layers.push(value); },
    removeLayer(value) { const index = layers.indexOf(value); if (index >= 0) layers.splice(index, 1); },
    hits: [],
    forEachFeatureAtPixel(pixel, callback, settings) {
      for (const [feature, owningLayer] of this.hits) {
        if (settings.layerFilter(owningLayer) && callback(feature, owningLayer)) return true;
      }
      return undefined;
    },
    setProjection(value) { projection = getProjection(value); this.fire('change:view'); }
  };
  function node(id, classes = '') {
    const values = new Set(classes.split(' '));
    const result = {
      id, style: {},
      classList: { add: value => values.add(value), remove: value => values.delete(value), contains: value => values.has(value) },
      appendChild(child) { nodes.set(child.id, child); },
      setAttribute(name, value) { if (name === 'id') { nodes.delete(this.id); this.id = value; nodes.set(value, this); } },
      addEventListener() {}, remove() { nodes.delete(this.id); }
    };
    nodes.set(id, result);
    return result;
  }
  function element(settings) {
    const id = `control-${nextId++}`;
    const component = { settings, getId: () => id, render: () => node(id, settings.cls), setIcon() {} };
    controls.push(component);
    return component;
  }
  let imageViewer;
  class Viewer {
    constructor() { imageViewer = this; this.events = new Map(); this.moves = []; this.isNavigable = true; }
    on(name, handler) { this.events.set(name, handler); }
    off(name) { this.events.delete(name); }
    getImage() {
      return Promise.resolve(this.image || {
        id: 'image',
        originalLngLat: { lng: 14.16, lat: 56.03 },
        lngLat: { lng: 14.1602, lat: 56.0302 }
      });
    }
    getBearing() { return Promise.resolve(0); }
    moveTo(id) { this.moves.push(id); return Promise.resolve(); }
    resize() {}
    remove() { this.removed = true; }
  }
  const Origo = {
    ol: { Feature, format: { MVT }, geom: { Point }, layer, source, style },
    ui: {
      Element: element, Button: element, dom: { html: value => value },
      Component(settings) {
        const events = new Map();
        const component = Object.assign({
          on(name, handler) { events.set(name, handler); },
          dispatch(name) { events.get(name)?.(); },
          addComponents() {}
        }, settings);
        component.onInit();
        return component;
      }
    }
  };
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports,
    console: { warn: message => warnings.push(message) },
    document: { getElementById: id => nodes.get(id) },
    require(name) {
      if (name === 'Origo') return Origo;
      if (name === 'mapillary-js') return { Viewer };
      if (name === './utils/mapillaryCoverage') return coverage;
      if (name === './utils/dragElement') return () => {};
      throw new Error(`Unexpected dependency ${name}`);
    }
  });
  node('main'); node('tools');
  const plugin = new module.exports.default(Object.assign({ clientToken: 'test-token', startActive: true }, options));
  const viewer = {
    getMain: () => ({ getId: () => 'main', getMapTools: () => ({ getId: () => 'tools' }) }),
    getMap: () => map,
    getMapUtils: () => ({ transformCoordinate: transform }),
    addStyle() {}
  };
  return { plugin, map, layers, nodes, controls, listeners, warnings, viewer, get imageViewer() { return imageViewer; } };
}

class EmptyXHR {
  open() {}
  send() { queueMicrotask(() => { this.status = 204; this.response = null; this.onload(); }); }
  abort() { this.onabort(); }
  getResponseHeader() { return null; }
}

for (const code of ['EPSG:3857', 'EPSG:3008', 'EPSG:4326']) {
  test(`whole plugin lifecycle and point-only clicks in ${code} without proj/tilegrid exports`, async () => {
    const previous = globalThis.XMLHttpRequest;
    globalThis.XMLHttpRequest = EmptyXHR;
    try {
      const state = host(code);
      await state.plugin.onAdd({ target: state.viewer });
      await new Promise(setImmediate);
      assert.equal(state.layers.length, 2);
      const coverageLayer = state.layers[0];
      assert.equal(coverageLayer instanceof layer.VectorTile, code === 'EPSG:3857');
      if (code === 'EPSG:3857') assert.equal(coverageLayer.getSource().getTileGrid().getMaxZoom(), 14);
      const point = new Feature({ geometry: new Point([1, 2]), id: 'image', layer: 'image' });
      const line = new Feature({ geometry: new LineString([[1, 2], [3, 4]]), id: 'sequence', image_id: 'image' });
      state.map.hits = [[point, state.layers[1]], [line, coverageLayer], [point, coverageLayer], [point, coverageLayer]];
      state.map.fire('click', { pixel: [50, 50] });
      assert.deepEqual(state.imageViewer.moves, ['image']);
      state.imageViewer.events.get('position')();
      await new Promise(setImmediate);
      const marker = state.layers[1].getSource().getFeatures()[0];
      assert.deepEqual(Array.from(marker.getGeometry().getCoordinates()), point.getGeometry().getCoordinates());
      const arrow = marker.getStyle()[0].getImage();
      assert.deepEqual(Array.from(arrow.getAnchor()), [12, 21.5]);
      assert.deepEqual(Array.from(arrow.getOrigin()), [0, 0]);
      const button = state.controls.find(control => control.settings.tooltipText === 'Mapillary');
      button.settings.click();
      assert.equal(state.layers.length, 0);
      state.map.fire('click', { pixel: [50, 50] });
      assert.equal(state.imageViewer.moves.length, 1);
      button.settings.click();
      assert.equal(state.layers.length, 2);
      state.plugin.dispatch('clear');
      assert.equal(state.layers.length, 0);
      assert.equal(state.imageViewer.removed, true);
      assert.ok([...state.listeners.values()].every(handlers => handlers.size === 0));
      assert.deepEqual(state.warnings, []);
    } finally { globalThis.XMLHttpRequest = previous; }
  });
}

test('default activation is unchanged and changing projection rebuilds coverage', async () => {
  const previous = globalThis.XMLHttpRequest;
  globalThis.XMLHttpRequest = EmptyXHR;
  try {
    const state = host('EPSG:3857', { startActive: false });
    await state.plugin.onAdd({ target: state.viewer });
    assert.equal(state.layers.length, 0);
    state.map.setProjection('EPSG:3008');
    state.controls.find(control => control.settings.tooltipText === 'Mapillary').settings.click();
    await new Promise(setImmediate);
    assert.ok(state.layers[0] instanceof layer.Vector);
    state.plugin.dispatch('clear');
    assert.deepEqual(state.warnings, []);
  } finally { globalThis.XMLHttpRequest = previous; }
});

for (const [endpoint, expected] of [
  ['mly1_public', [14.16, 56.03]],
  ['mly1_computed_public', [14.1602, 56.0302]]
]) {
  test(`marker uses the image position matching ${endpoint}, not the moving camera`, async () => {
    const state = host('EPSG:3857', { mapillaryUrl: `https://example.test/${endpoint}/2/{z}/{x}/{y}` });
    await state.plugin.onAdd({ target: state.viewer });
    state.imageViewer.events.get('image')();
    await new Promise(setImmediate);
    const marker = state.layers[1].getSource().getFeatures()[0];
    assert.deepEqual(marker.getGeometry().getCoordinates(), transform(expected, 'EPSG:4326', 'EPSG:3857'));
    state.plugin.dispatch('clear');
  });
}

test('a native render feature anchors the selected image until navigation changes the image', async () => {
  const state = host('EPSG:3857');
  await state.plugin.onAdd({ target: state.viewer });
  const feature = new RenderFeature('Point', [1576283.8, 7564389.86], null, 2, { id: 'image', layer: 'image' });
  state.map.hits = [[feature, state.layers[0]]];
  state.map.fire('click', { pixel: [50, 50] });
  state.imageViewer.events.get('image')();
  await new Promise(setImmediate);
  let marker = state.layers[1].getSource().getFeatures()[0];
  assert.deepEqual(Array.from(marker.getGeometry().getCoordinates()), [1576283.8, 7564389.86]);
  state.imageViewer.image = {
    id: 'next-image',
    originalLngLat: { lng: 14.17, lat: 56.04 },
    lngLat: { lng: 14.1702, lat: 56.0402 }
  };
  state.imageViewer.events.get('image')();
  await new Promise(setImmediate);
  marker = state.layers[1].getSource().getFeatures()[0];
  assert.deepEqual(marker.getGeometry().getCoordinates(), transform([14.17, 56.04], 'EPSG:4326', 'EPSG:3857'));
  state.plugin.dispatch('clear');
});