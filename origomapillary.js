import Origo from 'Origo';
import { GraphDataProvider, Viewer } from 'mapillary-js';
import dragElement from './utils/dragElement';
import { createProjectedCoverage, getImageId, markerRotation, matchesOrganization, nativeProjection } from './utils/mapillaryCoverage';
import withPrefetch from './utils/mapillaryPrefetch';

const {
  Feature,
  format: { MVT },
  geom: { Point },
  layer: { Vector: VectorLayer, VectorTile: VectorTileLayer },
  source: { Vector: VectorSource, VectorTile: VectorTileSource },
  style: {
    Circle, Fill, Icon, Stroke, Style
  }
} = Origo.ol;
const CircleStyle = Circle;

const origomapillary = function origomapillary(options = {}) {
  let viewer;
  let mapillaryViewer;
  let target;
  let map;
  let filterBox;
  let filterBoxContent;
  let moveBox;
  let coverageLayer;
  let selectionLayer;
  let mapillaryDiv;
  let mapillaryButton;
  let sizeButton;
  let coverageController;
  let dataProvider;
  let hoveredImageId;
  let active = false;
  let markerGeneration = 0;
  let selectedImageLocation;
  let toggledLarge = false;

  const dom = Origo.ui.dom;
  const clientToken = Object.prototype.hasOwnProperty.call(options, 'clientToken') ? options.clientToken : undefined;
  const mapillaryUrl = Object.prototype.hasOwnProperty.call(options, 'mapillaryUrl') ? options.mapillaryUrl : 'https://tiles.mapillary.com/maps/vtp/mly1_public/2/{z}/{x}/{y}';
  const mapillaryMaxZoom = 14;
  const organizationId = Object.prototype.hasOwnProperty.call(options, 'organizationId') ? options.organizationId : undefined;
  const declutter = Object.prototype.hasOwnProperty.call(options, 'declutter') ? options.declutter : true;
  const prefetch = Object.prototype.hasOwnProperty.call(options, 'prefetch') ? options.prefetch : true;
  const mapillaryLayerName = Object.prototype.hasOwnProperty.call(options, 'mapillaryLayerName') ? options.mapillaryLayerName : 'Mapillary';
  const normalLegendLabel = Object.prototype.hasOwnProperty.call(options, 'normalLegendLabel') ? options.normalLegendLabel : 'Vanliga bilder';
  const panoLegendLabel = Object.prototype.hasOwnProperty.call(options, 'panoLegendLabel') ? options.panoLegendLabel : '360 bilder';
  const selectionStyleColor = Object.prototype.hasOwnProperty.call(options, 'selectionStyleColor') ? options.selectionStyleColor : '#0099ff';
  const normalStyleColor = Object.prototype.hasOwnProperty.call(options, 'normalStyleColor') ? options.normalStyleColor : '#5cb7ff';
  const panoStyleColor = Object.prototype.hasOwnProperty.call(options, 'panoStyleColor') ? options.panoStyleColor : '#ff8927';
  const normalViewerHeight = Object.prototype.hasOwnProperty.call(options, 'normalViewerHeight') ? options.normalViewerHeight : '20rem';
  const normalViewerWidth = Object.prototype.hasOwnProperty.call(options, 'normalViewerWidth') ? options.normalViewerWidth : '25rem';
  const largeViewerHeight = Object.prototype.hasOwnProperty.call(options, 'largeViewerHeight') ? options.largeViewerHeight : '40rem';
  const largeViewerWidth = Object.prototype.hasOwnProperty.call(options, 'largeViewerWidth') ? options.largeViewerWidth : '50rem';

  const selectionStyle = new Style({
    image: new Circle({
      stroke: new Stroke({
        color: selectionStyleColor,
        width: 2
      }),
      fill: new Fill({
        color: selectionStyleColor
      }),
      radius: 6,
      opacity: 0.5
    })
  });

  const normalStyle = new CircleStyle({
    fill: new Fill({
      color: normalStyleColor
    }),
    radius: 5,
    stroke: new Stroke({
      color: normalStyleColor,
      width: 1.25
    })
  });

  const normalStroke = new Stroke({
    color: normalStyleColor,
    width: 2
  });

  const panoStyle = new CircleStyle({
    fill: new Fill({
      color: panoStyleColor
    }),
    radius: 5,
    stroke: new Stroke({
      color: panoStyleColor,
      width: 1.25
    })
  });

  const panoStroke = new Stroke({
    color: panoStyleColor,
    width: 2
  });

  const normalFeatureStyle = new Style({ image: normalStyle, stroke: normalStroke });
  const panoFeatureStyle = new Style({ image: panoStyle, stroke: panoStroke });

  const svg = '<svg width="24" height="24" version="1.1" xmlns="http://www.w3.org/2000/svg"><path d="M12,3C7.79,3 3.7,4.41 0.38,7C4.41,12.06 7.89,16.37 12,21.5C16.08,16.42 20.24,11.24 23.65,7C20.32,4.41 16.22,3 12,3Z" /></svg>';

  const angleStyle = new Style({
    image: new Icon({
      opacity: 0.5,
      src: `data:image/svg+xml;utf8,${svg}`,
      scale: 1,
      anchor: [12, 21.5],
      anchorXUnits: 'pixels',
      anchorYUnits: 'pixels',
      rotateWithView: true,
      rotation: 0
    })
  });

  const legendStyle = [
    [
      {
        label: normalLegendLabel,
        circle: {
          radius: 10,
          fill: {
            color: normalStyleColor
          }
        }
      }
    ],
    [
      {
        label: panoLegendLabel,
        circle: {
          radius: 10,
          fill: {
            color: panoStyleColor
          }
        }
      }
    ]
  ];

  async function setMarker() {
    if (!active || !mapillaryViewer) return;
    markerGeneration += 1;
    const generation = markerGeneration;
    const image = await mapillaryViewer.getImage();
    const position = mapillaryUrl.includes('/mly1_computed_public/')
      ? image.lngLat : image.originalLngLat;
    const bearing = await mapillaryViewer.getBearing();
    if (!active || generation !== markerGeneration) return;
    const transform = viewer.getMapUtils().transformCoordinate;
    const projection = map.getView().getProjection();
    const imagePosition = viewer.getMapUtils().transformCoordinate(
      [position.lng, position.lat],
      'EPSG:4326',
      projection
    );
    const pos = selectedImageLocation
      && selectedImageLocation.id === String(image.id)
      && selectedImageLocation.projection === projection.getCode()
      ? selectedImageLocation.coordinates : imagePosition;

    const pointFeature = new Feature({
      geometry: new Point(pos)
    });

    angleStyle.getImage().setRotation(markerRotation(position, bearing, projection, transform));
    pointFeature.setStyle([angleStyle, selectionStyle]);
    selectionLayer.getSource().clear();
    selectionLayer.getSource().addFeature(pointFeature);
  }

  function imageAtPixel(pixel) {
    let result;
    map.forEachFeatureAtPixel(
      pixel,
      (feature, layer) => {
        if (layer !== coverageLayer) return undefined;
        const imageId = getImageId(feature, organizationId);
        if (imageId === undefined || imageId === null) return undefined;
        const geometry = feature.getGeometry ? feature.getGeometry() : feature;
        const coordinates = geometry.getCoordinates ? geometry.getCoordinates() : geometry.getFlatCoordinates();
        result = { feature, id: String(imageId), coordinates: coordinates.slice(0, 2) };
        return true;
      },
      {
        layerFilter: layer => layer === coverageLayer,
        hitTolerance: 1
      }
    );
    return result;
  }

  function toLngLat(coordinate, projection) {
    const [lng, lat] = viewer.getMapUtils().transformCoordinate(coordinate, projection, 'EPSG:4326');
    return Number.isFinite(lng) && Number.isFinite(lat) ? { lng, lat } : undefined;
  }

  function prefetchView() {
    if (!active || !dataProvider) return;
    const size = map.getSize();
    if (!size || !size[0] || !size[1]) return;
    try {
      const projection = map.getView().getProjection();
      const corners = [[0, 0], [size[0], 0], [size[0], size[1]], [0, size[1]]]
        .map(pixel => toLngLat(map.getCoordinateFromPixel(pixel), projection));
      const center = toLngLat(map.getCoordinateFromPixel([size[0] / 2, size[1] / 2]), projection);
      if (!center || corners.some(corner => !corner)) return;
      const sw = { lng: Math.min(...corners.map(c => c.lng)), lat: Math.min(...corners.map(c => c.lat)) };
      const ne = { lng: Math.max(...corners.map(c => c.lng)), lat: Math.max(...corners.map(c => c.lat)) };
      dataProvider.prefetchArea({ sw, ne, center }).catch(() => undefined);
    } catch (error) {
      // Prefetching is best effort; the viewer loads missing data on demand.
    }
  }

  function handlePointerMove(event) {
    if (!active || !dataProvider || event.dragging) return;
    const image = imageAtPixel(event.pixel);
    if (!image || image.id === hoveredImageId) return;
    hoveredImageId = image.id;
    try {
      const sequenceId = image.feature.get('sequence_id');
      dataProvider.prefetchImage({
        id: image.id,
        sequenceId: sequenceId === undefined || sequenceId === null ? undefined : String(sequenceId),
        lngLat: toLngLat(image.coordinates, map.getView().getProjection())
      }).catch(() => undefined);
    } catch (error) {
      // Prefetching is best effort; the viewer loads missing data on demand.
    }
  }

  async function enableInteraction() {
    if (active) return;
    active = true;
    document.getElementById(mapillaryButton.getId()).classList.add('active');
    document.getElementById(mapillaryButton.getId()).classList.remove('tooltip');
    document.getElementById(filterBox.getId()).classList.remove('o-hidden');
    if (clientToken) {
      map.addLayer(coverageLayer);
      map.addLayer(selectionLayer);

      viewer.addStyle('mapillary-legend', legendStyle);
      coverageLayer.set('styleName', 'mapillary-legend');
      if (coverageController) coverageController.start();
      prefetchView();
    }
  }

  function disableInteraction() {
    if (!active) return;
    active = false;
    markerGeneration += 1;
    document.getElementById(mapillaryButton.getId()).classList.remove('active');
    document.getElementById(mapillaryButton.getId()).classList.add('tooltip');
    document.getElementById(filterBox.getId()).classList.add('o-hidden');
    if (clientToken) {
      if (coverageController) coverageController.stop();
      if (dataProvider) dataProvider.cancelPrefetch();
      hoveredImageId = undefined;
      map.removeLayer(selectionLayer);
      map.removeLayer(coverageLayer);
    }
  }

  function toggleFilter() {
    if (document.getElementById(mapillaryButton.getId()).classList.contains('tooltip')) {
      enableInteraction();
    } else {
      disableInteraction();
    }
  }

  function toggleSize() {
    if (toggledLarge) {
      toggledLarge = false;
      sizeButton.setIcon('#ic_add_24px');
      document.getElementById(filterBox.getId()).style.height = normalViewerHeight;
      document.getElementById(filterBox.getId()).style.width = normalViewerWidth;
    } else {
      toggledLarge = true;
      sizeButton.setIcon('#ic_remove_24px');
      document.getElementById(filterBox.getId()).style.height = largeViewerHeight;
      document.getElementById(filterBox.getId()).style.width = largeViewerWidth;
    }
    mapillaryViewer.resize();
  }

  const styleFunction = function styleFunction(feature) {
    if (!matchesOrganization(feature, organizationId)) return undefined;
    return feature.get('is_pano') ? panoFeatureStyle : normalFeatureStyle;
  };

  function updateMarker() {
    setMarker().catch(() => console.warn('Mapillary: the image marker could not be updated.'));
  }

  function handleMapClick(event) {
    if (!active || !mapillaryViewer.isNavigable) return;
    const image = imageAtPixel(event.pixel);
    if (!image) return;
    const location = {
      id: image.id,
      coordinates: image.coordinates,
      projection: map.getView().getProjection().getCode()
    };
    selectedImageLocation = location;
    mapillaryViewer.moveTo(image.id).catch(() => {
      if (selectedImageLocation === location) selectedImageLocation = undefined;
      console.warn('Mapillary: the selected image could not be opened.');
    });
    mapillaryViewer.resize();
  }

  function createCoverageLayer() {
    const nativeSource = new VectorTileSource({
      url: `${mapillaryUrl}?access_token=${clientToken}`,
      projection: nativeProjection,
      maxZoom: mapillaryMaxZoom,
      format: new MVT()
    });
    // Origo's legend only removes overlays with an explicit group, looked up by layer name.
    const settings = {
      declutter,
      name: 'origomapillary-coverage',
      group: 'root',
      title: mapillaryLayerName,
      style: styleFunction
    };
    coverageController = undefined;
    if (map.getView().getProjection().getCode() === nativeProjection) {
      coverageLayer = new VectorTileLayer(Object.assign({}, settings, { source: nativeSource }));
    } else {
      const source = new VectorSource({ wrapX: false });
      coverageLayer = new VectorLayer(Object.assign({}, settings, { source }));
      coverageController = createProjectedCoverage({
        map,
        source,
        nativeSource,
        format: new MVT({ featureClass: Feature }),
        transform: viewer.getMapUtils().transformCoordinate,
        reportError: message => console.warn(message)
      });
    }
  }

  function changeView() {
    if (active) map.removeLayer(coverageLayer);
    if (coverageController) coverageController.dispose();
    markerGeneration += 1;
    selectedImageLocation = undefined;
    selectionLayer.getSource().clear();
    createCoverageLayer();
    if (active) {
      coverageLayer.set('styleName', 'mapillary-legend');
      map.addLayer(coverageLayer);
      if (coverageController) coverageController.start();
    }
  }

  return Origo.ui.Component({
    name: 'origomapillary',
    onInit() {
      this.on('clear', () => {
        disableInteraction();
        if (coverageController) coverageController.dispose();
        if (map) {
          map.un('click', handleMapClick);
          map.un('pointermove', handlePointerMove);
          map.un('moveend', prefetchView);
          map.un('change:view', changeView);
        }
        if (mapillaryViewer) {
          mapillaryViewer.off('position', updateMarker);
          mapillaryViewer.off('bearing', updateMarker);
          mapillaryViewer.off('image', updateMarker);
          mapillaryViewer.remove();
        }
        [mapillaryDiv, filterBox].forEach((component) => {
          const element = document.getElementById(component.getId());
          if (element) element.remove();
        });
      });
      mapillaryDiv = Origo.ui.Element({
        tagName: 'div',
        cls: 'flex column',
        style: {
          position: 'relative'
        }
      });

      mapillaryButton = Origo.ui.Button({
        cls: 'padding-small margin-bottom-smaller icon-smaller round light box-shadow tooltip',
        click() {
          toggleFilter();
        },
        icon: '#ic_map_24px',
        tooltipText: 'Mapillary',
        tooltipPlacement: 'east'
      });

      filterBoxContent = Origo.ui.Element({
        tagName: 'div',
        style: {
          height: '100%',
          width: '100%'
        }
      });

      moveBox = Origo.ui.Element({
        tagName: 'div',
        cls: 'padding-small margin-bottom-smaller icon-smaller round light absolute',
        style: {
          background: 'white',
          cursor: 'move',
          width: '2rem',
          height: '2rem',
          padding: '0.25rem',
          top: '3px',
          left: '3px',
          color: '#4a4a4a'
        },
        innerHTML: '<svg style="width:24px;height:24px" viewBox="0 0 24 24"><path fill="currentColor" d="M13,11H18L16.5,9.5L17.92,8.08L21.84,12L17.92,15.92L16.5,14.5L18,13H13V18L14.5,16.5L15.92,17.92L12,21.84L8.08,17.92L9.5,16.5L11,18V13H6L7.5,14.5L6.08,15.92L2.16,12L6.08,8.08L7.5,9.5L6,11H11V6L9.5,7.5L8.08,6.08L12,2.16L15.92,6.08L14.5,7.5L13,6V11Z" /></svg>'
      });

      sizeButton = Origo.ui.Button({
        cls: 'padding-small margin-bottom-smaller icon-smaller round light absolute',
        icon: '#ic_add_24px',
        style: {
          width: '2rem',
          height: '2rem',
          padding: '0.25rem',
          top: '3px',
          right: '3px'
        }
      });

      filterBox = Origo.ui.Element({
        tagName: 'div',
        cls: 'flex column control box bg-white overflow-hidden o-hidden filter-box',
        style: {
          left: '4rem',
          top: '1rem',
          padding: '0.5rem',
          width: normalViewerWidth,
          height: normalViewerHeight,
          'z-index': '-1'
        }
      });
    },
    async onAdd(evt) {
      viewer = evt.target;
      target = `${viewer.getMain().getMapTools().getId()}`;
      map = viewer.getMap();

      if (clientToken) {
        createCoverageLayer();
        selectionLayer = new VectorLayer({
          title: 'Mapillary - Selection',
          source: new VectorSource(),
          style: [selectionStyle],
          group: 'none'
        });

        map.on('change:view', changeView);
      }

      this.addComponents([mapillaryButton]);
      await this.render();
    },
    async render() {
      document.getElementById(target).appendChild(dom.html(mapillaryDiv.render()));
      document.getElementById(mapillaryDiv.getId()).appendChild(dom.html(mapillaryButton.render()));
      document.getElementById(viewer.getMain().getId()).appendChild(dom.html(filterBox.render()));
      document.getElementById(filterBox.getId()).appendChild(dom.html(filterBoxContent.render()));
      document.getElementById(filterBox.getId()).appendChild(dom.html(sizeButton.render()));
      document.getElementById(filterBox.getId()).appendChild(dom.html(moveBox.render()));
      document.getElementById(moveBox.getId()).setAttribute('id', `${filterBox.getId()}header`);

      dragElement(document.getElementById(filterBox.getId()));
      if (clientToken) {
        if (prefetch) {
          const PrefetchingDataProvider = withPrefetch(GraphDataProvider);
          dataProvider = new PrefetchingDataProvider({ accessToken: clientToken });
        }
        mapillaryViewer = new Viewer(Object.assign({
          accessToken: clientToken,
          container: document.getElementById(filterBoxContent.getId())
        }, dataProvider ? { dataProvider } : {}));

        document.getElementById(sizeButton.getId()).addEventListener('click', toggleSize);
        mapillaryViewer.on('position', updateMarker);
        mapillaryViewer.on('bearing', updateMarker);
        mapillaryViewer.on('image', updateMarker);
        map.on('click', handleMapClick);
        if (dataProvider) {
          map.on('pointermove', handlePointerMove);
          map.on('moveend', prefetchView);
        }
      }
      if (options.startActive === true) {
        await enableInteraction();
        if (mapillaryViewer) {
          mapillaryViewer.resize();
        }
      }
      this.dispatch('render');
    }
  });
};

export default origomapillary;
