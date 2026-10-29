/**
 * 功能简介: WebGL 面剔除 + 最便宜的调试辅助（坐标轴 / 地面网格）
 * 作者: deepseek编写, wangweikang手动修改整理
 * 时间: 2026.10.28
 *
 * 操作:
 *   鼠标: 左键拖动=旋转观察, 右键拖动=平移, 滚轮=缩放, 双击=复位视角
 *   键盘: 1=背面剔除  2=正面剔除  3=关闭剔除  F=翻转正面绕序  R=复位视角
 *
 * 与 6_common_geometries_webgl.js 的差别:
 *   ① 不再堆几何体, 而是把「剔除」这个开关单独拎出来看
 *   ② 同一份立方体顶点数据, 用「6 个索引」的差别造出一个单面片, 专门验证绕序
 *   ③ 多一个「线」渲染程序, 专门画坐标轴和地面网格 —— 最便宜的空间参照物
 *
 * 面剔除为什么最便宜:
 *   它发生在光栅化之前。被剔除的三角形不进片元着色器、不写颜色也不写深度,
 *   等于凭空少画一半三角形, 一行 gl.enable(gl.CULL_FACE) 就可能换回接近两倍的填充率。
 *   代价是: 三角形绕序必须正确 —— 单面几何体绕序反了, 就整片消失。
 *
 * 场景里两样东西, 各自对应一个知识点:
 *   · 左边: 完整的封闭立方体（逆时针绕序）。背面剔除时它是实心的;
 *     正面剔除时近侧墙面被剔掉, 于是能透过它看到内部远侧的墙面 —— 这就是「看模型内部」的用法。
 *   · 右边: 从同一份顶点数据里只取 +Z 面的 6 个索引拼成单面片, 并把绕序反转。
 *     背面剔除时它整片消失（一片都不剩）; 关闭剔除或正面剔除时才出现。
 *     封闭物体不会「整块消失」, 只会变成透视; 想验证绕序, 单面片最直观。
 *
 * 默认是「关闭剔除」: 两个物体都在, 按 1 打开背面剔除, 右边那块立刻消失。
 */

import { multiply, perspective, rotationX, rotationY, translation } from '../utils/mat4.js';
import { showError } from '../utils/page-status.js';

// ---------- 1. 获取canvas元素 - 浏览器环境三维渲染基于canvas标签实现 ----------
const canvas = document.querySelector('#scene');
const apiStat = document.querySelector('#stat-api');
const sizeStat = document.querySelector('#stat-size');
// 本页有持续渲染循环, FPS 读数有效
const fpsStat = document.querySelector('#stat-fps');

// 操作说明面板: 由脚本自己创建, 换成其它示例脚本时不会留下本页的按键说明
const helpPanel = createHelpPanel();

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
  // 物体着色器: 一个平行光做基础明暗, 让立方体的三个可见面能分出层次
  // 面剔除是纯状态开关, 着色器里一行都不用写 —— 被剔除的三角形根本到不了这里
  const meshVertexSource = /* glsl */ `
    attribute vec3 aPosition;
    attribute vec3 aNormal;

    uniform mat4 uMvp;
    uniform mat3 uNormalMatrix;

    varying vec3 vNormal;

    void main() {
      vNormal = uNormalMatrix * aNormal;
      gl_Position = uMvp * vec4(aPosition, 1.0);
    }
  `;

  const meshFragmentSource = /* glsl */ `
    precision mediump float;

    uniform vec3 uColor;           // 物体固有色
    uniform vec3 uLightDirection;  // 平行光方向（世界空间, 指向光源）
    uniform float uAmbient;        // 环境光比重, 保证背光面不是纯黑

    varying vec3 vNormal;

    void main() {
      vec3 N = normalize(vNormal);
      float diffuse = max(dot(N, normalize(uLightDirection)), 0.0);
      gl_FragColor = vec4(uColor * (uAmbient + (1.0 - uAmbient) * diffuse), 1.0);
    }
  `;

  // 调试辅助线着色器: 位置 + 颜色, 画网格和坐标轴
  // 线图元 LINES 没有「正面」的概念, 所以永远不会被面剔除影响
  const lineVertexSource = /* glsl */ `
    attribute vec3 aPosition;
    attribute vec3 aColor;

    uniform mat4 uMvp;

    varying vec3 vColor;

    void main() {
      vColor = aColor;
      gl_Position = uMvp * vec4(aPosition, 1.0);
    }
  `;

  const lineFragmentSource = /* glsl */ `
    precision mediump float;

    varying vec3 vColor;

    void main() {
      gl_FragColor = vec4(vColor, 1.0);
    }
  `;

  // ---------- 4. 创建两个渲染程序 ----------
  const meshProgram = createProgram(gl, meshVertexSource, meshFragmentSource);
  const lineProgram = createProgram(gl, lineVertexSource, lineFragmentSource);

  // ---------- 5. 立方体数据: 一份顶点, 配两套索引 ----------
  // 顶点位置/法线是共享的, 唯一差别在索引 —— 这样「绕序」就是前后对比的唯一变量
  const CUBE_HALF_SIZE = 0.7;
  const cube = buildCube(CUBE_HALF_SIZE);

  gl.useProgram(meshProgram);
  const positionAttr = uploadAttribute(gl, meshProgram, 'aPosition', cube.positions, 3);
  const normalAttr = uploadAttribute(gl, meshProgram, 'aNormal', cube.normals, 3);

  // 立方体的 36 个索引: 每个三角形从外面看都是逆时针, 所以正面朝外（WebGL 默认 frontFace = CCW）
  const cubeIndexBuffer = uploadIndices(gl, cube.indices);

  // 单面片: 只取第一个面（+Z 面）的 6 个索引, 再反转绕序
  // 顶点还是那 24 个, 索引只用到 6 个 —— 面剔除是按三角形判断的, 少几个索引就少几片三角形
  const panelIndexBuffer = uploadIndices(gl, reverseWinding(cube.indices.slice(0, 6)));

  // ---------- 6. 物体着色器的 uniform ----------
  const LIGHT_DIRECTION = [0.45, 0.8, 0.55]; // 平行光方向（指向光源）
  const AMBIENT = 0.35;

  const mvpLocation = gl.getUniformLocation(meshProgram, 'uMvp');
  const normalMatrixLocation = gl.getUniformLocation(meshProgram, 'uNormalMatrix');
  const colorLocation = gl.getUniformLocation(meshProgram, 'uColor');
  const lightDirectionLocation = gl.getUniformLocation(meshProgram, 'uLightDirection');
  const ambientLocation = gl.getUniformLocation(meshProgram, 'uAmbient');

  // 不随物体变化的参数传一次即可（uniform 值挂在程序对象上, 切换程序再切回来还在）
  gl.uniform3fv(lightDirectionLocation, LIGHT_DIRECTION);
  gl.uniform1f(ambientLocation, AMBIENT);

  // ---------- 7. 调试辅助: 坐标轴 + 地面网格 ----------
  // 网格间距 0.5, 覆盖 ±6; 坐标轴长度就是网格半径, Y 轴单独向上伸 2.5
  const GRID_HALF_SIZE = 6;
  const GRID_STEP = 0.5;
  const AXIS_Y_LENGTH = 2.5;
  const debugLines = buildDebugLines(GRID_HALF_SIZE, GRID_STEP, AXIS_Y_LENGTH);

  const linePositionAttr = uploadAttribute(gl, lineProgram, 'aPosition', debugLines.positions, 3);
  const lineColorAttr = uploadAttribute(gl, lineProgram, 'aColor', debugLines.colors, 3);
  const lineMvpLocation = gl.getUniformLocation(lineProgram, 'uMvp');
  const lineVertexCount = debugLines.positions.length / 3;

  // ---------- 8. 相机与投影 ----------
  // 轨道相机: yaw/pitch/distance/target 四个量就能重建任意视角, 方便绕到背面看剔除效果
  const FOV = (45 * Math.PI) / 180;
  const NEAR = 0.1;
  const FAR = 100;
  const camera = {
    yaw: 0,
    pitch: 0.32,
    distance: 8.5,
    target: [0, 0.8, 0],
  };

  const PITCH_LIMIT = Math.PI / 2 - 0.02;
  const MIN_DISTANCE = 2.5;
  const MAX_DISTANCE = 20;
  const ROTATE_SPEED = 0.006;
  const ZOOM_SPEED = 0.0015;

  let projection; // 只在 resize() 里按当前画布宽高比生成

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  // V = T(0,0,-d) · Rx(pitch) · Ry(-yaw) · T(-target)，写法与 4_camera_control_webgl.js 完全一致
  function buildView() {
    return multiply(
      translation(0, 0, -camera.distance),
      multiply(
        rotationX(camera.pitch),
        multiply(
          rotationY(-camera.yaw),
          translation(-camera.target[0], -camera.target[1], -camera.target[2])
        )
      )
    );
  }

  function resetCamera() {
    camera.yaw = 0;
    camera.pitch = 0.32;
    camera.distance = 8.5;
    camera.target = [0, 0.8, 0];
  }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const height = Math.max(1, Math.round(canvas.clientHeight * dpr));

    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    gl.viewport(0, 0, width, height);
    projection = perspective(FOV, width / height, NEAR, FAR);
    if (sizeStat) sizeStat.textContent = `${width} × ${height}`;
    // 渲染循环每帧都会重画, 这里不必手动 render()
  }

  // ---------- 9. 剔除状态: 三种模式 + 正面绕序定义 ----------
  // 注意 cullFace / frontFace 都是「上下文全局状态」, 一旦设置, 之后所有 draw 都按它执行,
  // 与当前用哪个着色器程序无关 —— 所以只需要在切换时改一次, 不用每帧重设。
  const CULL_STATES = [
    { label: 'BACK', enabled: true, mode: gl.BACK, desc: '背面剔除: 立方体是实心的, 右边反转绕序的单面片整片消失' },
    { label: 'FRONT', enabled: true, mode: gl.FRONT, desc: '正面剔除: 立方体近侧墙面被剔掉, 能看到内部; 单面片反而出现' },
    { label: 'OFF', enabled: false, mode: gl.BACK, desc: '关闭剔除: 正反面都画, 两个物体都在（默认状态）' },
  ];

  let cullStateIndex = 2;
  let frontFaceIsCCW = true;

  function applyCullState() {
    const state = CULL_STATES[cullStateIndex];

    if (state.enabled) {
      gl.enable(gl.CULL_FACE); // 打开剔除
      gl.cullFace(state.mode); // 剔除哪一面: BACK（默认）或 FRONT
    } else {
      gl.disable(gl.CULL_FACE);
    }

    // 正面绕序: CCW = 逆时针算正面（WebGL 默认）, CW = 顺时针算正面
    gl.frontFace(frontFaceIsCCW ? gl.CCW : gl.CW);

    updateApiStat();
    updateHelpHighlight();
    console.info(`[cullFace] ${state.desc}${frontFaceIsCCW ? '' : '（正面绕序已翻转为 CW）'}`);
  }

  function updateApiStat() {
    if (!apiStat) return;
    apiStat.textContent = `WebGL · ${CULL_STATES[cullStateIndex].label}${frontFaceIsCCW ? '' : '·CW'}`;
  }

  // 让面板上的按键跟着当前状态高亮, 用户一眼能看出哪个模式生效
  function updateHelpHighlight() {
    helpPanel.cullKeys.forEach((key, index) => {
      if (key) key.classList.toggle('is-active', index === cullStateIndex);
    });
    if (helpPanel.flipKey) helpPanel.flipKey.classList.toggle('is-active', !frontFaceIsCCW);
  }

  // ---------- 10. 每帧绘制 ----------
  let viewProjection; // 每帧算一次, 线框和两个物体共用

  function render() {
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);

    viewProjection = multiply(projection, buildView());

    // ① 调试辅助线: 网格和坐标轴只是空间参照物, 便宜到几乎不占性能
    drawDebugLines();

    // ② 左边: 完整的封闭立方体, 逆时针绕序, 绕 Y 轴自转
    gl.useProgram(meshProgram);
    drawMesh(cubeIndexBuffer, cube.indices.length, multiply(translation(-1.7, 0.7, 0), rotationY(spinAngle)), [0.36, 0.55, 1.0]);
    // ③ 右边: 单面片（同一个 +Z 面, 但绕序反了）, 和立方体前表面共面
    //    它的模型矩阵只有平移; 顶点本身就在 z = +0.7 的平面上, 所以正好贴在同一深度
    drawMesh(panelIndexBuffer, 6, translation(1.7, 0.7, 0), [1.0, 0.62, 0.3]);
  }

  function drawMesh(indexBuffer, indexCount, model, color) {
    bindAttribute(gl, positionAttr);
    bindAttribute(gl, normalAttr);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);

    gl.uniformMatrix4fv(mvpLocation, false, multiply(viewProjection, model));
    gl.uniformMatrix3fv(normalMatrixLocation, false, extractNormalMatrix(model));
    gl.uniform3fv(colorLocation, color);

    gl.drawElements(gl.TRIANGLES, indexCount, gl.UNSIGNED_SHORT, 0);
  }

  function drawDebugLines() {
    gl.useProgram(lineProgram);
    gl.uniformMatrix4fv(lineMvpLocation, false, viewProjection);
    bindAttribute(gl, linePositionAttr);
    bindAttribute(gl, lineColorAttr);
    gl.drawArrays(gl.LINES, 0, lineVertexCount);
  }

  // ---------- 11. 渲染循环 ----------
  const SPIN_SPEED = 0.35; // 左边立方体每秒绕 Y 轴转的角度
  let spinAngle = 0;
  let lastTime = 0;
  let frameCount = 0; // FPS 统计: 每 0.5 秒结算一次
  let elapsed = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    const delta = Math.min((now - lastTime) / 1000, 0.1); // 切到后台再回来时截断, 避免「瞬移」
    lastTime = now;

    spinAngle += SPIN_SPEED * delta;
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

  // ---------- 12. 鼠标控制相机（与 4_camera_control_webgl.js 相同的轨道相机） ----------
  const ROTATE_BUTTON = 0;
  const PAN_BUTTON = 2;

  let activePointerId = null;
  let dragMode = null; // 'orbit' | 'pan'
  let lastX = 0;
  let lastY = 0;

  canvas.style.cursor = 'grab';

  function handlePointerDown(event) {
    if (activePointerId !== null) return;
    if (event.button === ROTATE_BUTTON) dragMode = 'orbit';
    else if (event.button === PAN_BUTTON) dragMode = 'pan';
    else return;

    activePointerId = event.pointerId;
    lastX = event.clientX;
    lastY = event.clientY;
    canvas.setPointerCapture(event.pointerId);
    canvas.style.cursor = 'grabbing';
  }

  function handlePointerMove(event) {
    if (event.pointerId !== activePointerId) return;

    const dx = event.clientX - lastX;
    const dy = event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;

    if (dragMode === 'orbit') {
      camera.yaw -= dx * ROTATE_SPEED;
      camera.pitch = clamp(camera.pitch + dy * ROTATE_SPEED, -PITCH_LIMIT, PITCH_LIMIT);
    } else if (dragMode === 'pan') {
      // 观察点沿相机的右/上方向移动, 拖动方向和画面永远对得上
      const worldPerPixel = (2 * camera.distance * Math.tan(FOV / 2)) / Math.max(1, canvas.clientHeight);
      const cosYaw = Math.cos(camera.yaw);
      const sinYaw = Math.sin(camera.yaw);
      const cosPitch = Math.cos(camera.pitch);
      const sinPitch = Math.sin(camera.pitch);
      const right = [cosYaw, 0, -sinYaw];
      const up = [-sinYaw * sinPitch, cosPitch, -cosYaw * sinPitch];

      for (let i = 0; i < 3; i++) {
        camera.target[i] += -right[i] * dx * worldPerPixel + up[i] * dy * worldPerPixel;
      }
    }
    // 有渲染循环, 不必在这里手动 render()
  }

  function handlePointerUp(event) {
    if (event.pointerId !== activePointerId) return;
    activePointerId = null;
    dragMode = null;
    canvas.style.cursor = 'grab';
  }

  function handleWheel(event) {
    event.preventDefault();
    const deltaY = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
    // 指数缩放: 远近处每格滚轮的手感一致
    camera.distance = clamp(camera.distance * Math.exp(deltaY * ZOOM_SPEED), MIN_DISTANCE, MAX_DISTANCE);
  }

  canvas.addEventListener('pointerdown', handlePointerDown);
  canvas.addEventListener('pointermove', handlePointerMove);
  canvas.addEventListener('pointerup', handlePointerUp);
  canvas.addEventListener('pointercancel', handlePointerUp);
  canvas.addEventListener('wheel', handleWheel, { passive: false });
  canvas.addEventListener('dblclick', resetCamera);
  canvas.addEventListener('contextmenu', (event) => event.preventDefault());

  // ---------- 13. 键盘控制剔除 ----------
  window.addEventListener('keydown', (event) => {
    const key = event.key.toLowerCase();

    if (key === '1' || key === '2' || key === '3') {
      cullStateIndex = Number(key) - 1;
      applyCullState();
    } else if (key === 'f') {
      // 翻转「正面」的定义: 同一个物体, 正面背面直接互换, 剔除结果也随之反转
      frontFaceIsCCW = !frontFaceIsCCW;
      applyCullState();
    } else if (key === 'r') {
      resetCamera();
    }
  });

  // ---------- 14. 启动 ----------
  applyCullState(); // 默认: 关闭剔除 + 逆时针为正面
  resize();
  window.addEventListener('resize', resize);
  document.body.classList.add('is-ready');
  requestAnimationFrame(frame);
}

/* =============== 数据准备 =============== */

/**
 * 立方体（带法线, 用索引绘制）
 * 每个面 4 个顶点 + 该面的法线, 6 面共 24 个顶点; 每面 2 个三角形 → 36 个索引
 * 关键约定: 每个面的 4 个角都按「从物体外面看过去逆时针」排列,
 *           这样 WebGL 默认的 frontFace = CCW 才会把外面认成正面。
 * @param {number} halfSize 半边长
 */
function buildCube(halfSize) {
  const positions = [];
  const normals = [];
  const indices = [];

  // corners 的四点顺序即绕序: 0-1-2 与 0-2-3 都是同一朝向
  const faces = [
    { normal: [0, 0, 1],  corners: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },     // +Z
    { normal: [0, 0, -1], corners: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]] }, // -Z
    { normal: [1, 0, 0],  corners: [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]] },     // +X
    { normal: [-1, 0, 0], corners: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]] }, // -X
    { normal: [0, 1, 0],  corners: [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]] },     // +Y
    { normal: [0, -1, 0], corners: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]] }, // -Y
  ];

  faces.forEach((face) => {
    const base = positions.length / 3;

    face.corners.forEach(([x, y, z]) => {
      positions.push(x * halfSize, y * halfSize, z * halfSize);
      normals.push(face.normal[0], face.normal[1], face.normal[2]);
    });

    // 两条对角线把四边形切成两个同向的三角形
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  });

  return { positions, normals, indices };
}

/**
 * 反转绕序: 每个三角形只交换后两个索引
 * 三角形的位置和形状完全不变, 只改变「从哪一侧看是逆时针」, 正好用来验证面剔除
 */
function reverseWinding(indices) {
  const reversed = indices.slice();
  for (let i = 0; i < reversed.length; i += 3) {
    const second = reversed[i + 1];
    reversed[i + 1] = reversed[i + 2];
    reversed[i + 2] = second;
  }
  return reversed;
}

/**
 * 生成地面网格 + 坐标轴的线数据
 * 输出两个等长数组: positions(每顶点 3 个分量) 与 colors(每顶点 3 个分量)
 * 之所以不用网格线画在 y = 0 上还有效, 是因为 LINES 图元不参与面剔除
 */
function buildDebugLines(halfSize, step, axisYLength) {
  const positions = [];
  const colors = [];

  const GRID_COLOR = [0.18, 0.20, 0.24];
  const X_AXIS_COLOR = [0.92, 0.30, 0.34];
  const Y_AXIS_COLOR = [0.40, 0.88, 0.48];
  const Z_AXIS_COLOR = [0.35, 0.60, 1.00];

  // 一条线 = 两个端点, 每个端点都要复制一份颜色
  function pushLine(ax, ay, az, bx, by, bz, color) {
    positions.push(ax, ay, az, bx, by, bz);
    colors.push(color[0], color[1], color[2], color[0], color[1], color[2]);
  }

  const steps = Math.round(halfSize / step);
  for (let i = -steps; i <= steps; i++) {
    if (i === 0) continue; // 中间两条不画, 位置留给坐标轴
    const offset = i * step;
    // 平行于 Z 轴的线
    pushLine(offset, 0, -halfSize, offset, 0, halfSize, GRID_COLOR);
    // 平行于 X 轴的线
    pushLine(-halfSize, 0, offset, halfSize, 0, offset, GRID_COLOR);
  }

  // 坐标轴: X 红 / Y 绿 / Z 蓝
  pushLine(-halfSize, 0, 0, halfSize, 0, 0, X_AXIS_COLOR);
  pushLine(0, 0, 0, 0, axisYLength, 0, Y_AXIS_COLOR);
  pushLine(0, 0, -halfSize, 0, 0, halfSize, Z_AXIS_COLOR);

  return { positions, colors };
}

/* =============== 缓冲区与属性 =============== */

/**
 * 上传一个顶点属性（位置 / 法线 / 颜色都走这条路径）
 * 返回的不只是缓冲区, 还带上它属于哪个程序、哪个 location、每个顶点几个分量,
 * 之后每次绘制前用 bindAttribute 重新绑定 —— 多个程序共用全局属性状态时必须重绑
 */
function uploadAttribute(gl, program, name, data, components) {
  const location = gl.getAttribLocation(program, name);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
  return { location, buffer, components };
}

function bindAttribute(gl, attribute) {
  gl.bindBuffer(gl.ARRAY_BUFFER, attribute.buffer);
  gl.vertexAttribPointer(attribute.location, attribute.components, gl.FLOAT, false, 0, 0);
  gl.enableVertexAttribArray(attribute.location);
}

function uploadIndices(gl, indices) {
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.STATIC_DRAW);
  return buffer;
}

// 模型矩阵只有旋转和平移（没有缩放）, 所以法线矩阵就是左上角 3x3
function extractNormalMatrix(model) {
  return new Float32Array([
    model[0], model[1], model[2],
    model[4], model[5], model[6],
    model[8], model[9], model[10],
  ]);
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

/* =============== 操作说明面板 =============== */

/**
 * 在页面右上角生成操作说明面板（样式见 ui/style.css 的 .hud--help）
 * 返回需要随状态高亮的按键元素: cullKeys 按 CULL_STATES 下标对应, flipKey 对应正面绕序翻转
 */
function createHelpPanel() {
  // 面板内容就是本文件顶部注释里的那份操作表, 改按键时两处一起改
  const sections = [
    {
      title: '鼠标',
      items: [
        { keys: ['左键拖动'], desc: '旋转观察' },
        { keys: ['右键拖动'], desc: '平移' },
        { keys: ['滚轮'], desc: '缩放' },
        { keys: ['双击'], desc: '复位视角' },
      ],
    },
    {
      title: '键盘',
      items: [
        { keys: ['1'], desc: '背面剔除', cull: 0 },
        { keys: ['2'], desc: '正面剔除', cull: 1 },
        { keys: ['3'], desc: '关闭剔除', cull: 2 },
        { keys: ['F'], desc: '翻转正面绕序', flip: true },
        { keys: ['R'], desc: '复位视角' },
      ],
    },
  ];

  const panel = document.createElement('aside');
  panel.className = 'hud hud--help';
  panel.setAttribute('aria-label', '操作说明');

  const card = document.createElement('div');
  card.className = 'help';

  const title = document.createElement('h2');
  title.className = 'help__title';
  title.textContent = '操作说明';
  card.appendChild(title);

  const cullKeys = [];
  let flipKey = null;

  sections.forEach((section) => {
    const group = document.createElement('section');
    group.className = 'help__group';

    const groupTitle = document.createElement('h3');
    groupTitle.className = 'help__group-title';
    groupTitle.textContent = section.title;
    group.appendChild(groupTitle);

    // dt 放按键, dd 放说明 —— 两列由 CSS 网格对齐, 所以不额外包行元素
    const list = document.createElement('dl');
    list.className = 'help__list';

    section.items.forEach((item) => {
      const term = document.createElement('dt');
      item.keys.forEach((key) => {
        const kbd = document.createElement('kbd');
        kbd.textContent = key;
        term.appendChild(kbd);
      });

      const desc = document.createElement('dd');
      desc.textContent = item.desc;

      if (item.cull !== undefined) cullKeys[item.cull] = term;
      if (item.flip) flipKey = term;

      list.append(term, desc);
    });

    group.appendChild(list);
    card.appendChild(group);
  });

  panel.appendChild(card);
  document.body.appendChild(panel);

  return { cullKeys, flipKey };
}
