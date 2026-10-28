/**
 * 功能简介: WebGL 鼠标控制相机 —— 在基础渲染流程之上, 用鼠标实时改写视图矩阵
 * 作者: deepseek编写, wangweikang手动修改整理
 * 时间: 2026.10.28
 * 操作: 左键拖动=旋转, 右键拖动=平移, 滚轮=缩放, 双击=复位
 */

import { multiply, perspective, rotationX, rotationY, translation } from '../utils/mat4.js';
import { showError } from '../utils/page-status.js';

// ---------- 1. 获取canvas元素 - 浏览器环境三维渲染基于canvas标签实现 ----------
const canvas = document.querySelector('#scene');
const apiStat = document.querySelector('#stat-api');
// 页面右下角的读数：画布尺寸（本页仍是「事件驱动」的重绘, 没有持续渲染循环, 所以 FPS 不显示）
const sizeStat = document.querySelector('#stat-size');

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
  // 与 1_basic_rendering_process_webgl.js 完全一致：
  // 相机怎么动都不需要改着色器, 动的只是顶点着色器里的 uMvp 这一个矩阵。
  const vertexSource = /* glsl */ `
    attribute vec3 aPosition;

    uniform mat4 uMvp;

    void main() {
      gl_Position = uMvp * vec4(aPosition, 1.0);
    }
  `;

  const fragmentSource = /* glsl */ `
    precision mediump float;

    uniform vec3 uColor;

    void main() {
      gl_FragColor = vec4(uColor, 1.0);
    }
  `;

  // ---------- 4. 创建着色器对象与渲染程序 ----------
  const program = createProgram(gl, vertexSource, fragmentSource);
  gl.useProgram(program);

  // ---------- 5. 准备用于渲染的数据 ----------
  // 两类数据: 属性数据(attribute, 走缓冲区) 和 uniform数据(不走缓冲区, 直接按位置传值)

  // 数据: 立方体 36 个顶点（6 面 × 2 三角形 × 3 顶点）
  const positions = [
    // +Z 面
    -1, -1, 1,   1, -1, 1,    1, 1, 1,
    -1, -1, 1,   1, 1, 1,    -1, 1, 1,
    // -Z 面
     1, -1, -1, -1, -1, -1,  -1, 1, -1,
     1, -1, -1, -1, 1, -1,   1, 1, -1,
    // +X 面
     1, -1, 1,   1, -1, -1,   1, 1, -1,
     1, -1, 1,   1, 1, -1,    1, 1, 1,
    // -X 面
    -1, -1, -1, -1, -1, 1,  -1, 1, 1,
    -1, -1, -1, -1, 1, 1,   -1, 1, -1,
    // +Y 面
    -1, 1, 1,    1, 1, 1,    1, 1, -1,
    -1, 1, 1,    1, 1, -1,  -1, 1, -1,
    // -Y 面
    -1, -1, -1,  1, -1, -1,  1, -1, 1,
    -1, -1, -1,  1, -1, 1,  -1, -1, 1,
  ];
  // 拿到属性变量的位置: 告诉后面的 vertexAttribPointer 要配置哪个属性
  const positionLocation = gl.getAttribLocation(program, 'aPosition');

  // 上传属性数据的五步: ①创 ②绑 ③传 ④格 ⑤激
  const positionBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW);
  gl.vertexAttribPointer(positionLocation, 3, gl.FLOAT, false, 0, 0);
  gl.enableVertexAttribArray(positionLocation);

  // 顶点个数: 每顶点 3 个分量, 绘制时按它决定画多少个顶点
  const vertexCount = positions.length / 3;

  // 上传uniform数据: 颜色全程不变, 传一次即可
  const CUBE_COLOR = [0.36, 0.55, 1.0];
  const mvpLocation = gl.getUniformLocation(program, 'uMvp');
  const colorLocation = gl.getUniformLocation(program, 'uColor');
  gl.uniform3fv(colorLocation, CUBE_COLOR);

  // ---------- 6. 投影与相机状态 ----------
  // 投影只跟画布宽高比有关 → 放进 resize()
  const FOV = (45 * Math.PI) / 180;
  const NEAR = 0.1;
  const FAR = 100;
  let projection;

  // 相机用「球坐标 + 观察点」描述, 这是轨道相机(Orbit)最省事的写法:
  //   · distance 决定远近（鼠标滚轮）
  //   · yaw / pitch 决定绕观察点的方位与仰角（拖动）
  //   · target 决定绕着谁转（右键平移）
  // 有了这三个量, 任意时刻都能重建出视图矩阵, 不需要自己去求相机朝向。
  const camera = {
    yaw: 0,            // 水平角: 绕 Y 轴, 0 表示相机在 +Z 正前方
    pitch: 0.25,       // 俯仰角: 正值表示相机在观察点上方（略微俯视, 与基础版初态一致）
    distance: 6.5,     // 相机到观察点的距离（与基础版的 z 后移量一致）
    target: [0, 0, 0], // 观察点（世界空间）, 立方体中心
  };

  const PITCH_LIMIT = Math.PI / 2 - 0.02; // 俯仰角上下限: 留一点缝, 避免正好在正上方时画面「翻面」
  const MIN_DISTANCE = 2.2;               // 比立方体外接球半径(≈1.73)再远一点, 别钻进物体里面
  const MAX_DISTANCE = 20;
  const ROTATE_SPEED = 0.006;             // 弧度/像素
  const ZOOM_SPEED = 0.0015;              // 滚轮每单位 deltaY 的指数系数

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  // 由相机状态拼出视图矩阵: V = T(0,0,-distance) · Rx(pitch) · Ry(-yaw) · T(-target)
  // 读法（从右往左施加到顶点上）:
  //   · T(-target) 先把观察点搬到原点, 于是绕原点旋转就等于绕观察点转
  //   · Ry(-yaw) 先水平旋转, Rx(pitch) 再俯仰 —— 顺序反过来（先俯仰后水平）镜头会歪
  //   · T(0,0,-distance) 最后把世界沿镜头前方推到距离 distance 处
  // 反解出的相机世界坐标: (d·cosP·sinYaw, d·sinP, d·cosP·cosYaw), 正好落在半径 d 的球面上
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

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2); // 高 DPI 也清晰，同时限制开销
    const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const height = Math.max(1, Math.round(canvas.clientHeight * dpr));

    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    gl.viewport(0, 0, width, height);
    projection = perspective(FOV, width / height, NEAR, FAR);
    if (sizeStat) sizeStat.textContent = `${width} × ${height}`;

    render(); // 画布尺寸变化后需要重画一次
  }

  // ---------- 7. 绘制：没有 rAF 循环, 由「尺寸变化」和「相机变化」触发 ----------
  function render() {
    // 状态设置
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);

    // 传 - uMvp: 相机一动视图矩阵就变, 所以每次重绘都重新拼一遍再上传
    gl.uniformMatrix4fv(mvpLocation, false, multiply(projection, buildView()));

    // 画 - 顶点属性在 5 步里已经绑定并激活, 这里直接按顶点个数绘制
    gl.drawArrays(gl.TRIANGLES, 0, vertexCount);
  }

  // ---------- 8. 鼠标控制 ----------
  // 用 Pointer Events 而不是 mouse 事件: 同一套代码顺带支持触屏和手写笔
  const ROTATE_BUTTON = 0; // 左键：旋转
  const PAN_BUTTON = 2;    // 右键：平移

  let activePointerId = null; // 同一时刻只跟踪一个指针, 多指同时拖动会互相打架
  let dragMode = null;        // 'orbit' | 'pan'
  let lastX = 0;
  let lastY = 0;

  canvas.style.cursor = 'grab';

  function handlePointerDown(event) {
    if (activePointerId !== null) return;

    if (event.button === ROTATE_BUTTON) dragMode = 'orbit';
    else if (event.button === PAN_BUTTON) dragMode = 'pan';
    else return; // 中键等其它键不处理

    activePointerId = event.pointerId;
    lastX = event.clientX;
    lastY = event.clientY;

    // 指针捕获: 拖到画布外面（甚至窗口外面）也继续收到 move / up, 松手不会「卡住」
    canvas.setPointerCapture(event.pointerId);
    canvas.style.cursor = 'grabbing';
  }

  function handlePointerMove(event) {
    if (event.pointerId !== activePointerId) return;

    // 用「本次与上次位置的差值」而不是绝对坐标: 这样手感只跟拖动幅度有关
    const dx = event.clientX - lastX;
    const dy = event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;

    if (dragMode === 'orbit') orbit(dx, dy);
    else if (dragMode === 'pan') pan(dx, dy);

    render(); // 相机变了 → 立刻重画一帧
  }

  function handlePointerUp(event) {
    if (event.pointerId !== activePointerId) return;
    activePointerId = null;
    dragMode = null;
    canvas.style.cursor = 'grab';
  }

  // 旋转: 画面跟手 —— 向右拖, 相机向左绕（立方体看起来向右转）; 向下拖, 相机升高（露出顶面）
  function orbit(dx, dy) {
    camera.yaw -= dx * ROTATE_SPEED;
    camera.pitch = clamp(camera.pitch + dy * ROTATE_SPEED, -PITCH_LIMIT, PITCH_LIMIT);
  }

  // 平移: 沿相机自己的右方向 / 上方向移动观察点, 所以不管转到哪个角度, 拖动方向都和画面对得上
  function pan(dx, dy) {
    // 世界坐标下的「每像素对应多少长度」: 观察点所在平面上, 视野高度是 2·distance·tan(fov/2)
    const worldPerPixel = (2 * camera.distance * Math.tan(FOV / 2)) / Math.max(1, canvas.clientHeight);

    const cosYaw = Math.cos(camera.yaw);
    const sinYaw = Math.sin(camera.yaw);
    const cosPitch = Math.cos(camera.pitch);
    const sinPitch = Math.sin(camera.pitch);

    // 相机的右方向、上方向（世界空间）, 由 yaw / pitch 直接算出, 不必求逆矩阵
    const right = [cosYaw, 0, -sinYaw];
    const up = [-sinYaw * sinPitch, cosPitch, -cosYaw * sinPitch];

    // 画面跟手: 向右拖 → 观察点左移（物体在画面里跟着往右走）; 向下拖 → 观察点上移
    for (let i = 0; i < 3; i++) {
      camera.target[i] += -right[i] * dx * worldPerPixel + up[i] * dy * worldPerPixel;
    }
  }

  // 缩放: 指数缩放, 远处和近处每格滚轮的观感变化一致（线性加减会「近处暴冲、远处发黏」）
  function handleWheel(event) {
    event.preventDefault();

    // deltaMode === 1 表示按「行」滚动, 统一折算成像素量级
    const deltaY = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
    camera.distance = clamp(camera.distance * Math.exp(deltaY * ZOOM_SPEED), MIN_DISTANCE, MAX_DISTANCE);

    render();
  }

  // 双击复位: 相机状态全部回到初值
  function resetCamera() {
    camera.yaw = 0;
    camera.pitch = 0.25;
    camera.distance = 6.5;
    camera.target = [0, 0, 0];
    render();
  }

  canvas.addEventListener('pointerdown', handlePointerDown);
  canvas.addEventListener('pointermove', handlePointerMove);
  canvas.addEventListener('pointerup', handlePointerUp);
  canvas.addEventListener('pointercancel', handlePointerUp); // 系统打断（如手势、来电）也要复位
  canvas.addEventListener('wheel', handleWheel, { passive: false }); // 要 preventDefault 就不能用被动监听
  canvas.addEventListener('dblclick', resetCamera);
  canvas.addEventListener('contextmenu', (event) => event.preventDefault()); // 右键用来平移, 不加菜单

  // ---------- 9. 启动 ----------
  if (apiStat) apiStat.textContent = 'WebGL';

  resize();
  window.addEventListener('resize', resize);
  document.body.classList.add('is-ready');
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
