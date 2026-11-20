import { inspectFont, maskFont, readFont, transplantIdentity } from './font.js';

const errorMessage = (error) => error instanceof RangeError ? '字体数据超出范围，文件可能已损坏。' : error.message;

self.onmessage = async ({ data: { inspect, bases, donors, mappings, mode } }) => {
  if (inspect) {
    for (const [index, file] of inspect.entries()) {
      try {
        self.postMessage({ index, info: inspectFont(await file.arrayBuffer()) });
      } catch (error) {
        self.postMessage({ index, error: errorMessage(error) });
      }
    }
    self.postMessage({ done: true });
    return;
  }
  const cachedDonors = new Map();
  for (const [index, file] of bases.entries()) {
    try {
      const base = readFont(await file.arrayBuffer());
      const mapping = mappings[index];
      if (mapping.length !== base.faces.length) throw new Error('请为每个基底字面选择一个供体。');
      const donorFaces = [];
      for (const { fileIndex, faceIndex } of mapping) {
        if (!cachedDonors.has(fileIndex)) cachedDonors.set(fileIndex, donors[fileIndex].arrayBuffer().then(readFont));
        const donor = await cachedDonors.get(fileIndex);
        const face = donor.faces[faceIndex];
        if (!face) throw new Error('所选的供体字面不存在。');
        donorFaces.push(face);
      }
      const result = mode === 'identity' ? transplantIdentity(base, donorFaces) : maskFont(base, donorFaces);
      self.postMessage({ index, result }, [result.bytes.buffer]);
    } catch (error) {
      self.postMessage({ index, error: errorMessage(error) });
    }
  }
  self.postMessage({ done: true });
};
