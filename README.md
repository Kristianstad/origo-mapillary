# origo-mapillary

Mapillary + MapillaryJS som plugin för Origo.  
Pluginet använder OpenLayers-klasserna som Origo exponerar via `Origo.ol`, så kartan och pluginet använder samma OpenLayers-version.
Bildpositioner transformeras från EPSG:4326 till kartans aktuella projektion med Origos `getMapUtils().transformCoordinate`. Pluginet kräver inte `Origo.ol.proj`.
Kartor i EPSG:3857 använder vektorplattor direkt. I andra registrerade projektioner läses Mapillarys plattor i EPSG:3857 och geometrierna transformeras till kartans koordinatsystem innan de visas.
I nuvarande version exponeras clientToken.  
**<ins>Det rekommenderas att inte använda denna plugin på externa kartor</ins>**.  
För att använda denna plugin på externa kartor bör OAuth 2.0 Authorization Code Flow implementeras.  (https://www.mapillary.com/developer/api-documentation#authentication)

## Ladda ner byggd plugin

[Ladda ner senaste byggda versionen](https://nightly.link/Kristianstad/origo-mapillary/workflows/build/main/origomapillary-built-assets.zip). Zip-filen innehåller `origomapillary.min.js`.

MapillaryJS CSS måste inkluderas.
```HTML
<link href="https://unpkg.com/mapillary-js@4.0.0/dist/mapillary.css" rel="stylesheet" >
```

**Parametrar:**
- `clientToken` : `string` Client token från Mapillary, **exponeras, bör inte användas för externa kartor**. **Obligatorisk**.
- `mapillaryUrl` : `string` URL till Mapillarys VectorTile. **Valfri**.
- `organizationId` : `integer` Filtering på organisations-ID. Om inget anges visas allt. **Valfri**.
- `declutter` : `boolean` Om declutter ska användas på Mapillary-lagret. **Valfri**.
- `startActive` : `boolean` Öppnar pluginet automatiskt efter rendering när värdet är `true`. Standard är `false`. Ingen bild väljs automatiskt. **Valfri**.
- `prefetch` : `boolean` Hämtar i förväg den data som behövs för navigeringspilarna, dels för bildpunkterna i kartvyn när man är inzoomad, dels för den bildpunkt som muspekaren är över. Standard är `true`. **Valfri**.
- `mapillaryLayerName` : `string` Namn på Mapillary-lagret. **Valfri**.
- `normalLegendLabel` : `string` Teckenförklaringens text för icke-360-bilder . **Valfri**.
- `panoLegendLabel` : `string` Teckensförklaringens text för 360-bilder. **Valfri**.
- `selectionStyleColor` : `string` Färgsättning på selektionspunkten. **Valfri**.
- `normalStyleColor` : `string` Färgsättning på icke-360-bilder. **Valfri**.
- `panoStyleColor` : `string` Färgsättning på 360-bilder. **Valfri**.
- `normalViewerHeight` : `string` Höjd på viewer i vanligt läge. **Valfri**.
- `normalViewerWidth` : `string` Bredd på viewer i vanligt läge. **Valfri**.
- `largeViewerHeight` : `string` Höjd på viewer i förstorat läge. **Valfri**.
- `largeViewerWidth` : `string` Bredd på viewer i förstorat läge. **Valfri**.

**Exempel:**
```JS
clientToken: 'MLY|1234567890|abcdef123456abc123456',
mapillaryUrl: 'https://tiles.mapillary.com/maps/vtp/mly1_public/2/{z}/{x}/{y}'
organizationId: 2515762671903562
declutter: true
mapillaryLayerName: 'Mapillary'
normalLegendLabel: 'Vanliga bilder'
panoLegendLabel: '360 bilder'
selectionStyleColor: '#0099ff'
normalStyleColor: '#5cb7ff'
panoStyleColor: '#ff8927'
normalViewerHeight: '20rem'
normalViewerWidth: '25rem'
largeViewerHeight: '40rem'
largeViewerWidth: '50rem'
```

För att öppna pluginet när kartan laddas:
```JS
const mapillary = new origomapillary({
	clientToken: 'DIN_TOKEN',
	startActive: true
});
viewer.addComponent(mapillary);
```

## Projektioner

Pluginet väljer automatiskt visningssätt från kartans projektion. Ingen särskild pluginparameter behövs för exempelvis EPSG:3008, EPSG:3006 eller EPSG:4326. Mapillarys plattkälla behåller alltid EPSG:3857 och högsta tile-zoom 14; kartan kan zoomas närmare utan att punkterna försvinner.

Koordinatsystem utöver Origos inbyggda behöver registreras i kartkonfigurationens `proj4Defs`. Kartans `center`, `extent` och `projectionExtent` måste anges i kartans eget koordinatsystem. Exempel för EPSG:3008:

```json
{
	"projectionCode": "EPSG:3008",
	"center": [191147, 6212100],
	"extent": [100000, 6100000, 250000, 6350000],
	"projectionExtent": [100000, 6100000, 250000, 6350000],
	"proj4Defs": [
		{
			"code": "EPSG:3008",
			"projection": "+proj=tmerc +lat_0=0 +lon_0=13.5 +k=1 +x_0=150000 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs"
		}
	]
}
```

Stödet är generiskt för registrerade 2D-koordinatsystem med giltig transformation till och från EPSG:3857 över kartutsnittet. Projektionsdefinitioner, eventuella datumgridfiler och deras noggrannhet är kartans ansvar. Om transformationen saknas, utsnittet korsar en olöst projektionsgräns eller ligger utanför Mapillarys Mercator-täckning kan inga plattor visas; fel rapporteras utan att token skrivs ut.

Visning och klick är oförändrade: sekvenslinjer visas på mellanzoom och bildpunkter närmare. Endast bildpunkter öppnar bilder. Markören placeras och orienteras i kartans projektion.
Markören använder bildens ursprungliga GPS-position för `mly1_public`, eller bildens beräknade position för `mly1_computed_public`, inte visarens rörliga kameraposition. Efter ett kartklick förankras markören i bildpunktens exakta plattkoordinat tills en annan bild visas; pilspetsen förankras i samma punkt.

Omprojekterad visning använder högst 6 samtidiga anrop och 128 plattor per utsnitt. Vid större plattbehov väljs en grövre tile-nivå, vilket kan senarelägga bildpunkter på extrema utsnitt. Råplattornas cache begränsas till 128 plattor och 16 MiB. Ett utsnitt får innehålla högst 16 MiB plattdata och 100 000 renderade objekt; överskridanden rapporteras i stället för att visa ett ofullständigt resultat. Avstängning avbryter pågående laddning, och komponentens `clear` frigör lyssnare och cache.

## Tester

Med Node.js 22 eller senare:

```sh
npm install
npm test
```

Testerna använder OpenLayers och proj4 som utvecklingsberoenden; dessa följer inte med som separata runtimebibliotek i pluginbygget. De kontrollerar MVT-avkodning, fem projektioner, datumgräns, resursgränser, felhantering och pluginets punktklick/livscykel utan externa API-anrop.

För browserkontroll mot ett lokalt Origo-bygge, använd en HTML-export där Origo-biblioteket är inbäddat i ett eget skript:

```sh
npm run test:host -- --html /path/to/origo-export.html
```

Testservern binds till localhost och återanvänder endast det isolerade Origo-biblioteket och CSS. Den ursprungliga kartkonfigurationen används inte. Testplattorna är syntetiska och kräver ingen Mapillary-token. Öppna den utskrivna URL:en med `?crs=EPSG:3008`, `?crs=EPSG:3857` eller `?crs=EPSG:4326`; testresultatet finns i `window.hostResult`.

### Demo
![](demomapillary.gif)
