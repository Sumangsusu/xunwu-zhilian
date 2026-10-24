// ==================== 校园地图组件（自绘 SVG，不依赖外网地图服务） ====================
// 坐标空间统一为 viewBox 0 0 1000 700，发布选点与热力图共用，保证前后端坐标一致。

const CAMPUS_MAP_W = 1000;
const CAMPUS_MAP_H = 700;

// 校园功能区（矩形区域），x/y 为左上角，w/h 为宽高
const CAMPUS_ZONES = [
  { name: '行政楼', x: 80, y: 40, w: 160, h: 100 },
  { name: '图书馆', x: 320, y: 40, w: 200, h: 120 },
  { name: '教学楼A座', x: 600, y: 40, w: 160, h: 100 },
  { name: '教学楼B座', x: 790, y: 40, w: 160, h: 100 },
  { name: '超市', x: 80, y: 220, w: 150, h: 90 },
  { name: '食堂', x: 290, y: 210, w: 190, h: 110 },
  { name: '艺术楼', x: 560, y: 210, w: 170, h: 110 },
  { name: '校医院', x: 790, y: 210, w: 140, h: 90 },
  { name: '保卫处', x: 80, y: 420, w: 140, h: 90 },
  { name: '学生公寓', x: 280, y: 400, w: 240, h: 140 },
  { name: '体育馆', x: 580, y: 400, w: 160, h: 110 },
  { name: '操场', x: 790, y: 390, w: 170, h: 140 },
  { name: '校车站牌', x: 80, y: 560, w: 140, h: 80 },
  { name: '校门', x: 280, y: 570, w: 160, h: 90 },
  { name: '湖畔花园', x: 560, y: 560, w: 200, h: 110 }
];

const CAMPUS_ZONE_COLORS = {
  '行政楼': '#E8EAF6', '图书馆': '#E3F2FD', '教学楼A座': '#E8EAF6', '教学楼B座': '#E8EAF6',
  '艺术楼': '#F3E5F5', '超市': '#FFF3E0', '食堂': '#FFF8E1', '校医院': '#FFEBEE',
  '保卫处': '#ECEFF1', '学生公寓': '#E8F5E9', '体育馆': '#E0F7FA', '操场': '#F1F8E9',
  '校车站牌': '#FFFDE7', '校门': '#EDE7F6', '湖畔花园': '#E0F2F1'
};

// 生成校园底图 SVG（含 id=mapOverlay 的叠加层，供选点标记 / 热力点绘制）
function campusMapMarkup() {
  const roads = `
    <rect x="0" y="180" width="1000" height="26" rx="6" fill="#D5DCE6"/>
    <rect x="0" y="360" width="1000" height="26" rx="6" fill="#D5DCE6"/>
    <rect x="260" y="0" width="26" height="700" rx="6" fill="#D5DCE6"/>
    <rect x="540" y="0" width="26" height="700" rx="6" fill="#D5DCE6"/>
    <rect x="770" y="0" width="26" height="700" rx="6" fill="#D5DCE6"/>`;

  const zones = CAMPUS_ZONES.map((z) => {
    const cx = z.x + z.w / 2;
    const cy = z.y + z.h / 2;
    const color = CAMPUS_ZONE_COLORS[z.name] || '#F1F5F9';
    return `<g class="campus-zone" data-zone="${z.name}" data-cx="${cx}" data-cy="${cy}">
      <rect x="${z.x}" y="${z.y}" width="${z.w}" height="${z.h}" rx="14" fill="${color}" stroke="#B7C0CE" stroke-width="2"/>
      <text x="${cx}" y="${cy + 2}" text-anchor="middle" fill="#334155" font-size="21" font-weight="600">${z.name}</text>
    </g>`;
  }).join('');

  return `<svg class="campus-map-svg w-full h-auto" viewBox="0 0 ${CAMPUS_MAP_W} ${CAMPUS_MAP_H}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">
    <rect width="${CAMPUS_MAP_W}" height="${CAMPUS_MAP_H}" fill="#EDF2EC"/>
    ${roads}
    ${zones}
    <g id="mapOverlay"></g>
  </svg>`;
}

// 判断坐标落在哪个区域
function campusZoneAt(x, y) {
  return CAMPUS_ZONES.find((z) => x >= z.x && x <= z.x + z.w && y >= z.y && y <= z.y + z.h) || null;
}

// 将浏览器点击坐标转换为 SVG viewBox 坐标
function campusSvgPoint(svgEl, clientX, clientY) {
  const ctm = svgEl.getScreenCTM();
  if (!ctm) return null;
  const pt = svgEl.createSVGPoint();
  pt.x = clientX;
  pt.y = clientY;
  const p = pt.matrixTransform(ctm.inverse());
  return { x: Math.round(p.x), y: Math.round(p.y) };
}