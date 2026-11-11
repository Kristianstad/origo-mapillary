export const nativeProjection = 'EPSG:3857';

function finiteCoordinate(coordinate) {
  if (!coordinate || !Number.isFinite(coordinate[0]) || !Number.isFinite(coordinate[1])) {
    throw new Error('Mapillary: no valid transformation for this map extent.');
  }
  return coordinate;
}

export function matchesOrganization(feature, organizationId) {
  return organizationId === undefined || organizationId === null
    || String(feature.get('organization_id')) === String(organizationId);
}

export function getImageId(feature, organizationId) {
  const geometry = feature.getGeometry ? feature.getGeometry() : feature;
  if (!geometry || geometry.getType() !== 'Point' || feature.get('layer') === 'overview'
    || !matchesOrganization(feature, organizationId)) return undefined;
  return feature.get('id') === undefined ? feature.getId() : feature.get('id');
}

export function markerRotation(position, bearing, projection, transform) {
  const radians = (bearing * Math.PI) / 180;
  const origin = transform([position.lng, position.lat], 'EPSG:4326', projection);
  const ahead = transform([
    position.lng + ((Math.sin(radians) * 0.00001) / Math.max(0.000001, Math.cos((position.lat * Math.PI) / 180))),
    position.lat + (Math.cos(radians) * 0.00001)
  ], 'EPSG:4326', projection);
  finiteCoordinate(origin);
  finiteCoordinate(ahead);
  return Math.atan2(ahead[0] - origin[0], ahead[1] - origin[1]);
}

const defaults = {
  maxTiles: 128,
  concurrency: 6,
  cacheTiles: 128,
  cacheBytes: 16 * 1024 * 1024,
  maxFeatures: 100000
};

export function selectTiles(map, grid, transform, maxTiles = defaults.maxTiles) {
  const size = map.getSize();
  if (!size || !size[0] || !size[1]) return [];
  const projection = map.getView().getProjection();
  const extent = grid.getExtent();
  const width = extent[2] - extent[0];
  const rawPoints = [];
  const project = (pixel) => {
    const coordinate = finiteCoordinate(map.getCoordinateFromPixel(pixel));
    const projected = finiteCoordinate(transform(coordinate, projection, nativeProjection));
    rawPoints.push(projected);
    return projected;
  };
  const center = project([size[0] / 2, size[1] / 2]);
  const corners = [[0, 0], [size[0], 0], [size[0], size[1]], [0, size[1]]];
  const cornerPoints = corners.map(project);
  const coversWorld = Math.max(...cornerPoints.map(point => point[0]))
    - Math.min(...cornerPoints.map(point => point[0])) >= width - 0.000001;
  const unwrap = coordinate => (coversWorld ? coordinate.slice() : [
    coordinate[0] + (Math.round((center[0] - coordinate[0]) / width) * width),
    coordinate[1]
  ]);
  const resolutions = [];
  [0.25, 0.5, 0.75].forEach((horizontal) => {
    [0.25, 0.5, 0.75].forEach((vertical) => {
      const pixel = [size[0] * horizontal, size[1] * vertical];
      const origin = unwrap(project(pixel));
      [[pixel[0] + 1, pixel[1]], [pixel[0], pixel[1] + 1]].forEach((neighbor) => {
        const target = unwrap(project(neighbor));
        const distance = Math.hypot(target[0] - origin[0], target[1] - origin[1]);
        if (distance > 0) resolutions.push(distance);
      });
    });
  });
  if (!resolutions.length) throw new Error('Mapillary: cannot determine the map resolution.');
  const resolution = Math.min(...resolutions);
  let zoom = grid.getZForResolution(resolution, 1);
  const points = [];
  const sampleEdge = (firstPixel, lastPixel, first, last, depth) => {
    const middlePixel = [(firstPixel[0] + lastPixel[0]) / 2, (firstPixel[1] + lastPixel[1]) / 2];
    const middle = unwrap(project(middlePixel));
    const error = Math.hypot(middle[0] - ((first[0] + last[0]) / 2), middle[1] - ((first[1] + last[1]) / 2));
    if (error > resolution / 2 && depth < 7) {
      sampleEdge(firstPixel, middlePixel, first, middle, depth + 1);
      sampleEdge(middlePixel, lastPixel, middle, last, depth + 1);
    } else {
      if (error > resolution * 4 && depth === 7) {
        throw new Error('Mapillary: the map crosses an unresolved projection boundary.');
      }
      points.push(first, middle, last);
    }
  };
  corners.forEach((corner, index) => {
    const next = corners[(index + 1) % corners.length];
    sampleEdge(corner, next, unwrap(project(corner)), unwrap(project(next)), 0);
  });
  let minX = Math.min(...points.map(point => point[0])) - resolution;
  let maxX = Math.max(...points.map(point => point[0])) + resolution;
  const minY = Math.max(extent[1], Math.min(...points.map(point => point[1])) - resolution);
  const maxY = Math.min(extent[3], Math.max(...points.map(point => point[1])) + resolution);
  if (minY >= maxY) return [];
  if (Math.max(...rawPoints.map(point => point[0])) - Math.min(...rawPoints.map(point => point[0])) >= width) {
    minX = extent[0];
    maxX = extent[2];
  }
  const bounds = [];
  if (maxX - minX >= width) {
    bounds.push([extent[0], minY, extent[2], maxY]);
  } else {
    const firstWorld = Math.floor((minX - extent[0]) / width);
    const lastWorld = Math.floor((maxX - extent[0]) / width);
    for (let world = firstWorld; world <= lastWorld; world += 1) {
      bounds.push([
        Math.max(extent[0], minX - (world * width)), minY,
        Math.min(extent[2], maxX - (world * width)), maxY
      ]);
    }
  }
  const rangesForZoom = level => bounds.map((bound) => {
    const range = grid.getTileRangeForExtentAndZ(bound, level);
    const maxIndex = (2 ** level) - 1;
    return {
      minX: Math.max(0, range.minX),
      maxX: Math.min(maxIndex, range.maxX),
      minY: Math.max(0, range.minY),
      maxY: Math.min(maxIndex, range.maxY)
    };
  });
  const countTiles = ranges => ranges.reduce((total, range) => total + (
    Math.max(0, (range.maxX - range.minX) + 1) * Math.max(0, (range.maxY - range.minY) + 1)
  ), 0);
  let ranges = rangesForZoom(zoom);
  while (countTiles(ranges) > maxTiles && zoom > grid.getMinZoom()) {
    zoom -= 1;
    ranges = rangesForZoom(zoom);
  }
  if (countTiles(ranges) > maxTiles) throw new Error('Mapillary: this map extent exceeds the tile budget.');
  const tiles = new Map();
  ranges.forEach((range) => {
    for (let column = range.minX; column <= range.maxX; column += 1) {
      for (let row = range.minY; row <= range.maxY; row += 1) {
        const coordinate = [zoom, column, row];
        tiles.set(coordinate.join('/'), coordinate);
      }
    }
  });
  return Array.from(tiles.values());
}

export function decodeTile(data, extent, projection, format) {
  const features = format.readFeatures(data, {
    extent,
    featureProjection: nativeProjection
  });
  features.forEach((feature) => {
    const geometry = feature.getGeometry();
    if (geometry) {
      geometry.transform(nativeProjection, projection);
      if (!geometry.getFlatCoordinates().every(Number.isFinite)) {
        throw new Error('Mapillary geometry is outside the projection domain.');
      }
    }
  });
  return features;
}

function abortedError() {
  return Object.assign(new Error('Mapillary: request aborted.'), { aborted: true });
}

export function requestTile(url) {
  const xhr = new XMLHttpRequest();
  const promise = new Promise((resolve, reject) => {
    xhr.open('GET', url);
    xhr.responseType = 'arraybuffer';
    xhr.timeout = 15000;
    const fail = () => reject(Object.assign(new Error('Mapillary: a tile request failed.'), {
      status: xhr.status,
      retryAfter: xhr.getResponseHeader('Retry-After')
    }));
    xhr.onload = () => {
      if (xhr.status === 200 || xhr.status === 204) {
        resolve(xhr.response || new ArrayBuffer(0));
      } else fail();
    };
    xhr.onerror = fail;
    xhr.ontimeout = fail;
    xhr.onabort = () => reject(abortedError());
    xhr.send();
  });
  return { promise, abort: () => xhr.abort() };
}

export function createProjectedCoverage({
  map, source, nativeSource, format, transform, reportError, request = requestTile, limits = {}
}) {
  const budget = Object.assign({}, defaults, limits);
  const grid = nativeSource.getTileGrid();
  const cache = new Map();
  const jobs = new Map();
  const queue = [];
  let cacheBytes = 0;
  let activeRequests = 0;
  let active = false;
  let blocked = false;
  let pausedUntil = 0;
  let generation = 0;
  let timer;
  let errorMessage;
  let pump;

  function report(message) {
    if (message !== errorMessage) {
      errorMessage = message;
      reportError(message);
    }
  }

  function cancel(job) {
    jobs.delete(job.key);
    if (job.request) job.request.abort();
    job.reject(abortedError());
  }

  function remember(key, data) {
    if (data.byteLength > budget.cacheBytes) {
      throw new Error('Mapillary: a tile exceeds the memory budget.');
    }
    cache.set(key, data);
    cacheBytes += data.byteLength;
    while (cache.size > budget.cacheTiles || cacheBytes > budget.cacheBytes) {
      const oldest = cache.keys().next().value;
      cacheBytes -= cache.get(oldest).byteLength;
      cache.delete(oldest);
    }
  }

  function runJob(queuedJob) {
    const job = queuedJob;
    activeRequests += 1;
    job.attempts += 1;
    try {
      job.request = request(nativeSource.getTileUrlFunction()(job.coordinate, 1, nativeSource.getProjection()));
    } catch (error) {
      job.request = { promise: Promise.reject(error), abort() {} };
    }
    job.request.promise.then((data) => {
      if (jobs.get(job.key) !== job) return;
      remember(job.key, data);
      jobs.delete(job.key);
      job.resolve(data);
    }).catch((error) => {
      if (jobs.get(job.key) !== job) return;
      if (error.status === 401 || error.status === 403) {
        blocked = true;
        report('Mapillary: authorization failed. Check the client token before reactivating the plugin.');
        Array.from(jobs.values()).forEach(cancel);
      } else if (!error.aborted && job.attempts < 2 && (error.status === 0 || error.status === 429 || error.status >= 500)) {
        const headerDelay = Number(error.retryAfter) * 1000 || Date.parse(error.retryAfter) - Date.now();
        if (error.status === 429 && headerDelay > 60000) {
          blocked = true;
          report('Mapillary: the request quota is exhausted. Reactivate the plugin after the server cooldown.');
          Array.from(jobs.values()).forEach(cancel);
          return;
        }
        job.notBefore = Date.now() + Math.min(60000, Math.max(500, headerDelay || 500));
        if (error.status === 429) pausedUntil = job.notBefore;
        queue.push(job);
      } else {
        jobs.delete(job.key);
        job.reject(error);
      }
    }).then(() => {
      activeRequests -= 1;
      pump();
    });
  }

  pump = function pumpRequests() {
    clearTimeout(timer);
    if (!active || blocked) return;
    if (pausedUntil > Date.now()) {
      timer = setTimeout(pump, pausedUntil - Date.now());
      return;
    }
    let remaining = queue.length;
    while (activeRequests < budget.concurrency && queue.length && remaining > 0) {
      const job = queue.shift();
      remaining -= 1;
      if (jobs.get(job.key) === job) {
        if (job.notBefore > Date.now()) queue.push(job);
        else runJob(job);
      }
    }
    if (activeRequests < budget.concurrency && queue.length) {
      timer = setTimeout(pump, Math.max(1, Math.min(...queue.map(job => job.notBefore - Date.now()))));
    }
  };

  function load(coordinate) {
    const key = coordinate.join('/');
    if (cache.has(key)) {
      const data = cache.get(key);
      cache.delete(key);
      cache.set(key, data);
      return Promise.resolve(data);
    }
    if (jobs.has(key)) return jobs.get(key).promise;
    const job = {
      key, coordinate, attempts: 0, notBefore: 0
    };
    job.promise = new Promise((resolve, reject) => {
      job.resolve = resolve;
      job.reject = reject;
    });
    jobs.set(key, job);
    queue.push(job);
    return job.promise;
  }

  async function update() {
    if (!active || blocked) return;
    generation += 1;
    const currentGeneration = generation;
    try {
      const coordinates = selectTiles(map, grid, transform, budget.maxTiles);
      const required = new Set(coordinates.map(coordinate => coordinate.join('/')));
      Array.from(jobs.values()).forEach((job) => {
        if (!required.has(job.key)) cancel(job);
      });
      const pending = coordinates.map(load);
      pump();
      const data = await Promise.all(pending);
      if (!active || generation !== currentGeneration) return;
      if (data.reduce((total, tile) => total + tile.byteLength, 0) > budget.cacheBytes) {
        throw new Error('Mapillary: this map extent exceeds the memory budget.');
      }
      const projection = map.getView().getProjection();
      const features = [];
      const pointIds = new Set();
      const appendTile = (tileIndex) => {
        const tileFeatures = data[tileIndex].byteLength
          ? decodeTile(data[tileIndex], grid.getTileCoordExtent(coordinates[tileIndex]), projection, format) : [];
        tileFeatures.forEach((feature, featureIndex) => {
          const geometry = feature.getGeometry();
          const id = feature.get('id') === undefined ? feature.getId() : feature.get('id');
          const pointId = `${feature.get('layer')}:${id}`;
          if (geometry && geometry.getType() === 'Point' && id !== undefined) {
            if (pointIds.has(pointId)) return;
            pointIds.add(pointId);
          }
          if (geometry && projection.canWrapX()) {
            const projectionExtent = projection.getExtent();
            const worldWidth = projectionExtent[2] - projectionExtent[0];
            const featureExtent = geometry.getExtent();
            const offset = Math.round((map.getView().getCenter()[0] - ((featureExtent[0] + featureExtent[2]) / 2)) / worldWidth);
            geometry.translate(offset * worldWidth, 0);
          }
          feature.setId(`${coordinates[tileIndex].join('/')}:${featureIndex}`);
          if (feature.get('id') === undefined && id !== undefined) feature.set('id', id);
          features.push(feature);
        });
        if (features.length > budget.maxFeatures) throw new Error('Mapillary: this map extent exceeds the feature budget.');
      };
      const appendChunk = (start) => {
        if (!active || generation !== currentGeneration) return Promise.resolve();
        const end = Math.min(coordinates.length, start + 4);
        for (let index = start; index < end; index += 1) appendTile(index);
        if (end < coordinates.length) {
          return new Promise(resolve => setTimeout(resolve, 0)).then(() => appendChunk(end));
        }
        return Promise.resolve();
      };
      await appendChunk(0);
      if (!active || generation !== currentGeneration) return;
      source.clear();
      source.addFeatures(features);
      errorMessage = undefined;
    } catch (error) {
      if (active && generation === currentGeneration && !error.aborted) {
        report(error.message || 'Mapillary: coverage tiles could not be loaded.');
      }
    }
  }

  function stop() {
    active = false;
    generation += 1;
    map.un('moveend', update);
    map.un('change:size', update);
    map.un('change:view', update);
    clearTimeout(timer);
    Array.from(jobs.values()).forEach(cancel);
    queue.length = 0;
    source.clear();
  }

  return {
    start() {
      if (active) return Promise.resolve();
      active = true;
      blocked = false;
      pausedUntil = 0;
      map.on('moveend', update);
      map.on('change:size', update);
      map.on('change:view', update);
      return update();
    },
    update,
    stop,
    dispose() {
      stop();
      cache.clear();
      cacheBytes = 0;
    }
  };
}
