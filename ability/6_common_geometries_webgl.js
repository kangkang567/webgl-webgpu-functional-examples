/**
 * 功能简介: WebGL 程序化几何体 —— 球 / 平面 / 圆环, 并顺带生成配套的 UV 与法线
 * 作者: deepseek编写, wangweikang手动修改整理
 * 时间: 2026.10.28
 *
 * 与 2_phonglight_webgl.js / 5_image_texture_webgl.js 的差别:
 *   ① 顶点数据不再手写, 而是由函数「算」出来: 球、平面、圆环各一个生成函数
 *   ② 每个顶点同时产出 位置(vec3) / 法线(vec3) / 纹理坐标(vec2) 三份数据, 一一对应
 *   ③ 一个渲染程序 + 三份顶点数据, 每帧用不同的模型矩阵连续画三次（同一套着色器）
 *
 * 为什么要生成几何体:
 *   立方体是手写的 36 个顶点, 但球面上千个顶点, 手写不现实;
 *   而且「位置 / 法线 / UV」三者必须彼此匹配, 交给函数统一生成才不会错位。
 *   法线决定光照, UV 决定贴图, 所以这份数据后面光照、阴影、贴图都能直接用。
 *
 * 怎么看出 UV 是对的:
 *   片元着色器不贴图, 而是用 UV 画棋盘格 —— 球的两极会收拢、圆环会绕着管子缠一圈,
 *   平面是规整的方格; 哪块纹理被拉歪了, 一眼就能看出来。
 */

import { multiply, perspective, rotationX, rotationY, translation } from '../utils/mat4.js';
import { showError } from '../utils/page-status.js';

// ---------- 1. 获取canvas元素 - 浏览器环境三维渲染基于canvas标签实现 ----------
const canvas = document.querySelector('#scene');
const apiStat = document.querySelector('#stat-api');
const sizeStat = document.querySelector('#stat-size');
// 本页有渲染循环, FPS 读数有效
const fpsStat = document.querySelector('#stat-fps');

try {
  main();
} catch (error) {
  console.error(error);
  showError(error.message);
}

function main() {
  // ---------- 2. 创建 WebGL 上下文 ----------
  const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
  if (!gl) throw new Error('当前浏览器不支持 WebGL。');

  // ---------- 3. 着色器源码（GLSL ES 1.00，WebGL 1 / 2 通用） ----------
  // 顶点着色器: 同时接收 位置 / 法线 / UV 三个属性
  // 几何体的形状只由 aPosition 决定, 换个生成函数就换一个形状, 着色器一行都不用改
  const vertexSource = /* glsl */ `
    attribute vec3 aPosition;
    attribute vec3 aNormal;
    attribute vec2 aUv;

    uniform mat4 uMvp;          // 投影 × 视图 × 模型
    uniform mat4 uModel;        // 模型矩阵: 把顶点从模型空间搬到世界空间
    uniform mat3 uNormalMatrix; // 法线矩阵: 模型矩阵左上角 3x3（纯旋转时可直接用）

    varying vec3 vWorldPosition;
    varying vec3 vNormal;
    varying vec2 vUv;

    void main() {
      vec4 worldPosition = uModel * vec4(aPosition, 1.0);
      vWorldPosition = worldPosition.xyz;
      // 法线是从几何生成函数里算出来的, 它和位置一样要跟着模型矩阵一起转
      vNormal = uNormalMatrix * aNormal;
      vUv = aUv;
      gl_Position = uMvp * vec4(aPosition, 1.0);
    }
  `;

  // 片元着色器: Phong 光照 + 用 UV 画棋盘格（替代贴图, 方便检查 UV 有没有被拉歪）
  const fragmentSource = /* glsl */ `
    precision mediump float;

    uniform vec3 uColor;             // 棋盘格颜色 A
    uniform vec3 uCheckerColor;      // 棋盘格颜色 B
    uniform float uUvScale;          // 棋盘格密度: UV 的 0~1 被切成多少格
    uniform vec3 uLightColor;        // 光源颜色
    uniform vec3 uLightPosition;     // 光源位置（世界空间）
    uniform vec3 uCameraPosition;    // 相机位置（世界空间），算高光要用
    uniform vec3 uAmbientColor;      // 环境光颜色
    uniform float uShininess;        // 高光锐利度
    uniform float uSpecularStrength; // 高光强度

    varying vec3 vWorldPosition;
    varying vec3 vNormal;
    varying vec2 vUv;

    void main() {
      // ① 用 UV 决定这一格是 A 色还是 B 色: floor 把 UV 切成格子, 格子坐标之和的奇偶交替
      vec2 cell = floor(vUv * uUvScale);
      float isOdd = mod(cell.x + cell.y, 2.0);
      vec3 baseColor = mix(uColor, uCheckerColor, isOdd);

      vec3 N = normalize(vNormal);                          // 法线（决定明暗的关键）
      vec3 L = normalize(uLightPosition - vWorldPosition);  // 指向光源
      vec3 V = normalize(uCameraPosition - vWorldPosition); // 指向相机

      // ② 环境光
      vec3 ambient = uAmbientColor * baseColor;

      // ③ 漫反射: 球面、圆环上的法线是逐点变化的, 所以明暗过渡是平滑的
      float diffuseFactor = max(dot(N, L), 0.0);
      vec3 diffuse = baseColor * uLightColor * diffuseFactor;

      // ④ 镜面高光（Phong）
      vec3 R = reflect(-L, N);
      float specularFactor = pow(max(dot(R, V), 0.0), uShininess);
      vec3 specular = uLightColor * uSpecularStrength * specularFactor;

      gl_FragColor = vec4(ambient + diffuse + specular, 1.0);
    }
  `;

  // ---------- 4. 创建着色器对象与渲染程序 ----------
  const program = createProgram(gl, vertexSource, fragmentSource);
  gl.useProgram(program);

  // ---------- 5. 生成三份几何体数据 ----------
  // 三个生成函数的返回值结构一致: { positions, normals, uvs }
  // 三份数组的长度比 = 3 : 3 : 2（每个顶点 3 个位置分量、3 个法线分量、2 个 UV 分量）
  const sphere = createSphere(1.3, 24, 32);
  const plane = createPlane(16, 16, 12);
  const torus = createTorus(1.0, 0.4, 40, 20);

  // 上传属性数据的五步: ①创 ②绑 ③传 ④格 ⑤激（位置 / 法线 / UV 各来一遍）
  // 注意: 三种几何体共用同一个渲染程序, 属性位置是同一套, 但缓冲区要各建各的
  function uploadGeometry(geometry) {
    function uploadAttribute(name, data, components) {
      const location = gl.getAttribLocation(program, name);
      const buffer = gl.createBuffer();                                       // ①创
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);                                 // ②绑
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);  // ③传
      gl.vertexAttribPointer(location, components, gl.FLOAT, false, 0, 0);     // ④格
      gl.enableVertexAttribArray(location);                                   // ⑤激
      return buffer;
    }

    return {
      positionBuffer: uploadAttribute('aPosition', geometry.positions, 3),
      normalBuffer: uploadAttribute('aNormal', geometry.normals, 3),
      uvBuffer: uploadAttribute('aUv', geometry.uvs, 2),
      vertexCount: geometry.positions.length / 3,
    };
  }

  const meshes = {
    sphere: uploadGeometry(sphere),
    plane: uploadGeometry(plane),
    torus: uploadGeometry(torus),
  };

  // 三种几何体共享同一套 attribute location, 但缓冲区不同:
  // 每次绘制前必须把该几何体的缓冲区重新绑上并重新指定「怎么取数据」, 否则会拿到上一个几何体的顶点
  function bindMesh(mesh) {
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.positionBuffer);
    gl.vertexAttribPointer(gl.getAttribLocation(program, 'aPosition'), 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.normalBuffer);
    gl.vertexAttribPointer(gl.getAttribLocation(program, 'aNormal'), 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.uvBuffer);
    gl.vertexAttribPointer(gl.getAttribLocation(program, 'aUv'), 2, gl.FLOAT, false, 0, 0);
  }

  // ---------- 6. 光照参数与 uniform 位置 ----------
  const LIGHT_COLOR = [1.0, 1.0, 1.0];       // 白色光源
  const LIGHT_POSITION = [5.0, 7.0, 6.0];    // 光源放在物体右上前方
  const AMBIENT_COLOR = [0.16, 0.18, 0.22];  // 环境光偏冷, 让背光面有层次
  const SHININESS = 40.0;                    // 高光锐利度
  const SPECULAR_STRENGTH = 0.8;             // 高光强度

  const mvpLocation = gl.getUniformLocation(program, 'uMvp');
  const modelLocation = gl.getUniformLocation(program, 'uModel');
  const normalMatrixLocation = gl.getUniformLocation(program, 'uNormalMatrix');
  const colorLocation = gl.getUniformLocation(program, 'uColor');
  const checkerColorLocation = gl.getUniformLocation(program, 'uCheckerColor');
  const uvScaleLocation = gl.getUniformLocation(program, 'uUvScale');
  const lightColorLocation = gl.getUniformLocation(program, 'uLightColor');
  const lightPositionLocation = gl.getUniformLocation(program, 'uLightPosition');
  const cameraPositionLocation = gl.getUniformLocation(program, 'uCameraPosition');
  const ambientColorLocation = gl.getUniformLocation(program, 'uAmbientColor');
  const shininessLocation = gl.getUniformLocation(program, 'uShininess');
  const specularStrengthLocation = gl.getUniformLocation(program, 'uSpecularStrength');

  // 不随重绘变化的光照参数, 传一次即可
  gl.uniform3fv(lightColorLocation, LIGHT_COLOR);
  gl.uniform3fv(lightPositionLocation, LIGHT_POSITION);
  gl.uniform3fv(ambientColorLocation, AMBIENT_COLOR);
  gl.uniform1f(shininessLocation, SHININESS);
  gl.uniform1f(specularStrengthLocation, SPECULAR_STRENGTH);

  // ---------- 7. 相机与投影 ----------
  const fov = (45 * Math.PI) / 180;
  const CAMERA_DISTANCE = 9.5;
  const CAMERA_PITCH = 0.34; // 相机向下俯视的角度, 让平面铺在画面下半部分
  const view = multiply(translation(0, 0, -CAMERA_DISTANCE), rotationX(CAMERA_PITCH));
  // 相机世界坐标: view = T(0,0,-d) · Rx(pitch), 反解出相机位置
  const CAMERA_POSITION = [
    0,
    CAMERA_DISTANCE * Math.sin(CAMERA_PITCH),
    CAMERA_DISTANCE * Math.cos(CAMERA_PITCH),
  ];

  let projection; // 只在 resize() 里按当前画布宽高比生成

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2); // 高 DPI 也清晰，同时限制开销
    const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const height = Math.max(1, Math.round(canvas.clientHeight * dpr));

    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    gl.viewport(0, 0, width, height);
    projection = perspective(fov, width / height, 0.1, 100);
    if (sizeStat) sizeStat.textContent = `${width} × ${height}`;
    // 渲染循环每帧都会重画, 这里不必手动 render()
  }

  // ---------- 8. 三个物体的材质与摆放 ----------
  // 同一套着色器, 只靠 uniform 区分材质; 同一份顶点数据, 只靠模型矩阵区分位置与朝向
  const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

  const materials = {
    plane: { color: [0.32, 0.35, 0.40], checkerColor: [0.24, 0.26, 0.30], uvScale: 16.0 },
    sphere: { color: [0.36, 0.55, 1.00], checkerColor: [0.80, 0.88, 1.00], uvScale: 10.0 },
    torus: { color: [1.00, 0.52, 0.30], checkerColor: [1.00, 0.82, 0.50], uvScale: 18.0 },
  };

  // 模型矩阵只有旋转和平移（没有缩放）, 所以法线矩阵就是左上角 3x3
  // （若含非等比缩放, 必须用左上角 3x3 的逆转置, 否则法线会被拉歪）
  function extractNormalMatrix(model) {
    return new Float32Array([
      model[0], model[1], model[2],
      model[4], model[5], model[6],
      model[8], model[9], model[10],
    ]);
  }

  let viewProjection; // 每帧算一次, 三个物体共用

  // 画一个几何体 = 绑定它的顶点数据 + 传它自己的矩阵和材质 + 绘制
  function drawMesh(mesh, model, material) {
    bindMesh(mesh);
    gl.uniformMatrix4fv(mvpLocation, false, multiply(viewProjection, model));
    gl.uniformMatrix4fv(modelLocation, false, model);
    gl.uniformMatrix3fv(normalMatrixLocation, false, extractNormalMatrix(model));
    gl.uniform3fv(colorLocation, material.color);
    gl.uniform3fv(checkerColorLocation, material.checkerColor);
    gl.uniform1f(uvScaleLocation, material.uvScale);
    gl.drawArrays(gl.TRIANGLES, 0, mesh.vertexCount);
  }

  // ---------- 9. 动画状态 ----------
  const SPHERE_SPIN = 0.45; // 球每秒绕 Y 转的角度（球本身对称, 转起来看到的是 UV 在走）
  const TORUS_SPIN = 0.9;   // 圆环转快一点, 能看清管截面的法线在变
  let sphereAngle = 0; // 球的自转角度
  let torusAngle = 0;  // 圆环的自转角度
  let lastTime = 0;

  // FPS 统计: 每 0.5 秒结算一次
  let frameCount = 0;
  let elapsed = 0;

  // ---------- 10. 每帧绘制 ----------
  function render() {
    // 状态设置
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST); // 三个物体互相遮挡, 必须有深度测试

    gl.uniform3fv(cameraPositionLocation, CAMERA_POSITION);
    viewProjection = multiply(projection, view);

    // ① 平面: 生成时就在 XZ 平面上, 法线朝 +Y, 不用转
    drawMesh(meshes.plane, IDENTITY, materials.plane);

    // ② 球: 先绕 Y 自转, 再平移到左边 —— 矩阵相乘的顺序是「右边的先作用」
    const sphereModel = multiply(translation(-2.9, 1.3, 0), rotationY(sphereAngle));
    drawMesh(meshes.sphere, sphereModel, materials.sphere);

    // ③ 圆环: 先绕 X 立起来, 再绕 Y 自转, 最后平移到右边
    //    createTorus 生成的圆环是「平躺」在 XZ 面上的, 绕 X 转 90° 才立起来正对相机
    //    立起来后又歪了 0.35 弧度, 最低点大约在中心下方 1.34 处（R+r 投影得到的极值）,
    //    所以中心抬到 1.4, 底部刚好离平面 0.06, 不会穿进平面
    const torusModel = multiply(
      translation(2.9, 1.4, 0),
      multiply(rotationY(torusAngle), rotationX(Math.PI / 2 - 0.35)),
    );
    drawMesh(meshes.torus, torusModel, materials.torus);
  }

  // ---------- 11. 渲染循环: requestAnimationFrame 驱动 ----------
  function frame(now) {
    if (lastTime === 0) lastTime = now;
    // 切到后台再回来时时间差可能很大, 截断到 0.1s, 避免物体「瞬移」
    const delta = Math.min((now - lastTime) / 1000, 0.1);
    lastTime = now;

    // 用时间增量推进角度, 与帧率无关
    sphereAngle += SPHERE_SPIN * delta;
    torusAngle += TORUS_SPIN * delta;

    render();

    frameCount++;
    elapsed += delta;
    if (elapsed >= 0.5) {
      if (fpsStat) fpsStat.textContent = String(Math.round(frameCount / elapsed));
      frameCount = 0;
      elapsed = 0;
    }

    requestAnimationFrame(frame);
  }

  // ---------- 12. 页面状态钩子 ----------
  if (apiStat) apiStat.textContent = 'WebGL';

  resize();
  window.addEventListener('resize', resize);
  document.body.classList.add('is-ready');

  requestAnimationFrame(frame);
}

/* =============== 几何体生成函数 =============== */

// 统一的三角形绕序约定: 从物体外部看过去, 三个顶点是「逆时针」的
// 三个函数都按这个约定输出非索引的三角形列表（每 3 个顶点组成一个三角形, 可直接 drawArrays）

/**
 * 球（经纬球）
 * 用两个角度把球面切成网格: theta 从 0(北极) 到 π(南极), phi 从 0 绕一圈到 2π
 * @param {number} radius 半径
 * @param {number} latBands 纬度分段（南北方向切几刀）
 * @param {number} longBands 经度分段（绕一圈切几刀）
 */
function createSphere(radius, latBands, longBands) {
  const positions = [];
  const normals = [];
  const uvs = [];

  // 一个球面点 = 生成位置 + 法线 + UV, 三者同时产出, 保证彼此匹配
  function push(theta, phi) {
    const sinTheta = Math.sin(theta);
    const cosTheta = Math.cos(theta);
    const sinPhi = Math.sin(phi);
    const cosPhi = Math.cos(phi);

    // 球面上的单位方向向量: 球心在原点, 所以它同时就是该点的法线
    const nx = sinTheta * cosPhi;
    const ny = cosTheta;
    const nz = sinTheta * sinPhi;

    positions.push(nx * radius, ny * radius, nz * radius);
    normals.push(nx, ny, nz);
    // u 沿经度走(绕一圈 0→1); v 沿纬度走, 取 1 - theta/π 让北极在上方(v=1), 贴图不会上下颠倒
    uvs.push(phi / (2 * Math.PI), 1 - theta / Math.PI);
  }

  for (let i = 0; i < latBands; i++) {
    const theta0 = (i / latBands) * Math.PI;
    const theta1 = ((i + 1) / latBands) * Math.PI;

    for (let j = 0; j < longBands; j++) {
      const phi0 = (j / longBands) * 2 * Math.PI;
      const phi1 = ((j + 1) / longBands) * 2 * Math.PI;

      // 四边形 p00-p01-p11-p10 拆成两个三角形; 顶点顺序决定正面朝向, 反了就会被当成背面
      // 两极处的三角形会退化成一条线, 但不影响绘制（面积为零的三角形不产生像素）
      push(theta0, phi0); push(theta0, phi1); push(theta1, phi1);
      push(theta0, phi0); push(theta1, phi1); push(theta1, phi0);
    }
  }

  return { positions, normals, uvs };
}

/**
 * 平面（XZ 平面上的正方形, 法线朝 +Y）
 * 平铺在 y = 0 上, 可以直接当地面用, 所以不需要额外的模型旋转
 * @param {number} width X 方向尺寸
 * @param {number} depth Z 方向尺寸
 * @param {number} segments 每个方向切几段
 */
function createPlane(width, depth, segments) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const halfW = width / 2;
  const halfD = depth / 2;

  function push(x, z) {
    positions.push(x, 0, z);
    normals.push(0, 1, 0);             // 平面处处朝上, 所有顶点法线相同
    uvs.push((x + halfW) / width, (z + halfD) / depth); // 把位置线性映射到 0~1
  }

  for (let i = 0; i < segments; i++) {
    const x0 = -halfW + (i / segments) * width;
    const x1 = -halfW + ((i + 1) / segments) * width;

    for (let j = 0; j < segments; j++) {
      const z0 = -halfD + (j / segments) * depth;
      const z1 = -halfD + ((j + 1) / segments) * depth;

      push(x0, z0); push(x0, z1); push(x1, z1);
      push(x0, z0); push(x1, z1); push(x1, z0);
    }
  }

  return { positions, normals, uvs };
}

/**
 * 圆环（甜甜圈）
 * 两个角度: u 绕主圆一圈(决定走到环上的哪一段), v 绕管截面一圈(决定在管子上的哪一块)
 * @param {number} majorRadius 主半径: 环心到管心的距离
 * @param {number} minorRadius 管半径: 管子本身的粗细
 * @param {number} radialSegments 主圆方向的分段
 * @param {number} tubularSegments 管截面方向的分段
 */
function createTorus(majorRadius, minorRadius, radialSegments, tubularSegments) {
  const positions = [];
  const normals = [];
  const uvs = [];

  function push(u, v) {
    const cosU = Math.cos(u);
    const sinU = Math.sin(u);
    const cosV = Math.cos(v);
    const sinV = Math.sin(v);

    // 管心到原点的距离: 主半径加上截面圆的投影
    const ring = majorRadius + minorRadius * cosV;

    positions.push(ring * cosU, minorRadius * sinV, ring * sinU);
    // 法线从管心出发指向管面, 不需要减圆心再归一化: 它本身就是单位向量
    normals.push(cosV * cosU, sinV, cosV * sinU);
    // u 沿主圆, v 沿管截面: 贴图会像一条带子一样绕着管子缠满整圈
    uvs.push(u / (2 * Math.PI), v / (2 * Math.PI));
  }

  for (let i = 0; i < radialSegments; i++) {
    const u0 = (i / radialSegments) * 2 * Math.PI;
    const u1 = ((i + 1) / radialSegments) * 2 * Math.PI;

    for (let j = 0; j < tubularSegments; j++) {
      const v0 = (j / tubularSegments) * 2 * Math.PI;
      const v1 = ((j + 1) / tubularSegments) * 2 * Math.PI;

      push(u0, v0); push(u0, v1); push(u1, v1);
      push(u0, v0); push(u1, v1); push(u1, v0);
    }
  }

  return { positions, normals, uvs };
}

/* =============== 着色器与程序 =============== */

function createShader(gl, type, source) {
  // 1. 创建着色器
  const shader = gl.createShader(type);
  // 2. 将着色器代码绑定到着色器对象
  gl.shaderSource(shader, source);
  // 3. 编译着色器代码
  gl.compileShader(shader);
  // 4. 检查着色器代码是否报错
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`着色器编译失败：\n${log}`);
  }
  return shader;
}

function createProgram(gl, vertexSource, fragmentSource) {
  const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentSource);

  // 1. 创建渲染对象, 一个渲染对象表示一个完整的渲染流程
  const program = gl.createProgram();
  // 2. 将上面创建好的着色器放入渲染对象中
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  // 3. 链接渲染程序, 检查顶点着色器与片元着色器之间的传值是否报错
  gl.linkProgram(program);
  // 4. 检查渲染对象链接是否成功
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`程序链接失败：\n${log}`);
  }
  return program;
}
