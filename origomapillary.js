import Origo from 'Origo';
import { Viewer } from 'mapillary-js';
import dragElement from './utils/dragElement';

const {
  Feature,
  format: { MVT },
  geom: { Point },
  layer: { Vector: VectorLayer, VectorTile: VectorTileLayer },
  source: { Vector: VectorSource, VectorTile: VectorTileSource },
  style: { Circle, Fill, Icon, Stroke, Style }
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
  let defaultStyles;
  let toggledLarge = false;

  const dom = Origo.ui.dom;
  const clientToken = Object.prototype.hasOwnProperty.call(options, 'clientToken') ? options.clientToken : undefined;
  const mapillaryUrl = Object.prototype.hasOwnProperty.call(options, 'mapillaryUrl') ? options.mapillaryUrl : 'https://tiles.mapillary.com/maps/vtp/mly1_public/2/{z}/{x}/{y}';
  const mapillaryMaxZoom = 14;
  const organizationId = Object.prototype.hasOwnProperty.call(options, 'organizationId') ? options.organizationId : undefined;
  const declutter = Object.prototype.hasOwnProperty.call(options, 'declutter') ? options.declutter : true;
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

  const svg = '<svg width="48" height="48" version="1.1" xmlns="http://www.w3.org/2000/svg"><path d="M12,3C7.79,3 3.7,4.41 0.38,7C4.41,12.06 7.89,16.37 12,21.5C16.08,16.42 20.24,11.24 23.65,7C20.32,4.41 16.22,3 12,3Z" /></svg>';

  const angleStyle = new Style({
    image: new Icon({
      opacity: 0.5,
      src: `data:image/svg+xml;utf8,${svg}`,
      scale: 1,
      offset: [-12, 0],
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
    const position = await mapillaryViewer.getPosition();
    const bearing = await mapillaryViewer.getBearing();
    const pos = viewer.getMapUtils().transformCoordinate(
      [position.lng, position.lat],
      'EPSG:4326',
      map.getView().getProjection()
    );

    const pointFeature = new Feature({
      geometry: new Point(pos)
    });

    angleStyle.getImage().setRotation(bearing * (Math.PI / 180));
    pointFeature.setStyle([angleStyle, selectionStyle]);
    selectionLayer.getSource().clear();
    selectionLayer.getSource().addFeature(pointFeature);
  }

  async function enableInteraction() {
    document.getElementById(mapillaryButton.getId()).classList.add('active');
    document.getElementById(mapillaryButton.getId()).classList.remove('tooltip');
    document.getElementById(filterBox.getId()).classList.remove('o-hidden');
    if (clientToken) {
      map.addLayer(coverageLayer);
      map.addLayer(selectionLayer);

      viewer.addStyle('mapillary-legend', legendStyle);
      coverageLayer.set('styleName', 'mapillary-legend');
    }
  }

  function disableInteraction() {
    document.getElementById(mapillaryButton.getId()).classList.remove('active');
    document.getElementById(mapillaryButton.getId()).classList.add('tooltip');
    document.getElementById(filterBox.getId()).classList.add('o-hidden');
    if (clientToken) {
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
    const newStyle = defaultStyles[0];
    if (feature.get('organization_id') === organizationId) {
      if (feature.get('is_pano')) {
        newStyle.setImage(panoStyle);
        newStyle.setStroke(panoStroke);
        return newStyle;
      }
      newStyle.setImage(normalStyle);
      newStyle.setStroke(normalStroke);
      return newStyle;
    }

    return new Style();
  };

  const handleInteraction = function handleInteraction() {
    mapillaryViewer.on('position', () => {
      setMarker();
    });

    mapillaryViewer.on('bearing', () => {
      setMarker();
    });

    map.on('click', (event) => {
      map.forEachFeatureAtPixel(
        event.pixel,
        (feature) => {
          if (!(feature instanceof Feature)) {
            try {
              const type = feature.getType();
              if (type === 'Point') {
                const imageId = feature.getProperties().id;
                if (imageId && mapillaryViewer.isNavigable) {
                  mapillaryViewer.moveTo(`${imageId}`).catch(error => error); // TODO: Get better error handling
                  mapillaryViewer.resize();
                }
              }
              // eslint-disable-next-line no-empty
            } catch (ex) { }
          }
        },
        {
          hitTolerance: 1
        }
      );
    });
  };

  return Origo.ui.Component({
    name: 'origomapillary',
    onInit() {
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
        const source = new VectorTileSource({
          url: `${mapillaryUrl}?access_token=${clientToken}`,
          format: new MVT()
        });
        const tileGrid = source.getTileGridForProjection(map.getView().getProjection());
        source.tileGrid = viewer.getMapUtils().tileGrid({
          extent: tileGrid.getExtent(),
          origin: tileGrid.getOrigin(0),
          resolutions: tileGrid.getResolutions().slice(0, mapillaryMaxZoom + 1),
          tileSize: tileGrid.getTileSize(0)
        });

        selectionLayer = new VectorLayer({
          title: 'Mapillary - Selection',
          source: new VectorSource(),
          style: [selectionStyle],
          group: 'none'
        });

        coverageLayer = new VectorTileLayer({
          declutter,
          title: mapillaryLayerName,
          source
        });
      }

      this.addComponents([mapillaryButton]);
      this.render();
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
        mapillaryViewer = new Viewer({
          accessToken: clientToken,
          container: document.getElementById(filterBoxContent.getId())
        });

        defaultStyles = coverageLayer.getStyleFunction()();
        coverageLayer.setStyle(styleFunction);

        document.getElementById(sizeButton.getId()).addEventListener('click', toggleSize);
        handleInteraction();
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
