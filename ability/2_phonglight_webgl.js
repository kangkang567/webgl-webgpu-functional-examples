/**
 * 功能简介: WebGL 实现 Phong 光照模型（环境光 + 漫反射 + 镜面高光）
 * 作者: deepseek编写, wangweikang手动修改整理
 * 时间: 2026.10.28
 */

import { multiply, perspective, rotationX, rotationY, translation } from '../utils/mat4.js';
import { showError } from '../utils/page-status.js';

// ---------- 1. 获取canvas元素 - 浏览器环境三维渲染基于canvas标签实现 ----------
const canvas = document.querySelector('#scene');
// 页面右下角唯一还在更新的读数：画布尺寸（FPS 需要渲染循环，本页是单次绘制）
const sizeStat = document.querySelector('#stat-size');
const apiStat = document.querySelector('#stat-api');

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
  // 与 1_basic_rendering_process_webgl.js 的区别:
  //   · 顶点数据多了法线 aNormal（光照靠法线决定每个点的朝向）
  //   · 顶点着色器把「世界坐标」和「世界空间法线」传给片元着色器, 光照计算放在片元里做
  //     （放在片元里 = 逐像素光照, 高光更细腻; 放在顶点里 = 逐顶点光照, 高光会断裂）
  const vertexSource = /* glsl */ `
    attribute vec3 aPosition;
    attribute vec3 aNormal;

    uniform mat4 uMvp;          // 投影 × 视图 × 模型
    uniform mat4 uModel;        // 模型矩阵: 把顶点从模型空间搬到世界空间
    uniform mat3 uNormalMatrix; // 法线矩阵: 模型矩阵左上角 3x3（纯旋转时可直接用）

    varying vec3 vWorldPosition;
    varying vec3 vNormal;

    void main() {
      vec4 worldPosition = uModel * vec4(aPosition, 1.0);
      vWorldPosition = worldPosition.xyz;
      vNormal = uNormalMatrix * aNormal;
      gl_Position = uMvp * vec4(aPosition, 1.0);
    }
  `;

  // Phong 光照模型 = 环境光 + 漫反射 + 镜面高光
  const fragmentSource = /* glsl */ `
    precision mediump float;

    uniform vec3 uColor;             // 物体本身的固有色
    uniform vec3 uLightColor;        // 光源颜色
    uniform vec3 uLightPosition;     // 光源位置（世界空间）
    uniform vec3 uCameraPosition;    // 相机位置（世界空间），算高光要用
    uniform vec3 uAmbientColor;      // 环境光颜色
    uniform float uShininess;        // 高光锐利度: 越大高光越小越亮
    uniform float uSpecularStrength; // 高光强度

    varying vec3 vWorldPosition;
    varying vec3 vNormal;

    void main() {
      vec3 N = normalize(vNormal);                          // 法线
      vec3 L = normalize(uLightPosition - vWorldPosition);  // 指向光源
      vec3 V = normalize(uCameraPosition - vWorldPosition); // 指向相机

      // ① 环境光: 没有方向, 让背光面不是纯黑
      vec3 ambient = uAmbientColor * uColor;

      // ② 漫反射: 法线与光线夹角越小越亮, 背面（点积为负）截断为 0
      float diffuseFactor = max(dot(N, L), 0.0);
      vec3 diffuse = uColor * uLightColor * diffuseFactor;

      // ③ 镜面高光（Phong）: 先求光线关于法线的反射向量 R, 再看 R 与视线 V 是否重合
      vec3 R = reflect(-L, N);
      float specularFactor = pow(max(dot(R, V), 0.0), uShininess);
      vec3 specular = uLightColor * uSpecularStrength * specularFactor;

      gl_FragColor = vec4(ambient + diffuse + specular, 1.0);
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

  // 数据: 每个顶点的法线, 与上面的位置数据一一对应（每个面 6 个相同法线）
  // 立方体每个面都是平的, 所以同一面的 6 个顶点法线相同, 光照呈现每面一个亮度
  const normals = [
    // +Z 面
     0, 0, 1,   0, 0, 1,   0, 0, 1,
     0, 0, 1,   0, 0, 1,   0, 0, 1,
    // -Z 面
     0, 0, -1,  0, 0, -1,  0, 0, -1,
     0, 0, -1,  0, 0, -1,  0, 0, -1,
    // +X 面
     1, 0, 0,   1, 0, 0,   1, 0, 0,
     1, 0, 0,   1, 0, 0,   1, 0, 0,
    // -X 面
    -1, 0, 0,  -1, 0, 0,  -1, 0, 0,
    -1, 0, 0,  -1, 0, 0,  -1, 0, 0,
    // +Y 面
     0, 1, 0,   0, 1, 0,   0, 1, 0,
     0, 1, 0,   0, 1, 0,   0, 1, 0,
    // -Y 面
     0, -1, 0,  0, -1, 0,  0, -1, 0,
     0, -1, 0,  0, -1, 0,  0, -1, 0,
  ];

  // 上传属性数据的五步（位置与法线各来一遍）: ①创 ②绑 ③传 ④格 ⑤激
  function uploadAttribute(name, data, components) {
    // 拿到属性变量的位置: 告诉 vertexAttribPointer 要配置哪个属性
    const location = gl.getAttribLocation(program, name);
    // ①创 - 创建缓冲区对象
    const buffer = gl.createBuffer();
    // ②绑 - 将缓冲区对象绑定为操作对象
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    // ③传 - 将数据上传到webgl缓冲区对象中
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
    // ④格 - 规定该属性变量从哪里取数据 以及 怎么取数据
    gl.vertexAttribPointer(location, components, gl.FLOAT, false, 0, 0);
    // ⑤激 - 规定该属性变量可用（没有显式指定 location 的 attribute 默认是关闭的）
    gl.enableVertexAttribArray(location);
    return buffer;
  }

  uploadAttribute('aPosition', positions, 3);
  uploadAttribute('aNormal', normals, 3);

  // 顶点个数: 每顶点 3 个分量, 绘制时按它决定画多少个顶点
  const vertexCount = positions.length / 3;

  // 上传uniform数据的步骤:
  const CUBE_COLOR = [0.36, 0.55, 1.0];      // 物体固有色
  const LIGHT_COLOR = [1.0, 1.0, 1.0];       // 白色光源
  const LIGHT_POSITION = [4.0, 6.0, 7.0];    // 光源放在物体右上前方
  const AMBIENT_COLOR = [0.16, 0.18, 0.22];  // 环境光偏冷, 让背光面有层次
  const SHININESS = 48.0;                    // 高光锐利度
  const SPECULAR_STRENGTH = 0.9;             // 高光强度

  // ①定 - 获取uniform变量在渲染程序中的位置
  const mvpLocation = gl.getUniformLocation(program, 'uMvp');
  const modelLocation = gl.getUniformLocation(program, 'uModel');
  const normalMatrixLocation = gl.getUniformLocation(program, 'uNormalMatrix');
  const colorLocation = gl.getUniformLocation(program, 'uColor');
  const lightColorLocation = gl.getUniformLocation(program, 'uLightColor');
  const lightPositionLocation = gl.getUniformLocation(program, 'uLightPosition');
  const cameraPositionLocation = gl.getUniformLocation(program, 'uCameraPosition');
  const ambientColorLocation = gl.getUniformLocation(program, 'uAmbientColor');
  const shininessLocation = gl.getUniformLocation(program, 'uShininess');
  const specularStrengthLocation = gl.getUniformLocation(program, 'uSpecularStrength');

  // ②选 - uniform位置只在「当前使用的渲染程序」下有效, 上传前必须 gl.useProgram(program)
  // ③传 - 不随重绘变化的量, 传一次即可
  gl.uniform3fv(colorLocation, CUBE_COLOR);
  gl.uniform3fv(lightColorLocation, LIGHT_COLOR);
  gl.uniform3fv(lightPositionLocation, LIGHT_POSITION);
  gl.uniform3fv(ambientColorLocation, AMBIENT_COLOR);
  gl.uniform1f(shininessLocation, SHININESS);
  gl.uniform1f(specularStrengthLocation, SPECULAR_STRENGTH);

  // ---------- 6. 相机、模型与投影 ----------
  const fov = (45 * Math.PI) / 180;
  const view = multiply(translation(0, 0, -6.5), rotationX(0.25)); // 相机后移并轻微俯视，立方体居中
  const model = multiply(rotationY(-0.5), rotationX(0.35));        // 转一下立方体, 让三个面朝向光源
  // 法线矩阵: 模型矩阵只有旋转, 左上角 3x3 就是「法线矩阵」
  // （若含非等比缩放, 必须用左上角 3x3 的逆转置, 否则法线会被拉歪）
  const normalMatrix = new Float32Array([
    model[0], model[1], model[2],
    model[4], model[5], model[6],
    model[8], model[9], model[10],
  ]);
  // 相机世界坐标: view = T(0,0,-6.5) · Rx(0.25), 反解出相机在世界空间的位置
  const CAMERA_POSITION = [0, 6.5 * Math.sin(0.25), 6.5 * Math.cos(0.25)];

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

    // 传 - 相机相关的量和矩阵: 投影矩阵随画布尺寸变化, 所以每次重绘都重新上传
    gl.uniform3fv(cameraPositionLocation, CAMERA_POSITION);
    gl.uniformMatrix4fv(mvpLocation, false, multiply(projection, multiply(view, model)));
    gl.uniformMatrix4fv(modelLocation, false, model);
    gl.uniformMatrix3fv(normalMatrixLocation, false, normalMatrix);

    // 画 - 顶点属性在 5 步里已经绑定并激活, 这里直接按顶点个数绘制
    gl.drawArrays(gl.TRIANGLES, 0, vertexCount);
  }

  // ---------- 8. 页面状态钩子 ----------
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
