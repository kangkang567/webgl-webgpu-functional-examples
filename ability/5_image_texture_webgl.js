/**
 * 功能简介: WebGL 图片纹理 —— 在最小渲染流程的基础上, 给立方体六个面贴上 cat.png
 * 作者: deepseek编写, wangweikang手动修改整理
 * 时间: 2026.10.28
 *
 * 与 1_basic_rendering_process_webgl.js 的差别只有三处:
 *   ① 顶点数据多一份「纹理坐标」(attribute vec2 aUv)
 *   ② 片元着色器不再输出纯色, 而是用 texture2D 从纹理里取色
 *   ③ 多一个纹理对象, 走「创 → 绑 → 参 → 图」四步, 图片到位后才能画
 * 颜色 → 贴图: uColor 换成了 uTexture, 其余流程（缓冲区 / uniform / MVP / 深度测试）完全一样。
 */

import { multiply, perspective, rotationX, rotationY, translation } from '../utils/mat4.js';
import { showError } from '../utils/page-status.js';

// ---------- 1. 获取canvas元素 - 浏览器环境三维渲染基于canvas标签实现 ----------
const canvas = document.querySelector('#scene');
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
  // 顶点着色器: 多一个 aUv（纹理坐标），原样用 varying 交给片元着色器
  const vertexSource = /* glsl */ `
    attribute vec3 aPosition;
    attribute vec2 aUv;

    uniform mat4 uMvp;

    varying vec2 vUv;

    void main() {
      // 纹理坐标只做插值, 不做任何变换: 屏幕上的每个像素从整张贴图的哪个位置取色, 由它决定
      vUv = aUv;
      gl_Position = uMvp * vec4(aPosition, 1.0);
    }
  `;

  // 片元着色器: uniform 从 vec3 uColor 换成 sampler2D uTexture
  // sampler2D 就是「纹理」在 GLSL 里的类型, 它不是颜色, 而是"从哪张图取色"的引用
  const fragmentSource = /* glsl */ `
    precision mediump float;

    uniform sampler2D uTexture;

    varying vec2 vUv;

    void main() {
      // 用插值后的纹理坐标, 在 uTexture 上采一个颜色, 就是该像素的最终颜色
      gl_FragColor = texture2D(uTexture, vUv);
    }
  `;

  // ---------- 4. 创建着色器对象与渲染程序 ----------
  const program = createProgram(gl, vertexSource, fragmentSource);
  gl.useProgram(program);

  // ---------- 5. 准备用于渲染的数据 ----------
  // 两类数据: 属性数据(attribute, 走缓冲区) 和 uniform数据(不走缓冲区, 直接按位置传值)

  // 数据: 立方体 36 个顶点（6 面 × 2 三角形 × 3 顶点）, 与第 1 个示例完全相同
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

  // 数据: 每个顶点的纹理坐标 (u, v), 与 positions 一一对应
  // 纹理坐标范围固定是 0~1: (0, 0) 贴图左下角, (1, 1) 贴图右上角
  // 六个面之所以能共用同一组坐标, 是因为上面每个面都按「左下 → 右下 → 右上」的顺序排顶点;
  // 一旦某个面的顶点顺序反了, 那个面的贴图就会镜像
  const FACE_UV = [0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1];
  const uvs = [];
  for (let face = 0; face < 6; face++) uvs.push(...FACE_UV);

  // 上传属性数据的五步: ①创 ②绑 ③传 ④格 ⑤激（位置与纹理坐标各来一遍）
  function uploadAttribute(name, data, components) {
    const location = gl.getAttribLocation(program, name);
    const buffer = gl.createBuffer();                                              // ①创
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);                                        // ②绑
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);         // ③传
    gl.vertexAttribPointer(location, components, gl.FLOAT, false, 0, 0);            // ④格
    gl.enableVertexAttribArray(location);                                          // ⑤激
    return buffer;
  }

  uploadAttribute('aPosition', positions, 3);
  uploadAttribute('aUv', uvs, 2);

  // 顶点个数: 每顶点 3 个位置分量, 绘制时按它决定画多少个顶点
  const vertexCount = positions.length / 3;

  // ---------- 6. 创建纹理对象: 创 → 绑 → 参 → 图 ----------
  // ①创 - 创建纹理对象（此时还是一张空图）
  const texture = gl.createTexture();

  // ②绑 - 先激活纹理单元, 再把纹理对象绑到 TEXTURE_2D 这个"插槽"上
  //      WebGL 至少提供 8 个纹理单元, 一个单元同时只能放一张图; 这里只用 0 号
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);

  // ③参 - 采样参数: 图片没铺满/超出时怎么取、放大缩小时怎么插值
  //      注意顺序: 参数要在 texImage2D 前后都可以设, 但必须在绘制前设好
  //      cat.png 是 400×400（非 2 的幂）, WebGL1 规定这种图只能用 CLAMP_TO_EDGE 且不能用 mipmap,
  //      所以这里不调 generateMipmap, MIN_FILTER 也只能取 LINEAR 而不能取 LINEAR_MIPMAP_LINEAR,
  //      否则纹理会被判定为"不完整", 采样结果是纯黑
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);   // u 方向越界: 取边缘像素
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);   // v 方向越界: 取边缘像素
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);      // 缩小: 线性插值
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);      // 放大: 线性插值

  // ④图 - 图片加载是异步的: 图片到位后才能上传像素, 所以第一次绘制也得挪到回调里
  //      另外浏览器给 <img> 的原点在左上角, 而纹理坐标 v=0 在下方,
  //      不翻转的话六张贴图会整体上下颠倒
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

  let textureReady = false;
  const image = new Image();
  image.onload = () => {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    // 上传像素: 级别0, 内部格式 RGBA, 源格式 RGBA, 数据类型 UNSIGNED_BYTE, 源图 <img>
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    textureReady = true;
    resize(); // 纹理就绪后才第一次绘制
  };
  image.onerror = () => {
    showError('纹理图片加载失败：assets/cat.png');
  };
  // 路径相对「HTML 文档」(ui/index.html) 解析, 与当前 JS 模块所在目录无关
  image.src = '../assets/cat.png';

  // ---------- 7. 上传uniform数据: 采样器指向哪个纹理单元 ----------
  // ①定 - 获取uniform变量在渲染程序中的位置
  const mvpLocation = gl.getUniformLocation(program, 'uMvp');
  const textureLocation = gl.getUniformLocation(program, 'uTexture');
  // ②选 - uniform位置只在「当前使用的渲染程序」下有效（第 4 步已 useProgram）
  // ③传 - 采样器传的是「纹理单元的编号」(0), 而不是纹理对象本身;
  //       0 号单元上绑着哪张图, 采样器就采哪张图, 换图只需重新 bindTexture
  gl.uniform1i(textureLocation, 0);

  // ---------- 8. 相机与投影 ----------
  const fov = (45 * Math.PI) / 180;
  // 相机后移、轻微俯视, 再绕 Y 转一点: 让 +Z / +X / +Y 三个面同时可见
  // （另外三个背面的贴图同样在, 只是被挡住了; 把 rotationY 的数值改成 Math.PI 就能看到）
  const view = multiply(
    translation(0, 0, -6.5),
    multiply(rotationX(0.25), rotationY(0.55)),
  );
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

  // ---------- 9. 单次绘制：画面静止，没有 requestAnimationFrame 循环 ----------
  function render() {
    if (!textureReady) return; // 图片还没到, 先用空纹理画一次只会得到黑块, 不如不画

    // 状态设置
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);

    // 传 - uMvp: 投影矩阵会随画布尺寸变化, 所以每次重绘都重新计算并上传
    gl.uniformMatrix4fv(mvpLocation, false, multiply(projection, view));

    // 画 - 纹理已绑在 0 号单元上, 顶点属性也已绑定并激活, 这里直接绘制
    gl.drawArrays(gl.TRIANGLES, 0, vertexCount);
  }

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
