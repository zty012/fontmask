import opentype from 'opentype.js';

const truetype = 0x00010000;
const collection = 0x74746366;
const signature = 0xb1b0afba;
const required = ['head', 'hhea', 'hmtx', 'maxp', 'cmap', 'loca', 'glyf'];
const invalidated = ['DSIG', 'hdmx', 'LTSH', 'VDMX', 'EBDT', 'EBLC', 'EBSC', 'bdat', 'bloc'];
const unsupported = ['CFF ', 'CFF2', 'COLR', 'SVG ', 'sbix', 'CBDT'];
const ensure = (condition, message = '字体文件已损坏或不完整。') => {
  if (!condition) throw new Error(message);
};
const view = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const align = (length) => Math.ceil(length / 4) * 4;
const identityNameIds = new Set([1, 2, 4, 6, 16, 17, 18, 21, 22, 25]);

function readNames(bytes) {
  const message = '字体缺少有效的名称表。';
  ensure(bytes?.length >= 6, message);
  const data = view(bytes);
  const format = data.getUint16(0);
  const count = data.getUint16(2);
  const storage = data.getUint16(4);
  const recordsEnd = 6 + count * 12;
  ensure((format === 0 || format === 1) && recordsEnd <= storage && storage <= bytes.length, message);
  const readString = (offset) => {
    const length = data.getUint16(offset);
    const start = storage + data.getUint16(offset + 2);
    ensure(start + length <= bytes.length, message);
    return bytes.subarray(start, start + length);
  };
  let languageTags = [];
  if (format === 1) {
    ensure(recordsEnd + 2 <= storage, message);
    const tagCount = data.getUint16(recordsEnd);
    ensure(recordsEnd + 2 + tagCount * 4 <= storage, message);
    languageTags = Array.from({ length: tagCount }, (_, index) => readString(recordsEnd + 2 + index * 4));
  }
  return Array.from({ length: count }, (_, index) => {
    const offset = 6 + index * 12;
    const platform = data.getUint16(offset);
    const encoding = data.getUint16(offset + 2);
    const language = data.getUint16(offset + 4);
    const id = data.getUint16(offset + 6);
    const languageTag = language >= 0x8000 ? languageTags[language - 0x8000] : undefined;
    ensure(language < 0x8000 || languageTag, message);
    return { platform, encoding, language, languageTag, id, bytes: readString(offset + 8) };
  });
}

function writeNames(records) {
  const message = '合并后的字体名称表超出 TrueType 大小限制。';
  const tags = new Map();
  const naming = records.map((record) => {
    if (!record.languageTag) return record;
    const key = record.languageTag.join(',');
    if (!tags.has(key)) tags.set(key, { index: tags.size, bytes: record.languageTag });
    return { ...record, language: 0x8000 + tags.get(key).index };
  }).sort((left, right) => left.platform - right.platform || left.encoding - right.encoding || left.language - right.language || left.id - right.id);
  const end = 6 + naming.length * 12;
  const storage = end + (tags.size ? 2 + tags.size * 4 : 0);
  ensure(storage <= 0xffff, message);
  const strings = new Map();
  let size = 0;
  const intern = (bytes) => {
    const key = bytes.join(',');
    if (!strings.has(key)) {
      strings.set(key, { offset: size, bytes });
      size += bytes.length;
    }
    return strings.get(key).offset;
  };
  const offsets = naming.map((record) => intern(record.bytes));
  const tagOffsets = [...tags.values()].map((tag) => ({ ...tag, offset: intern(tag.bytes) }));
  ensure(size <= 0xffff, message);
  const output = new Uint8Array(storage + size);
  const data = view(output);
  data.setUint16(0, Number(tags.size > 0));
  data.setUint16(2, naming.length);
  data.setUint16(4, storage);
  naming.forEach((record, index) => {
    [record.platform, record.encoding, record.language, record.id, record.bytes.length, offsets[index]].forEach((value, field) => {
      data.setUint16(6 + index * 12 + field * 2, value);
    });
  });
  if (tags.size) data.setUint16(end, tags.size);
  tagOffsets.forEach(({ index, bytes, offset }) => {
    data.setUint16(end + 2 + index * 4, bytes.length);
    data.setUint16(end + 4 + index * 4, offset);
  });
  for (const { bytes, offset } of strings.values()) output.set(bytes, storage + offset);
  return output;
}

function displayName(records, ids = [16, 1, 21]) {
  for (const id of ids) {
    const candidates = records.filter((record) => record.id === id && record.bytes.length && (record.platform === 0 || record.platform === 3));
    const record = candidates.find(({ platform, language }) => platform === 3 && language === 0x0409) ?? candidates[0];
    if (record) return new TextDecoder('utf-16be').decode(record.bytes);
  }
}

export function transplantIdentity(base, donorFaces) {
  ensure(base.faces.length === donorFaces.length, '请为每个基底字面选择一个供体。');
  const faces = donorFaces.map((source, index) => {
    const baseNames = readNames(base.faces[index].get('name'));
    const donorNames = readNames(source.get('name'));
    const identity = baseNames.filter(({ id }) => identityNameIds.has(id) && (id !== 25 || source.has('fvar')));
    ensure(identity.some(({ id, bytes }) => (id === 1 || id === 16 || id === 21) && bytes.length), '基底缺少可移植的字体家族名。');
    const tables = new Map(source);
    tables.set('name', writeNames([...donorNames.filter(({ id }) => !identityNameIds.has(id)), ...identity]));
    tables.delete('DSIG');
    return tables;
  });
  return {
    bytes: writeFont(faces, base.isCollection),
    isCollection: base.isCollection,
    faceCount: faces.length,
    variableCount: faces.filter((tables) => tables.has('fvar')).length,
  };
}

export function readFont(buffer) {
  const data = new DataView(buffer);
  ensure(data.byteLength >= 12);
  const isCollection = data.getUint32(0) === collection;
  const count = isCollection ? data.getUint32(8) : 1;
  ensure(count > 0 && (!isCollection || 12 + count * 4 <= data.byteLength));
  const faces = Array.from({ length: count }, (_, index) => {
    const offset = isCollection ? data.getUint32(12 + index * 4) : 0;
    ensure(offset + 12 <= data.byteLength);
    const version = data.getUint32(offset);
    ensure(version === truetype || version === 0x74727565, '仅支持 TrueType 轮廓的 TTF/TTC。');
    const size = data.getUint16(offset + 4);
    ensure(size <= 4095 && offset + 12 + size * 16 <= data.byteLength);
    const tables = new Map();
    for (let index = 0; index < size; index++) {
      const record = offset + 12 + index * 16;
      const tag = String.fromCharCode(...new Uint8Array(buffer, record, 4));
      const start = data.getUint32(record + 8);
      const length = data.getUint32(record + 12);
      ensure(start + length <= data.byteLength && !tables.has(tag));
      tables.set(tag, new Uint8Array(buffer, start, length));
    }
    ensure(required.every((tag) => tables.has(tag)));
    ensure(!unsupported.some((tag) => tables.has(tag)), '仅支持单色 TrueType 轮廓。');
    ensure(tables.get('head').length >= 54 && tables.get('maxp').length >= 32 && tables.get('hhea').length >= 36);
    return tables;
  });
  return { isCollection, faces };
}

export function inspectFont(buffer) {
  const { isCollection, faces } = readFont(buffer);
  return { isCollection, variableFaces: faces.map((tables) => tables.has('fvar')), faces: faces.map((tables, index) => {
    try {
      return displayName(readNames(tables.get('name')), [4, 16, 1, 21, 6]) ?? `字面 ${index + 1}`;
    } catch {
      return `字面 ${index + 1}`;
    }
  }) };
}

function checksum(bytes) {
  const data = view(bytes);
  let sum = 0;
  let offset = 0;
  for (; offset + 4 <= bytes.length; offset += 4) sum = (sum + data.getUint32(offset)) >>> 0;
  for (let shift = 24; offset < bytes.length; offset++, shift -= 8) sum = (sum + (bytes[offset] << shift)) >>> 0;
  return sum;
}

export function writeFont(faces, isCollection = false) {
  let cursor = isCollection ? 12 + faces.length * 4 : 0;
  const directories = faces.map((tables) => {
    const offset = cursor;
    cursor += 12 + tables.size * 16;
    return { offset, tables };
  });
  const records = directories.map(({ tables }) => [...tables.keys()].sort().map((tag) => {
    let bytes = tables.get(tag);
    if (tag === 'head') {
      bytes = bytes.slice();
      view(bytes).setUint32(8, 0);
    }
    const offset = cursor;
    cursor += align(bytes.length);
    return { tag, bytes, offset };
  }));
  const result = new Uint8Array(cursor);
  const data = view(result);
  if (isCollection) {
    data.setUint32(0, collection);
    data.setUint32(4, truetype);
    data.setUint32(8, faces.length);
  }
  directories.forEach(({ offset, tables }, index) => {
    if (isCollection) data.setUint32(12 + index * 4, offset);
    const selector = Math.floor(Math.log2(tables.size));
    const searchRange = (2 ** selector) * 16;
    data.setUint32(offset, truetype);
    data.setUint16(offset + 4, tables.size);
    data.setUint16(offset + 6, searchRange);
    data.setUint16(offset + 8, selector);
    data.setUint16(offset + 10, tables.size * 16 - searchRange);
    records[index].forEach((record, tableIndex) => {
      const entry = offset + 12 + tableIndex * 16;
      result.set([...record.tag].map((char) => char.charCodeAt(0)), entry);
      data.setUint32(entry + 4, checksum(record.bytes));
      data.setUint32(entry + 8, record.offset);
      data.setUint32(entry + 12, record.bytes.length);
      result.set(record.bytes, record.offset);
    });
  });
  if (!isCollection) {
    const head = records[0].find(({ tag }) => tag === 'head');
    if (head) data.setUint32(head.offset + 8, (signature - checksum(result)) >>> 0);
  }
  return result;
}

function glyphRecords(tables) {
  const head = view(tables.get('head'));
  const count = view(tables.get('maxp')).getUint16(4);
  const format = head.getInt16(50);
  ensure(format === 0 || format === 1);
  const loca = view(tables.get('loca'));
  const glyf = tables.get('glyf');
  ensure((count + 1) * (format ? 4 : 2) <= loca.byteLength);
  const offsetAt = (index) => format ? loca.getUint32(index * 4) : loca.getUint16(index * 2) * 2;
  return Array.from({ length: count }, (_, index) => {
    const start = offsetAt(index);
    const end = offsetAt(index + 1);
    ensure(start <= end && end <= glyf.length && (end === start || end - start >= 10));
    return glyf.subarray(start, end);
  });
}

function parse(tables) {
  const tags = [...required, 'name'];
  const parseTables = new Map(tags.filter((tag) => tables.has(tag)).map((tag) => [tag, tables.get(tag)]));
  const post = new Uint8Array(32);
  view(post).setUint32(0, 0x00030000);
  parseTables.set('post', post);
  return opentype.parse(writeFont([parseTables]).buffer, { lowMemory: true });
}

const int16 = (value) => value >= -32768 && value <= 32767;

function encode(path, scale, original, leftBearing) {
  const contours = [];
  let contour;
  const add = (x, y, on) => contour.push({ x: Math.round(x * scale), y: Math.round(y * scale), on });
  for (const command of path.commands) {
    if (command.type === 'M') {
      contour = [];
      contours.push(contour);
      add(command.x, command.y, true);
    } else if (command.type === 'L') {
      add(command.x, command.y, true);
    } else if (command.type === 'Q') {
      add(command.x1, command.y1, false);
      add(command.x, command.y, true);
    } else {
      ensure(command.type === 'Z', '检测到非 TrueType 字形轮廓。');
    }
  }
  for (const points of contours) {
    const first = points[0];
    const last = points.at(-1);
    if (points.length > 1 && last.on && last.x === first.x && last.y === first.y) points.pop();
  }
  const points = contours.flat();
  if (!points.length) return { bytes: new Uint8Array(), points: 0, contours: 0 };
  ensure(points.length <= 65535 && contours.length <= 32767, '单个字形的轮廓过于复杂。');
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  for (const point of points) {
    bounds[0] = Math.min(bounds[0], point.x);
    bounds[1] = Math.min(bounds[1], point.y);
    bounds[2] = Math.max(bounds[2], point.x);
    bounds[3] = Math.max(bounds[3], point.y);
  }
  const shift = (original.length ? view(original).getInt16(2) : leftBearing) - bounds[0];
  bounds[0] += shift;
  bounds[2] += shift;
  ensure(bounds.every(int16), '字形尺寸超出 TrueType 范围。');
  const flagStart = 12 + contours.length * 2;
  const xStart = flagStart + points.length;
  const yStart = xStart + points.length * 2;
  const bytes = new Uint8Array(yStart + points.length * 2);
  const data = view(bytes);
  data.setInt16(0, contours.length);
  bounds.forEach((value, index) => data.setInt16(2 + index * 2, value));
  let end = -1;
  contours.forEach((points, index) => {
    end += points.length;
    data.setUint16(10 + index * 2, end);
  });
  let prevX = 0;
  let prevY = 0;
  points.forEach((point, index) => {
    const x = point.x + shift;
    const dx = x - prevX;
    const dy = point.y - prevY;
    ensure(int16(dx) && int16(dy), '字形坐标差超出 TrueType 范围。');
    bytes[flagStart + index] = Number(point.on);
    data.setInt16(xStart + index * 2, dx);
    data.setInt16(yStart + index * 2, dy);
    prevX = x;
    prevY = point.y;
  });
  return { bytes, points: points.length, contours: contours.length };
}

function components(bytes) {
  if (!bytes.length || view(bytes).getInt16(0) >= 0) return [];
  const data = view(bytes);
  const result = [];
  let offset = 10;
  let flags;
  do {
    ensure(offset + 4 <= bytes.length);
    flags = data.getUint16(offset);
    result.push(data.getUint16(offset + 2));
    offset += 4 + (flags & 1 ? 4 : 2) + (flags & 8 ? 2 : flags & 64 ? 4 : flags & 128 ? 8 : 0);
  } while (flags & 32);
  return result;
}

export function replaceGlyphs(baseTables, donorTables) {
  const base = parse(baseTables);
  const donor = parse(donorTables);
  const glyphs = glyphRecords(baseTables);
  const scale = base.unitsPerEm / donor.unitsPerEm;
  ensure(Number.isFinite(scale) && scale > 0);
  const matches = new Map();
  const donorMap = donor.encoding.cmap.glyphIndexMap;
  for (const [code, baseId] of Object.entries(base.encoding.cmap.glyphIndexMap)) {
    const donorId = donorMap[code];
    if (baseId > 0 && baseId < glyphs.length && donorId > 0 && donorId < donor.numGlyphs && !matches.has(baseId)) {
      matches.set(baseId, donorId);
    }
  }
  if (!matches.size) return { tables: baseTables, replaced: 0, kept: glyphs.length };

  const parents = Array.from({ length: glyphs.length }, () => []);
  glyphs.forEach((glyph, index) => {
    for (const child of components(glyph)) {
      ensure(child < glyphs.length);
      parents[child].push(index);
    }
  });
  const affected = new Set(matches.keys());
  for (const id of affected) {
    for (const parent of parents[id]) affected.add(parent);
  }

  const tables = new Map(baseTables);
  const head = tables.get('head').slice();
  const maxp = tables.get('maxp').slice();
  const hhea = tables.get('hhea').slice();
  const headView = view(head);
  const maxpView = view(maxp);
  const hheaView = view(hhea);
  const metrics = view(tables.get('hmtx'));
  const fullMetrics = hheaView.getUint16(34);
  ensure(fullMetrics > 0 && fullMetrics <= glyphs.length && metrics.byteLength >= fullMetrics * 4 + (glyphs.length - fullMetrics) * 2);
  const leftBearing = (id) => metrics.getInt16(id < fullMetrics ? id * 4 + 2 : fullMetrics * 4 + (id - fullMetrics) * 2);
  for (const id of affected) {
    const donorId = matches.get(id);
    const outline = donorId === undefined ? base.glyphs.get(id).path : donor.glyphs.get(donorId).path;
    const encoded = encode(outline, donorId === undefined ? 1 : scale, glyphs[id], leftBearing(id));
    glyphs[id] = encoded.bytes;
    maxpView.setUint16(6, Math.max(maxpView.getUint16(6), encoded.points));
    maxpView.setUint16(8, Math.max(maxpView.getUint16(8), encoded.contours));
  }

  const loca = new Uint8Array((glyphs.length + 1) * 4);
  const locaView = view(loca);
  const glyf = new Uint8Array(glyphs.reduce((total, glyph) => total + align(glyph.length), 0));
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  const horizontal = [Infinity, Infinity, -Infinity];
  let offset = 0;
  glyphs.forEach((glyph, index) => {
    locaView.setUint32(index * 4, offset);
    glyf.set(glyph, offset);
    offset += align(glyph.length);
    if (!glyph.length || view(glyph).getInt16(0) === 0) return;
    const data = view(glyph);
    const minX = data.getInt16(2);
    const maxX = data.getInt16(6);
    const lsb = leftBearing(index);
    const extent = lsb + maxX - minX;
    const advance = metrics.getUint16(Math.min(index, fullMetrics - 1) * 4);
    bounds[0] = Math.min(bounds[0], minX);
    bounds[1] = Math.min(bounds[1], data.getInt16(4));
    bounds[2] = Math.max(bounds[2], maxX);
    bounds[3] = Math.max(bounds[3], data.getInt16(8));
    horizontal[0] = Math.min(horizontal[0], lsb);
    horizontal[1] = Math.min(horizontal[1], advance - extent);
    horizontal[2] = Math.max(horizontal[2], extent);
  });
  locaView.setUint32(glyphs.length * 4, offset);
  bounds.forEach((value, index) => headView.setInt16(36 + index * 2, Number.isFinite(value) ? value : 0));
  horizontal.forEach((value, index) => {
    ensure(!Number.isFinite(value) || int16(value), '替换后的字距超出 TrueType 范围。');
    hheaView.setInt16(12 + index * 2, Number.isFinite(value) ? value : 0);
  });
  headView.setInt16(50, 1);
  for (const tag of invalidated) tables.delete(tag);
  for (const [tag, bytes] of Object.entries({ head, maxp, hhea, loca, glyf })) tables.set(tag, bytes);
  return { tables, replaced: matches.size, kept: glyphs.length - matches.size };
}

export function maskFont(base, donorFaces) {
  ensure(base.faces.length === donorFaces.length, '请为每个基底字面选择一个供体。');
  ensure(!base.faces.some((tables) => tables.has('fvar') || tables.has('gvar')), '可变字体作为基底时，请使用「替换字体身份」模式。');
  const results = base.faces.map((tables, index) => replaceGlyphs(tables, donorFaces[index]));
  return {
    bytes: writeFont(results.map(({ tables }) => tables), base.isCollection),
    isCollection: base.isCollection,
    faceCount: results.length,
    replaced: results.reduce((total, face) => total + face.replaced, 0),
    kept: results.reduce((total, face) => total + face.kept, 0),
  };
}
