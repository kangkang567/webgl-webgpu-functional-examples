/**
 * 功能简介: WebGL 渲染几何体的最基本流程
 * 作者: deepseek编写, wangweikang手动修改整理
 * 时间: 2026.10.22 15点45分
 */

import { multiply, perspective, rotationX, translation } from '../utils/mat4.js';
import { showError } from '../utils/page-status.js';

// ---------- 1. 获取canvas元素 - 浏览器环境三维渲染基于canvas标签实现 ----------
const canvas = document.querySelector('#scene');
// 页面右下角唯一还在更新的读数：画布尺寸（FPS 需要渲染循环，本页是单次绘制）
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
  // 共同点: 都要先拿到「变量位置」, 再把数据传进去

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

  // 上传属性数据的五步:
  // ①创 - 创建缓冲区对象
  const positionBuffer = gl.createBuffer();
  // ②绑 - 将缓冲区对象绑定为操作对象
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  // ③传 - 将数据上传到webgl缓冲区对象中
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW);
  // ④格 - 规定positionLocation对应的变量从哪里取数据 以及 怎么取数据
  gl.vertexAttribPointer(positionLocation, 3, gl.FLOAT, false, 0, 0);
  // ⑤激 - 规定该属性变量可用
  gl.enableVertexAttribArray(positionLocation);

  // 顶点个数: 每顶点 3 个分量, 绘制时按它决定画多少个顶点
  const vertexCount = positions.length / 3;

  // 上传uniform数据的三步（没有缓冲区, 直接按变量位置把值传进去）:
  const CUBE_COLOR = [0.36, 0.55, 1.0];
  // ①定 - 获取uniform变量在渲染程序中的位置
  const mvpLocation = gl.getUniformLocation(program, 'uMvp');
  const colorLocation = gl.getUniformLocation(program, 'uColor');
  // ②选 - uniform位置只在「当前使用的渲染程序」下有效, 上传前必须 gl.useProgram(program)
  //       （第 4 步已调用过, 这里不用重复; 若存在多个程序, 切换后要重新 useProgram）
  // ③传 - 传值: 颜色全程不变, 传一次即可; uMvp 依赖投影矩阵, 放到 render() 里每次重绘再传
  gl.uniform3fv(colorLocation, CUBE_COLOR);

  // ---------- 6. 相机、投影与尺寸 ----------
  const fov = (45 * Math.PI) / 180;
  const view = multiply(translation(0, 0, -6.5), rotationX(0.25)); // 相机后移并轻微俯视，立方体居中
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

    render(); // 画布尺寸变化后需要重画一次
  }

  // ---------- 7. 单次绘制：画面静止，没有 requestAnimationFrame 循环 ----------
  function render() {
    // 状态设置
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);

    // 传 - uMvp: 投影矩阵会随画布尺寸变化, 所以每次重绘都重新计算并上传
    gl.uniformMatrix4fv(mvpLocation, false, multiply(projection, view));

    // 画 - 顶点属性在 5 步里已经绑定并激活, 这里直接按顶点个数绘制
    gl.drawArrays(gl.TRIANGLES, 0, vertexCount);
  }

  resize();
  window.addEventListener('resize', resize);
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