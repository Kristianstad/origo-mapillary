import Pbf from 'pbf';

export function tileFixture(point = [2048, 2048]) {
  const buffer = new Pbf();
  buffer.writeMessage(3, (_, layer) => {
    layer.writeStringField(1, 'image');
    layer.writeVarintField(5, 4096);
    layer.writeVarintField(15, 2);
    layer.writeStringField(3, 'id');
    layer.writeMessage(4, (value, writer) => writer.writeStringField(1, value), '9007199254740993');
    layer.writeMessage(2, (value, feature) => {
      feature.writeVarintField(3, 1);
      feature.writePackedVarint(2, [0, 0]);
      feature.writePackedVarint(4, [9, ...point.map(coordinate => coordinate < 0 ? -coordinate * 2 - 1 : coordinate * 2)]);
    });
  });
  return buffer.finish().slice().buffer;
}