import assert from 'node:assert/strict';
import test from 'node:test';
import withPrefetch from '../utils/mapillaryPrefetch.js';

const cellSize = 0.001;
const cellOf = ({ lng, lat }) => `${Math.floor(lng / cellSize)}:${Math.floor(lat / cellSize)}`;

class FakeProvider {
  constructor() {
    this.calls = [];
    this.failures = new Set();
    this.geometry = {
      lngLatToCellId: cellOf,
      bboxToCellIds: (sw, ne) => Array.from(new Set([sw, ne, { lng: sw.lng, lat: ne.lat }, { lng: ne.lng, lat: sw.lat }].map(cellOf)))
    };
  }

  request(name, value) {
    this.calls.push(`${name}:${value}`);
    if (this.failures.has(`${name}:${value}`)) return Promise.reject(new Error('failed'));
    return null;
  }

  getCoreImages(cellId) {
    return this.request('core', cellId) || Promise.resolve({
      cell_id: cellId,
      images: [{
        id: `image-${cellId}`,
        geometry: { lng: (Number(cellId.split(':')[0]) + 0.5) * cellSize, lat: (Number(cellId.split(':')[1]) + 0.5) * cellSize },
        computed_geometry: null,
        sequence: { id: `sequence-${cellId}` }
      }]
    });
  }

  getImages(ids) { return this.request('images', ids.join(',')) || Promise.resolve(ids.map(id => ({ node_id: id, node: { id } }))); }

  getSpatialImages(ids) {
    return this.request('spatial', ids.join(','))
      || Promise.resolve(ids.filter(id => id !== 'gone').map(id => ({ node_id: id, node: { id } })));
  }

  getSequence(id) { return this.request('sequence', id) || Promise.resolve({ id, image_ids: [] }); }
}

const Provider = withPrefetch(FakeProvider);

test('a hovered image prefetches everything the viewer needs for its arrows', async () => {
  const provider = new Provider();
  const lngLat = { lng: 14.1605, lat: 56.0305 };
  await provider.prefetchImage({ id: 'clicked', sequenceId: 'sequence', lngLat });
  const cells = provider.geometry.bboxToCellIds({ lng: 14.1601, lat: 56.0301 }, { lng: 14.1609, lat: 56.0309 });
  const prefetched = provider.calls.length;
  assert.ok(provider.calls.includes('images:clicked'));
  assert.ok(provider.calls.includes('sequence:sequence'));
  assert.ok(provider.calls.some(call => call.startsWith('spatial:')));

  await provider.getImages(['clicked']);
  await Promise.all(cells.map(cell => provider.getCoreImages(cell)));
  await provider.getSpatialImages([`image-${cellOf(lngLat)}`]);
  await provider.getSequence('sequence');
  assert.equal(provider.calls.length, prefetched);
});

test('failed and missing results are retried instead of cached', async () => {
  const provider = new Provider();
  provider.failures.add('sequence:broken');
  await assert.rejects(provider.getSequence('broken'));
  provider.failures.clear();
  await provider.getSequence('broken');
  assert.deepEqual(provider.calls, ['sequence:broken', 'sequence:broken']);

  provider.calls.length = 0;
  assert.deepEqual(await provider.getSpatialImages(['gone']), []);
  assert.deepEqual(await provider.getSpatialImages(['gone']), []);
  assert.deepEqual(provider.calls, ['spatial:gone', 'spatial:gone']);
});

test('area prefetch is bounded, skips large extents and stops when cancelled', async () => {
  const center = { lng: 14.1605, lat: 56.0305 };
  const large = new Provider();
  await large.prefetchArea({ sw: { lng: 14, lat: 56 }, ne: { lng: 14.2, lat: 56.1 }, center });
  assert.deepEqual(large.calls, []);

  const provider = new Provider();
  const sw = { lng: 14.158, lat: 56.029 };
  const ne = { lng: 14.163, lat: 56.032 };
  await provider.prefetchArea({ sw, ne, center });
  const coreCalls = provider.calls.filter(call => call.startsWith('core:'));
  assert.ok(coreCalls.length > 1 && coreCalls.length <= 64);
  assert.ok(provider.calls.some(call => call.startsWith('spatial:')));
  assert.ok(provider.calls.some(call => call.startsWith('sequence:')));

  const cancelled = new Provider();
  const pending = cancelled.prefetchArea({ sw, ne, center });
  cancelled.cancelPrefetch();
  await pending;
  assert.ok(cancelled.calls.filter(call => call.startsWith('core:')).length <= 4);
  assert.ok(!cancelled.calls.some(call => !call.startsWith('core:')));
});
