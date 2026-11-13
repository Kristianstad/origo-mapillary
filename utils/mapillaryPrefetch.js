const metersPerDegree = 111320;

const defaults = {
  // Matches the 20 m spatial threshold used by mapillary-js, with a margin for computed positions.
  imageRadius: 30,
  maxAreaMeters: 2000,
  maxAreaCells: 64,
  maxAreaImages: 1000,
  maxAreaSequences: 20,
  sampleSpacing: 35,
  batchSize: 200,
  concurrency: 4,
  cacheCells: 1024,
  cacheImages: 10000,
  cacheSequences: 500
};

function remember(cache, key, limit, load) {
  if (cache.has(key)) {
    const cached = cache.get(key);
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  const promise = new Promise(resolve => resolve(load()));
  cache.set(key, promise);
  promise.then((value) => {
    if ((value === null || value === undefined) && cache.get(key) === promise) cache.delete(key);
  }, () => {
    if (cache.get(key) === promise) cache.delete(key);
  });
  while (cache.size > limit) cache.delete(cache.keys().next().value);
  return promise;
}

function rememberEach(cache, ids, limit, loadBatch) {
  const missing = ids.filter(id => !cache.has(id));
  let batch;
  const loadMissing = () => {
    if (!batch) {
      batch = Promise.resolve(loadBatch(missing))
        .then(items => new Map(items.map(item => [item.node_id, item])));
    }
    return batch;
  };
  return Promise.all(ids.map(id => remember(cache, id, limit, () => loadMissing().then(found => found.get(id) || null))))
    .then(items => items.filter(Boolean));
}

function runLimited(items, limit, worker, cancelled) {
  let index = 0;
  const next = () => {
    if (index >= items.length || cancelled()) return Promise.resolve();
    const item = items[index];
    index += 1;
    return Promise.resolve()
      .then(() => worker(item))
      .catch(() => undefined)
      .then(next);
  };
  return Promise.all(Array.from({ length: Math.min(limit, items.length) }, next));
}

function distance(a, b) {
  const x = (a.lng - b.lng) * metersPerDegree * Math.cos((b.lat * Math.PI) / 180);
  const y = (a.lat - b.lat) * metersPerDegree;
  return Math.hypot(x, y);
}

function aroundPoint(lngLat, meters) {
  const lat = meters / metersPerDegree;
  const lng = meters / (metersPerDegree * Math.max(0.000001, Math.cos((lngLat.lat * Math.PI) / 180)));
  return [
    { lng: lngLat.lng - lng, lat: lngLat.lat - lat },
    { lng: lngLat.lng + lng, lat: lngLat.lat + lat }
  ];
}

function imagePosition(image) {
  return image.computed_geometry || image.geometry;
}

function inside(lngLat, sw, ne) {
  return !!lngLat && lngLat.lng >= sw.lng && lngLat.lng <= ne.lng && lngLat.lat >= sw.lat && lngLat.lat <= ne.lat;
}

function validLngLat(lngLat) {
  return !!lngLat && Number.isFinite(lngLat.lng) && Number.isFinite(lngLat.lat);
}

/**
 * Extends a mapillary-js data provider with memoized graph requests and methods
 * that warm the cache with the data needed to compute navigation arrows.
 */
export default function withPrefetch(BaseProvider, limits = {}) {
  const budget = Object.assign({}, defaults, limits);

  return class PrefetchingDataProvider extends BaseProvider {
    constructor(...args) {
      super(...args);
      this.prefetchCells = new Map();
      this.prefetchImages = new Map();
      this.prefetchSpatialImages = new Map();
      this.prefetchSequences = new Map();
      this.prefetchGeneration = 0;
    }

    getCoreImages(cellId) {
      return remember(this.prefetchCells, cellId, budget.cacheCells, () => super.getCoreImages(cellId));
    }

    getImages(imageIds) {
      return rememberEach(this.prefetchImages, imageIds, budget.cacheImages, ids => super.getImages(ids));
    }

    getSpatialImages(imageIds) {
      return rememberEach(this.prefetchSpatialImages, imageIds, budget.cacheImages, ids => super.getSpatialImages(ids));
    }

    getSequence(sequenceId) {
      return remember(this.prefetchSequences, sequenceId, budget.cacheSequences, () => super.getSequence(sequenceId));
    }

    cancelPrefetch() {
      this.prefetchGeneration += 1;
    }

    prefetchSpatialArea(cellIds, sw, ne, center, maxImages, cancelled = () => false) {
      return runLimited(cellIds, budget.concurrency, cellId => this.getCoreImages(cellId), cancelled)
        .then(() => Promise.all(cellIds.map(cellId => (this.prefetchCells.get(cellId) || Promise.resolve(null))
          .catch(() => null))))
        .then((cells) => {
          const images = new Map();
          cells.forEach((cell) => {
            if (!cell) return;
            cell.images.forEach((image) => {
              if (inside(imagePosition(image), sw, ne)) images.set(image.id, image);
            });
          });
          return Array.from(images.values())
            .sort((a, b) => distance(imagePosition(a), center) - distance(imagePosition(b), center))
            .slice(0, maxImages);
        })
        .then((images) => {
          if (cancelled()) return images;
          const ids = images.map(image => image.id).filter(id => !this.prefetchSpatialImages.has(id));
          const batches = [];
          for (let index = 0; index < ids.length; index += budget.batchSize) {
            batches.push(ids.slice(index, index + budget.batchSize));
          }
          return runLimited(batches, budget.concurrency, batch => this.getSpatialImages(batch), cancelled)
            .then(() => images);
        });
    }

    prefetchImage({ id, lngLat, sequenceId } = {}) {
      const tasks = [];
      if (id !== undefined && id !== null) tasks.push(this.getImages([String(id)]));
      if (sequenceId !== undefined && sequenceId !== null) tasks.push(this.getSequence(String(sequenceId)));
      if (validLngLat(lngLat)) {
        const [sw, ne] = aroundPoint(lngLat, budget.imageRadius);
        tasks.push(this.prefetchSpatialArea(this.geometry.bboxToCellIds(sw, ne), sw, ne, lngLat, Infinity));
      }
      return Promise.all(tasks.map(task => Promise.resolve(task).catch(() => undefined))).then(() => undefined);
    }

    prefetchArea({ sw, ne, center } = {}) {
      this.prefetchGeneration += 1;
      const generation = this.prefetchGeneration;
      const cancelled = () => generation !== this.prefetchGeneration;
      if (![sw, ne, center].every(validLngLat) || ne.lng <= sw.lng || ne.lat <= sw.lat
        || distance({ lng: ne.lng, lat: sw.lat }, sw) > budget.maxAreaMeters
        || distance({ lng: sw.lng, lat: ne.lat }, sw) > budget.maxAreaMeters) return Promise.resolve();

      const margin = aroundPoint(center, budget.imageRadius);
      const marginLng = center.lng - margin[0].lng;
      const marginLat = center.lat - margin[0].lat;
      const areaSw = { lng: sw.lng - marginLng, lat: sw.lat - marginLat };
      const areaNe = { lng: ne.lng + marginLng, lat: ne.lat + marginLat };
      const stepLat = budget.sampleSpacing / metersPerDegree;
      const stepLng = stepLat / Math.max(0.000001, Math.cos((center.lat * Math.PI) / 180));
      const samples = [];
      for (let lat = areaSw.lat; lat < areaNe.lat + stepLat; lat += stepLat) {
        for (let lng = areaSw.lng; lng < areaNe.lng + stepLng; lng += stepLng) {
          samples.push({ lng: Math.min(lng, areaNe.lng), lat: Math.min(lat, areaNe.lat) });
        }
      }
      samples.sort((a, b) => distance(a, center) - distance(b, center));
      const cellIds = [];
      for (let index = 0; index < samples.length && cellIds.length < budget.maxAreaCells; index += 1) {
        const cellId = this.geometry.lngLatToCellId(samples[index]);
        if (!cellIds.includes(cellId)) cellIds.push(cellId);
      }

      return this.prefetchSpatialArea(cellIds, areaSw, areaNe, center, budget.maxAreaImages, cancelled)
        .then((images) => {
          if (cancelled()) return undefined;
          const sequenceIds = Array.from(new Set(images
            .map(image => image.sequence && image.sequence.id)
            .filter(sequenceId => sequenceId !== undefined && sequenceId !== null)))
            .slice(0, budget.maxAreaSequences);
          return runLimited(sequenceIds, budget.concurrency, sequenceId => this.getSequence(sequenceId), cancelled);
        })
        .then(() => undefined);
    }
  };
}
