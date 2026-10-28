import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';

/* =========================================================
 * 指尖绽放 · Hand Flower（鼠标版）
 *  鼠标移动 → 控制屏幕中的 3D 虚拟手
 *  滚轮/拖动 → 手指逐关节卷曲/张开
 *  手指张合度 → 驱动花朵粒子绽放
 * ========================================================= */

/* ---------------- 全局状态 ---------------- */
const state = {
  bloom: 0,            // 当前绽放度 0(花苞) ~ 1(全开)
  grip: 0,             // 手指张合度 0(张开) ~ 1(握拳)
  gripTarget: 0,
  handX: 0, handY: 0,  // 手掌位置（世界坐标附近）
  pointerX: 0.5, pointerY: 0.5, // 归一化鼠标位置
};

/* ---------------- 渲染器与场景 ---------------- */
const canvas = document.getElementById('stage');
/* ---------------- 移动端性能分档 ---------------- */
const IS_MOBILE = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent)
  || (navigator.maxTouchPoints > 1 && innerWidth < 900);
const PERF = IS_MOBILE ? { px: 1.5, perPetal: 420, dust: 250, sky: 500, stars: 6 }   // 手机档
                       : { px: 2.0, perPetal: 900, dust: 600, sky: 900, stars: 15 }; // 桌面档

const renderer = new THREE.WebGLRenderer({ canvas, antialias: !IS_MOBILE });
renderer.setPixelRatio(Math.min(devicePixelRatio, PERF.px));
renderer.setSize(innerWidth, innerHeight);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#05060f');   // 星空黑
scene.fog = new THREE.FogExp2('#0a0f2a', 0.03);

const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 100);
camera.position.set(0, 1.4, 7.4);
camera.lookAt(0, 0.7, 0);

/* =========================================================
 * 一、3D 虚拟手（简单几何手掌 + 五指三关节）
 * ========================================================= */
const handGroup = new THREE.Group();
handGroup.visible = false;   // 隐形手：保留控制逻辑，不渲染模型
scene.add(handGroup);

const skinMat = new THREE.MeshStandardMaterial({
  color: '#8fb6ff', roughness: 0.45, metalness: 0.15,
  emissive: '#1a2a6e', emissiveIntensity: 0.5,
});
const tipMat = new THREE.MeshStandardMaterial({
  color: '#ffd1e8', roughness: 0.3, metalness: 0.1,
  emissive: '#ff6ea8', emissiveIntensity: 1.6,
});
const jointMat = new THREE.MeshStandardMaterial({
  color: '#a9c4ff', roughness: 0.5,
  emissive: '#2547b8', emissiveIntensity: 0.4,
});

/* 手指定义：根部位置(相对手掌) / 朝向张角 / 长度 / 粗细 */
const FINGERS = [
  { base: [-0.42, 0.15, 0.16], spread: -1.35, len: 0.52, r: 0.085 }, // 拇指
  { base: [-0.21, 0.5, 0],     spread: -0.45, len: 0.78, r: 0.075 }, // 食指
  { base: [0, 0.56, 0],        spread: 0,     len: 0.86, r: 0.08  }, // 中指
  { base: [0.2, 0.5, 0],       spread: 0.45,  len: 0.76, r: 0.075 }, // 无名指
  { base: [0.4, 0.42, 0.02],   spread: 0.9,   len: 0.58, r: 0.07  }, // 小指
];
const SEG_PER_FINGER = 3; // 三段关节

const fingerJoints = [];   // [finger][seg] -> group，用于每帧按 grip 旋转

// 手掌：圆润盒子
const palm = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.9, 0.22, 2, 2, 1), skinMat);
palm.position.set(0, 0, 0);
handGroup.add(palm);
// 手腕
const wrist = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.38, 0.5, 16), skinMat);
wrist.rotation.x = Math.PI / 2;
wrist.position.set(0, -0.62, 0.05);
handGroup.add(wrist);

for (const f of FINGERS) {
  const segs = [];
  let parent = handGroup;
  for (let s = 0; s < SEG_PER_FINGER; s++) {
    const pivot = new THREE.Group();
    // 第一段挂在手掌上，后续段挂在前一段末端
    pivot.position.copy(s === 0 ? new THREE.Vector3(...f.base) : new THREE.Vector3(0, f.len / SEG_PER_FINGER, 0));

    const segMesh = new THREE.Mesh(
      new THREE.CapsuleGeometry(f.r * (1 - s * 0.12), f.len / SEG_PER_FINGER * 0.92, 4, 10),
      s === SEG_PER_FINGER - 1 ? tipMat : skinMat
    );
    segMesh.position.y = f.len / SEG_PER_FINGER / 2;
    pivot.add(segMesh);

    // 关节小球
    if (s > 0) {
      const joint = new THREE.Mesh(new THREE.SphereGeometry(f.r * 1.05, 10, 10), jointMat);
      pivot.add(joint);
    }
    parent.add(pivot);
    parent = pivot;
    segs.push(pivot);
  }
  // 初始张角（手指扇形展开）
  segs[0].rotation.z = -f.spread * 0.55;
  fingerJoints.push(segs);
}

/* 指尖光点精灵（发光提示） */
const tipGlowTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,220,240,1)');
  grad.addColorStop(0.4, 'rgba(255,140,200,0.55)');
  grad.addColorStop(1, 'rgba(255,140,200,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
})();
const tipSprites = [];
for (let fi = 0; fi < fingerJoints.length; fi++) {
  const last = fingerJoints[fi][fingerJoints[fi].length - 1];
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tipGlowTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  spr.scale.setScalar(0.45);
  spr.position.y = FINGERS[fi].len / SEG_PER_FINGER; // 该段末端 = 指尖
  last.add(spr);
  tipSprites.push(spr);
}

/* ---------------- 手指驱动：grip 0(张开)~1(握拳) ----------------
 * 每个关节按比例卷曲；不同手指相位略有差异，更自然。
 */
function applyGrip(g) {
  for (let fi = 0; fi < FINGERS.length; fi++) {
    const segs = fingerJoints[fi];
    const phase = fi * 0.06;                       // 手指依次卷曲
    const gg = THREE.MathUtils.clamp(g * 1.15 - phase, 0, 1);
    for (let s = 0; s < segs.length; s++) {
      // 每关节弯曲约 0~95°，越靠指尖弯得越多
      const bend = gg * (0.9 + s * 0.35);
      // 绕手掌局部 Z 轴卷曲（手指朝 +Y 时，绕 Z 正向 = 向掌心弯）
      segs[s].rotation.x = 0;
      if (s === 0) {
        segs[s].rotation.z = -FINGERS[fi].spread * 0.55 * (1 - gg * 0.8); // 握拳时手指收拢
      }
      // 弯曲表达为绕局部 X 轴的旋转（段朝 +Y）
      segs[s].rotateX(bend);
    }
  }
}

/* =========================================================
 * 二、粒子花朵（保留：GLSL 花苞⇄绽放形变）
 * ========================================================= */
const PETALS = 14;
const PER_PETAL = PERF.perPetal;
const COUNT = PETALS * PER_PETAL;

const positions = new Float32Array(COUNT * 3);
const aPetal = new Float32Array(COUNT);
const aT     = new Float32Array(COUNT);
const aW     = new Float32Array(COUNT);
const aRand  = new Float32Array(COUNT);

for (let i = 0; i < COUNT; i++) {
  const p = i % PETALS;
  aPetal[i] = p + (Math.random() - 0.5) * 0.06;
  aT[i] = Math.pow(Math.random(), 0.8);
  aW[i] = (Math.random() * 2 - 1) * Math.sin(aT[i] * Math.PI) ** 0.7;
  aRand[i] = Math.random();
}

const geo = new THREE.BufferGeometry();
geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
geo.setAttribute('aPetal', new THREE.BufferAttribute(aPetal, 1));
geo.setAttribute('aT',     new THREE.BufferAttribute(aT, 1));
geo.setAttribute('aW',     new THREE.BufferAttribute(aW, 1));
geo.setAttribute('aRand',  new THREE.BufferAttribute(aRand, 1));

const uniforms = {
  uTime:       { value: 0 },
  uBloom:      { value: 0 },
  uPixelRatio: { value: Math.min(devicePixelRatio, PERF.px) },
  uSize:       { value: 34 * Math.min(devicePixelRatio, PERF.px) },
  uHandX:      { value: 0 },
  uHandY:      { value: 0 },
};

const vertexShader = /* glsl */`
  uniform float uTime;
  uniform float uBloom;
  uniform float uPixelRatio;
  uniform float uSize;
  uniform float uHandX;
  uniform float uHandY;

  attribute float aPetal;
  attribute float aT;
  attribute float aW;
  attribute float aRand;

  varying float vT;
  varying float vRand;

  void main() {
    float bloom = clamp(uBloom, 0.0, 1.0);

    float petalAngle = aPetal / float(${PETALS}.0) * 6.2831853;
    float openAngle = mix(0.12, 1.15, bloom);
    openAngle += sin(uTime * 0.6 + aRand * 6.28) * 0.05;

    float t = aT;
    float len = mix(0.35, 1.9 + aRand * 0.25, bloom);
    float width = aW * mix(0.06, 0.42, bloom) * (1.0 - t * 0.55);

    vec3 local;
    local.x = width;
    float arc = sin(t * 1.35) * mix(0.15, 0.9, bloom);
    /* 下垂：绽放后期瓣尖因重力向下弯（y 随 t 高次衰减转负） */
    float droop = bloom * bloom * pow(t, 2.6) * 1.35;
    local.y = t * len * cos(openAngle) + arc * t - droop;
    local.z = t * len * sin(openAngle);
    local.y += width * width * mix(1.5, 5.0, bloom) * 0.35;
    local.x += sin(uTime * 1.4 + aPetal * 2.2) * t * t * mix(0.01, 0.09, bloom);

    vec3 dir = vec3(sin(petalAngle), 0.0, cos(petalAngle));
    vec3 up  = vec3(0.0, 1.0, 0.0);
    vec3 side = normalize(cross(up, dir));
    vec3 world = side * local.x + up * local.y + dir * local.z;

    vec3 bud;
    // 合并花苞：aT = 沿苞身高度，petalAngle 直接作苞壁周向角 → 14 瓣粒子拼成一枚连续尖椭球
    float yy = mix(-0.35, 0.95, t);
    float taper = sin(clamp(t * 3.14159, 0.0, 3.14159));
    float br2 = 0.012 + 0.075 * taper;
    float ang = petalAngle + aW * 0.15;
    bud.x = cos(ang) * br2;
    bud.z = sin(ang) * br2;
    bud.y = yy;

    vec3 pos = mix(bud, world, smoothstep(0.0, 1.0, bloom));
    pos += 0.02 * vec3(
      sin(uTime * 1.7 + aRand * 40.0),
      cos(uTime * 1.3 + aRand * 30.0),
      sin(uTime * 2.1 + aRand * 50.0)
    ) * (0.4 + bloom);

    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mv;

    float sz = uSize * (0.35 + t * 0.9) * (0.7 + aRand * 0.6);
    sz *= mix(0.75, 1.0, bloom);
    gl_PointSize = sz * uPixelRatio / -mv.z;

    vT = t;
    vRand = aRand;
  }
`;

const fragmentShader = /* glsl */`
  uniform float uBloom;

  varying float vT;
  varying float vRand;

  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv);
    float alpha = smoothstep(0.5, 0.05, d);
    if (alpha < 0.02) discard;

    vec3 core = vec3(1.0, 0.75, 0.35);
    vec3 petal = vec3(1.0, 0.45, 0.72);
    vec3 tip   = vec3(0.72, 0.55, 1.0);
    vec3 col = mix(core, petal, smoothstep(0.05, 0.35, vT));
    col = mix(col, tip, smoothstep(0.5, 1.0, vT));
    col += uBloom * 0.25;
    float star = step(0.985, vRand);
    col = mix(col, vec3(1.0), star);

    gl_FragColor = vec4(col, alpha * (0.55 + uBloom * 0.45));
  }
`;
const flowerMat = new THREE.ShaderMaterial({
  uniforms,
  vertexShader,
  fragmentShader,
  transparent: true,
  depthWrite: true,                   // 深度写入：后芯被前瓣遮挡，透视正确
  blending: THREE.AdditiveBlending,   // 星空黑背景恢复发光混合
});
/* ---------------- 整株植物工厂：花 + 茎 + 土 + 叶 + 星星一体 ----------------
 * 所有花共用 geo/starGeo/flowerMat/starMat（uniform 相同），
 * 绽放与旋转遵循统一原则：由全局 uBloom 与 spinSpeed 驱动。
 */
function createPlant(scale = 1) {
  const g = new THREE.Group();

  const flowerPts = new THREE.Points(geo, flowerMat);
  flowerPts.position.set(0, 2.2, 0);
  g.add(flowerPts);

  // 发光曲线茎（整根无接缝，顶插花苞内）
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, -0.9, 0),
    new THREE.Vector3(0.05 * scale, 0.15, 0),
    new THREE.Vector3(-0.04 * scale, 1.3, 0),
    new THREE.Vector3(0, 2.25, 0),
  ]);
  const stemM = new THREE.Mesh(new THREE.TubeGeometry(curve, 48, 0.038 * scale, 10), stemMat);
  g.add(stemM);
  const glowM = new THREE.Mesh(new THREE.TubeGeometry(curve, 48, 0.095 * scale, 10), stemGlowMat);
  g.add(glowM);

  // 土堆
  const soilM = new THREE.Mesh(soilGeo, soilMat);
  soilM.rotation.x = Math.PI;
  soilM.position.set(0, -0.86, 0);
  g.add(soilM);

  // 叶子
  const l1 = makeLeaf(scale); l1.position.set(0.16, -0.45, 0); l1.rotation.z = -0.5;
  const l2 = makeLeaf(scale); l2.position.set(0.16, 0.05, 0);  l2.rotation.z = 0.45;
  l1.position.y += 0; l2.position.y += 0;
  g.add(l1); g.add(l2);

  // 星星
  const starsPts = new THREE.Points(starGeo, starMat);
  starsPts.position.set(0, 2.2, 0);
  g.add(starsPts);

  g.scale.setScalar(scale);
  // 缩放会把"本地 -0.9 的根"抬到 -0.9*scale，这里补回来让根始终落在草坪面(-0.9)
  g.position.y = -0.9 * (1 - scale);
  return g;
}

/* 种植：主花 + 卫星花 —— 延后调用（见下方 plantAll），避免 const 未初始化 */
let plant = null;
let satellites = [];

/* ---------------- 工厂用的共享材质与几何 ---------------- */
const stemMat = new THREE.MeshStandardMaterial({
  color: '#2e7d32', roughness: 0.55, metalness: 0,
  emissive: '#39ff9c', emissiveIntensity: 0.55,   // 发光茎
});
const stemGlowMat = new THREE.MeshBasicMaterial({
  color: '#66ffb0', transparent: true, opacity: 0.16,
  blending: THREE.AdditiveBlending, depthWrite: false,
});
const soilGeo = new THREE.SphereGeometry(0.34, 16, 12, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
const soilMat = new THREE.MeshStandardMaterial({ color: '#5a4030', roughness: 1 });
const leafMat = new THREE.MeshStandardMaterial({ color: '#4da03f', roughness: 0.7 });
function makeLeaf(scale = 1) {
  const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 8), leafMat);
  leaf.scale.set(2.4, 0.5, 1.0).multiplyScalar(scale);
  return leaf;
}

/* ---------------- 旋转星星花蕊（几何与着色器，主花卫星花共用） ----------------
/* ---------------- 透明月亮 ----------------
 * 半透明发光月盘挂在左上角天空，柔和光晕。
 */
const moonGroup = new THREE.Group();
const moonTex = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d');
  // 月面本体：乳白渐变
  const grad = g.createRadialGradient(256, 240, 40, 256, 256, 250);
  grad.addColorStop(0, 'rgba(255,252,240,1)');
  grad.addColorStop(0.55, 'rgba(250,245,225,0.92)');
  grad.addColorStop(0.85, 'rgba(235,228,205,0.55)');
  grad.addColorStop(1, 'rgba(220,215,195,0)');
  g.fillStyle = grad;
  g.beginPath(); g.arc(256, 256, 250, 0, Math.PI * 2); g.fill();
  // 陨石坑（半透明暗斑，低调）
  g.fillStyle = 'rgba(180,175,155,0.25)';
  const craters = [[190,170,38],[300,210,26],[240,320,30],[330,300,18],[165,275,20]];
  for (const [x, y, r] of craters) { g.beginPath(); g.arc(x, y, r, 0, Math.PI*2); g.fill(); }
  return new THREE.CanvasTexture(c);
})();
const moon = new THREE.Sprite(new THREE.SpriteMaterial({
  map: moonTex, transparent: true, opacity: 0.9,
  blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false,
  fog: false,
}));
moon.scale.setScalar(4.2);
moonGroup.add(moon);
// 月晕（大圈淡光）
const moonHalo = new THREE.Sprite(new THREE.SpriteMaterial({
  map: (() => {
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(128, 128, 20, 128, 128, 128);
    grad.addColorStop(0, 'rgba(255,250,230,0.5)');
    grad.addColorStop(0.5, 'rgba(255,245,210,0.14)');
    grad.addColorStop(1, 'rgba(255,245,210,0)');
    g.fillStyle = grad; g.fillRect(0, 0, 256, 256);
    return new THREE.CanvasTexture(c);
  })(),
  transparent: true, opacity: 0.75,
  blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false,
  fog: false,
}));
moonHalo.scale.setScalar(8);
moonGroup.add(moonHalo);
// 固定在相机视野左上（远距离，不受场景转动影响）
moonGroup.position.set(-9, 7.5, -18);
scene.add(moonGroup);

/* ---------------- 花茎：单根发光曲线管，从土里直通花头 ----------------
 * 用一条样条曲线 + TubeGeometry 生成整根茎——没有分段、没有接缝，
 * 顶端 (0, 2.25) 直接插进花苞内部（花头 y=2.2，苞底 world 1.85）。
 */
/* ---------------- 夜空繁星背景 ---------------- */
const STARS = PETALS * PERF.stars;
const sPetal = new Float32Array(STARS);
const sRand  = new Float32Array(STARS);
const sSize  = new Float32Array(STARS);
const sPos   = new Float32Array(STARS * 3);
for (let i = 0; i < STARS; i++) {
  sPetal[i] = Math.floor(Math.random() * PETALS) + Math.random() * 0.06;
  sRand[i] = Math.random();
  sSize[i] = 26 + Math.random() * 30;
}
const starGeo = new THREE.BufferGeometry();
starGeo.setAttribute('position', new THREE.BufferAttribute(sPos, 3));
starGeo.setAttribute('aPetal', new THREE.BufferAttribute(sPetal, 1));
starGeo.setAttribute('aRand',  new THREE.BufferAttribute(sRand, 1));
starGeo.setAttribute('aSize',  new THREE.BufferAttribute(sSize, 1));

const starUniforms = {
  uTime: uniforms.uTime,
  uBloom: uniforms.uBloom,
  uPixelRatio: uniforms.uPixelRatio,
  uHandX: uniforms.uHandX,
  uHandY: uniforms.uHandY,
};
/* 星星着色器（字符串提取，主花与卫星花共用） */
const starVert = /* glsl */`
    uniform float uTime; uniform float uBloom;
    uniform float uPixelRatio;
    attribute float aPetal; attribute float aRand; attribute float aSize;
    varying float vSpin; varying float vRand;
    void main() {
      float bloom = clamp(uBloom, 0.0, 1.0);
      float petalAngle = aPetal / float(${PETALS}.0) * 6.2831853;
      float openAngle = mix(0.12, 1.15, bloom) + sin(uTime * 0.6 + aRand * 6.28) * 0.05;
      float len = mix(0.35, 1.9 + aRand * 0.25, bloom);
      float arc = sin(1.35) * mix(0.15, 0.9, bloom);
      vec3 local;
      local.x = 0.0;
      float droop = bloom * bloom * pow(1.0, 2.6) * 1.35;
      local.y = len * cos(openAngle) + arc - droop;
      local.z = len * sin(openAngle);
      vec3 dir = vec3(sin(petalAngle), 0.0, cos(petalAngle));
      vec3 up = vec3(0.0, 1.0, 0.0);
      vec3 side = normalize(cross(up, dir));
      vec3 world = side * local.x + up * local.y + dir * local.z;

      vec3 bud;
      float ba = aRand * 6.2831853;
      bud.x = cos(ba) * 0.07; bud.z = sin(ba) * 0.07; bud.y = 0.9;
      vec3 pos = mix(bud, world, smoothstep(0.0, 1.0, bloom));
      pos += 0.02 * vec3(sin(uTime*1.7+aRand*40.0), cos(uTime*1.3+aRand*30.0), sin(uTime*2.1+aRand*50.0)) * (0.4+bloom);

      vec4 mv = modelViewMatrix * vec4(pos, 1.0);
      gl_Position = projectionMatrix * mv;
      gl_PointSize = aSize * uPixelRatio * mix(0.6, 1.0, bloom) * (5.0 / -mv.z);
      vSpin = uTime * (1.2 + aRand * 2.4) * (aRand > 0.5 ? 1.0 : -1.0);
      vRand = aRand;
    }
  `;
const starFrag = /* glsl */`
    varying float vSpin; varying float vRand;
    void main() {
      vec2 uv = gl_PointCoord - 0.5;
      float r = length(uv);
      if (r > 0.5) discard;
      float theta = atan(uv.y, uv.x) + vSpin;
      float lobe = pow(abs(cos(2.5 * theta)), 0.55);
      float starR = 0.10 + 0.38 * lobe;
      float d = r - starR;
      float body = smoothstep(0.02, -0.01, d);
      float core = smoothstep(0.14, 0.0, r);
      float a = body * 0.9 + core * 0.9;
      if (a < 0.03) discard;
      vec3 c1 = vec3(1.0, 0.85, 0.45);
      vec3 c2 = vec3(0.75, 0.6, 1.0);
      vec3 col = mix(c1, c2, vRand) + core * 0.6;
      gl_FragColor = vec4(col, a);
    }
  `;
const starMat = new THREE.ShaderMaterial({
  uniforms: starUniforms,
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  vertexShader: starVert,
  fragmentShader: starFrag,
});

/* ---------------- 种植：所有资源就绪后再种 ---------------- */
function plantAll() {
  plant = createPlant(1.0);
  scene.add(plant);

  const SATELLITES = 7;
  for (let i = 0; i < SATELLITES; i++) {
    const a = (i / SATELLITES) * Math.PI * 2 + 0.35;      // 环形分布
    const r = 1.6 + (i % 2) * 0.3;                        // 草坪内圈种植，远离边缘
    const s = createPlant(0.5);
    s.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
    s.rotation.y = Math.random() * Math.PI * 2;           // 随机朝向
    scene.add(s);
    satellites.push({ g: s });
  }
}
plantAll();

/* ---------------- 夜空繁星背景 ---------------- */
const skyGeo = new THREE.BufferGeometry();
const SKY = PERF.sky;
const skyPos = new Float32Array(SKY * 3);
const skyRand = new Float32Array(SKY);
for (let i = 0; i < SKY; i++) {
  // 远处球壳上半部分，包裹整个场景
  const r = 30 + Math.random() * 15;
  const theta = Math.random() * Math.PI * 2;
  const phi = Math.acos(Math.random() * 0.95);      // 偏上半球
  skyPos[i * 3 + 0] = r * Math.sin(phi) * Math.cos(theta);
  skyPos[i * 3 + 1] = r * Math.cos(phi) - 2;
  skyPos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
  skyRand[i] = Math.random();
}
skyGeo.setAttribute('position', new THREE.BufferAttribute(skyPos, 3));
skyGeo.setAttribute('aRand', new THREE.BufferAttribute(skyRand, 1));
const skyMat = new THREE.ShaderMaterial({
  uniforms: { uTime: uniforms.uTime, uPixelRatio: uniforms.uPixelRatio },
  vertexShader: /* glsl */`
    uniform float uTime; uniform float uPixelRatio;
    attribute float aRand;
    varying float vTw;
    void main() {
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * mv;
      gl_PointSize = (0.8 + aRand * 2.4) * uPixelRatio;
      // 闪烁：不同相位与速度
      vTw = 0.35 + 0.65 * (0.5 + 0.5 * sin(uTime * (0.8 + aRand * 2.5) + aRand * 60.0));
    }
  `,
  fragmentShader: /* glsl */`
    varying float vTw;
    void main() {
      vec2 uv = gl_PointCoord - 0.5;
      float a = smoothstep(0.5, 0.0, length(uv));
      vec3 col = mix(vec3(0.75, 0.82, 1.0), vec3(1.0, 0.95, 0.8), step(0.8, vTw));
      gl_FragColor = vec4(col, a * vTw);
    }
  `,
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
});
const skyStars = new THREE.Points(skyGeo, skyMat);
skyStars.frustumCulled = false;   // 球壳太大，禁用剔除防闪没
scene.add(skyStars);

/* ---------------- 流星 ----------------
 * 每颗流星 = 拉长的渐变轨迹面片，随机时间/角度划过夜空。
 */
const meteorGroup = new THREE.Group();
scene.add(meteorGroup);
const METEOR_COUNT = 4;
const meteors = [];
{
  // 轨迹贴图：白头渐隐尾
  const c = document.createElement('canvas');
  c.width = 256; c.height = 8;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 256, 0);
  grad.addColorStop(0, 'rgba(255,255,255,0)');
  grad.addColorStop(0.75, 'rgba(180,210,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,1)');
  g.fillStyle = grad; g.fillRect(0, 0, 256, 8);
  const meteorTex = new THREE.CanvasTexture(c);

  for (let i = 0; i < METEOR_COUNT; i++) {
    const mat = new THREE.SpriteMaterial({
      map: meteorTex, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const spr = new THREE.Sprite(mat);
    spr.scale.set(6, 0.22, 1);   // 长条轨迹
    meteorGroup.add(spr);
    meteors.push({
      spr,
      active: false,
      t: 0,            // 飞行进度 0~1
      duration: 1.2 + Math.random() * 0.8,
      start: new THREE.Vector3(),
      vel: new THREE.Vector3(),
      nextAt: 1 + Math.random() * 5,   // 首次出现时间（秒）
    });
  }
}
function launchMeteor(m, now) {
  m.active = true;
  m.t = 0;
  // 起点：高空随机一侧，向斜下方飞行
  const side = Math.random() > 0.5 ? 1 : -1;
  m.start.set(side * (10 + Math.random() * 8), 12 + Math.random() * 8, -12 - Math.random() * 6);
  m.vel.set(-side * (14 + Math.random() * 8), -(7 + Math.random() * 4), 0);
  m.spr.position.copy(m.start);
  m.spr.material.rotation = Math.atan2(m.vel.y, m.vel.x);   // 轨迹对准飞行方向
  m.nextAt = now + 4 + Math.random() * 7;   // 下一次
}

/* ---------------- 环境星尘 ---------------- */
const dustGeo = new THREE.BufferGeometry();
const DUST = PERF.dust;
const dustPos = new Float32Array(DUST * 3);
const dustRand = new Float32Array(DUST);
for (let i = 0; i < DUST; i++) {
  const r = 4 + Math.random() * 6;
  const a = Math.random() * Math.PI * 2;
  dustPos[i * 3 + 0] = Math.cos(a) * r;
  dustPos[i * 3 + 1] = (Math.random() - 0.3) * 6;
  dustPos[i * 3 + 2] = Math.sin(a) * r;
  dustRand[i] = Math.random();
}
dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
dustGeo.setAttribute('aRand', new THREE.BufferAttribute(dustRand, 1));
const dustMat = new THREE.ShaderMaterial({
  uniforms: { uTime: uniforms.uTime, uPixelRatio: uniforms.uPixelRatio },
  vertexShader: /* glsl */`
    uniform float uTime; uniform float uPixelRatio;
    attribute float aRand;
    varying float vA;
    void main() {
      vec3 p = position;
      p.y += sin(uTime * 0.4 + aRand * 40.0) * 0.4;
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      gl_Position = projectionMatrix * mv;
      gl_PointSize = (1.2 + aRand * 2.2) * uPixelRatio * (6.0 / -mv.z);
      vA = 0.25 + 0.55 * (0.5 + 0.5 * sin(uTime * (0.6 + aRand) + aRand * 20.0));
    }
  `,
  fragmentShader: /* glsl */`
    varying float vA;
    void main() {
      vec2 uv = gl_PointCoord - 0.5;
      float a = smoothstep(0.5, 0.0, length(uv));
      gl_FragColor = vec4(0.62, 0.72, 1.0, a * vA * 0.5);
    }
  `,
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
});
scene.add(new THREE.Points(dustGeo, dustMat));

/* ---------------- 草坪地面（月夜色调，有厚度的土台） ---------------- */
// 草坪改为圆柱土台：顶面草绿 + 侧面泥土色，花真正"种在土里"
const LAWN_R = 4.2;
const lawn = new THREE.Mesh(
  new THREE.CylinderGeometry(LAWN_R, LAWN_R * 1.05, 0.5, 64),
  [
    new THREE.MeshStandardMaterial({ color: '#3f7a38', roughness: 0.95 }),  // 侧面：深草土
    new THREE.MeshStandardMaterial({ color: '#4a8f40', roughness: 0.9 }),   // 顶面：草绿
    new THREE.MeshStandardMaterial({ color: '#3a6e30', roughness: 1 }),     // 底面
  ]
);
lawn.position.y = -1.15;   // 顶面在 -0.9
scene.add(lawn);
// 草坪顶面内圈月光高光
const glow2 = new THREE.Mesh(
  new THREE.CircleGeometry(2.2, 48),
  new THREE.MeshBasicMaterial({
    color: '#549648', transparent: true, opacity: 0.45,
    depthWrite: false,
  })
);
glow2.rotation.x = -Math.PI / 2;
glow2.position.y = -0.895;
scene.add(glow2);

/* ---------------- 灯光（月夜感） ---------------- */
scene.add(new THREE.AmbientLight('#8a9bd4', 0.5));
const key = new THREE.DirectionalLight('#cdd8ff', 0.9);
key.position.set(4, 8, 5);
scene.add(key);
const rim = new THREE.PointLight('#ff9ecb', 0.7, 14);
rim.position.set(-3, 2.5, 3);
scene.add(rim);

/* =========================================================
 * 三、鼠标/触摸输入（滑动版）
 *  - 上下滑动 → 绽放度（上=绽开 下=闭合）
 *  - 左右滑动 → 旋转速度（右=加速 左=减速/反转）
 *  - 滑动越快，值变化越快（速度映射）
 * ========================================================= */
let dragging = false;
let lastX = 0, lastY = 0, lastT = 0;
let dragVelY = 0;    // 纵向滑动速度（用于增益）

const state2 = {
  spinSpeed: 0.12,        // 当前旋转速度（rad/s），可被左右滑动调整
  spinTarget: 0.12,
};

addEventListener('pointerdown', (e) => {
  dragging = true;
  lastX = e.clientX; lastY = e.clientY; lastT = performance.now();
  dragVelY = 0;
});
addEventListener('pointermove', (e) => {
  state.pointerX = e.clientX / innerWidth;
  state.pointerY = e.clientY / innerHeight;
  if (!dragging) return;

  const now = performance.now();
  const dx = e.clientX - lastX;
  const dy = e.clientY - lastY;
  const dt = Math.max(now - lastT, 1);
  // 像素/毫秒 → 归一化滑动速度
  dragVelY = Math.abs(dy) / dt;

  // 1) 纵向 → 绽放度：滑动越快，grip 变化越大（增益 0.6~2.4）
  const gainY = 1.2 + Math.min(1.2, dragVelY * 1.6);
  state.gripTarget = THREE.MathUtils.clamp(
    state.gripTarget + (dy / innerHeight) * gainY, 0, 1
  );

  // 2) 横向 → 旋转速度：左滑=向左转加速，右滑=向右转加速
  //    反向滑动时给 3 倍增益，让转向立即跟随手势（不用慢慢经过 0）
  const gainX = 1.0 + Math.min(1.4, (Math.abs(dx) / dt) * 1.2);
  let spinDelta = (dx / innerWidth) * gainX * 2.2;
  if (spinDelta * state2.spinTarget < 0) spinDelta *= 3;   // 反向踢一脚
  state2.spinTarget = THREE.MathUtils.clamp(
    state2.spinTarget + spinDelta, -3, 3
  );

  lastX = e.clientX; lastY = e.clientY; lastT = now;
});
addEventListener('pointerup', () => { dragging = false; });
addEventListener('pointercancel', () => { dragging = false; });
// 触摸设备同样生效（pointer events 已覆盖），防止触摸滚动
addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });

/* ---------------- 双指捏合缩放视角（手机） ---------------- */
let pinchDist = 0;
const camBase = new THREE.Vector3(0, 1.4, 7.4);
let camZoom = 1;   // 0.55(拉近) ~ 1.6(拉远)
addEventListener('touchstart', (e) => {
  if (e.touches.length === 2) {
    dragging = false;
    pinchDist = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY
    );
  }
}, { passive: false });
addEventListener('touchmove', (e) => {
  if (e.touches.length === 2 && pinchDist > 0) {
    e.preventDefault();
    const d = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY
    );
    camZoom = THREE.MathUtils.clamp(camZoom * (pinchDist / d), 0.55, 1.6);
    pinchDist = d;
  }
}, { passive: false });
addEventListener('touchend', () => { pinchDist = 0; });

// 滚轮保留：上下滚 = 绽放度
addEventListener('wheel', (e) => {
  e.preventDefault();
  state.gripTarget = THREE.MathUtils.clamp(state.gripTarget + e.deltaY * 0.0009, 0, 1);
}, { passive: false });

/* 双击：自动演示 开→合→开 */
let demoTimer = null;
addEventListener('dblclick', () => {
  if (demoTimer) return;
  const t0 = performance.now();
  demoTimer = setInterval(() => {
    const t = (performance.now() - t0) / 2600;
    if (t >= 1) { clearInterval(demoTimer); demoTimer = null; return; }
    state.gripTarget = Math.sin(t * Math.PI);
  }, 30);
});

/* ---------------- 渲染循环 ---------------- */
const meterFill = document.getElementById('meterFill');
const statusText = document.getElementById('statusText');
const clock = new THREE.Clock();

function tick() {
  const dt = Math.min(clock.getDelta(), 0.05);
  uniforms.uTime.value += dt;

  // 1) 手指张合平滑（滑动响应快：速率随滑动速度自适应已体现在 target 上）
  state.grip += (state.gripTarget - state.grip) * Math.min(1, dt * 8);
  applyGrip(state.grip);

  // 2) 绽放度 = 1 - 张合度（张开手→绽放）
  state.bloom = 1 - state.grip;
  uniforms.uBloom.value = state.bloom;

  // 2.5) 旋转速度平滑（左右滑动调整）
  state2.spinSpeed += (state2.spinTarget - state2.spinSpeed) * Math.min(1, dt * 4);

  // 2.7) 双指缩放视角平滑应用
  camera.position.set(0, 1.4 * camZoom, 7.4 * camZoom);
  camera.lookAt(0, 0.7, 0);

  // 3) 手掌跟随鼠标（世界坐标），手指张合时手掌略微后移
  const hx = (state.pointerX - 0.5) * 5.2;
  const hy = -(state.pointerY - 0.5) * 3.2 + 0.7;
  state.handX += (hx - state.handX) * Math.min(1, dt * 5);
  state.handY += (hy - state.handY) * Math.min(1, dt * 5);
  handGroup.position.set(-2.1 + state.handX * 0.55, state.handY, 1.2);
  handGroup.rotation.y = -0.35 - state.handX * 0.08;
  handGroup.rotation.z = state.grip * 0.15;

  // 4) 花心跟随手掌（轻交互）
  uniforms.uHandX.value = ((-2.1 + state.handX * 0.55) - 1.6) * 0.12;
  uniforms.uHandY.value = (state.handY - 0.7) * 0.1;

  // 5) 指尖光点强度随张合变化（隐形手时跳过）
  if (handGroup.visible) {
    tipSprites.forEach(s => { s.material.opacity = 0.35 + state.bloom * 0.65; });
  }

  // 6) 统一旋转原则：主花与 7 朵卫星花同速公转，星星同步
  // createPlant 子物体顺序: 0花 1茎 2光晕 3土 4叶 5叶 6星星
  const mainFlower = plant.children[0];
  const mainStars = plant.children[6];
  mainFlower.rotation.y += dt * state2.spinSpeed;
  mainStars.rotation.y = mainFlower.rotation.y;
  for (const sat of satellites) {
    const f = sat.g.children[0];
    f.rotation.y += dt * state2.spinSpeed;      // 花
    sat.g.children[6].rotation.y = f.rotation.y; // 星星
  }

  // 6.2) 整株风摆（plant 组整体，茎花永不分离）
  plant.rotation.z = Math.sin(uniforms.uTime.value * 0.9) * 0.045;
  plant.rotation.x = Math.cos(uniforms.uTime.value * 0.7) * 0.03;

  // 6.5) 流星调度与飞行
  for (const m of meteors) {
    if (!m.active && uniforms.uTime.value >= m.nextAt) {
      launchMeteor(m, uniforms.uTime.value);
    }
    if (m.active) {
      m.t += dt / m.duration;
      if (m.t >= 1) {
        m.active = false;
        m.spr.material.opacity = 0;
      } else {
        m.spr.position.copy(m.start).addScaledVector(m.vel, m.t * m.duration);
        // 头亮尾隐 + 起止淡入淡出
        const fade = Math.sin(m.t * Math.PI);
        m.spr.material.opacity = 0.9 * fade;
      }
    }
  }

  // 6) HUD（极简：底部细进度条 + 状态）
  meterFill.style.width = (state.bloom * 100).toFixed(0) + '%';
  statusText.textContent = state.grip > 0.6 ? '✊'
                        : state.grip > 0.25 ? '🤏'
                        : '🌸';

  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

/* ---------------- 自适应 ---------------- */
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  uniforms.uPixelRatio.value = Math.min(devicePixelRatio, PERF.px);
  uniforms.uSize.value = 34 * uniforms.uPixelRatio.value;
});

/* ---------------- 启动 ---------------- */
tick();

// 加载完成：淡出加载层，弹操作提示 3.5 秒
requestAnimationFrame(() => requestAnimationFrame(() => {
  const loader = document.getElementById('loader');
  if (loader) loader.classList.add('done');
  const tip = document.getElementById('tip');
  if (tip) {
    tip.classList.add('show');
    setTimeout(() => tip.classList.remove('show'), 3500);
  }
}));

// 微信/移动浏览器：页面隐藏时暂停渲染，省电防发烫
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clock.stop();
  } else {
    clock.start();
  }
});
