/**
 * 功能简介: WebGPU 鼠标控制相机（与 4_camera_control_webgl.js 绘制同一内容、同一套交互）
 * 作者: deepseek编写, wangweikang手动修改整理
 * 时间: 2026.10.28
 * 操作: 左键拖动=旋转, 右键拖动=平移, 滚轮=缩放, 双击=复位
 */

import { multiply, perspective, rotationX, rotationY, translation } from '../utils/mat4.js';
import { showError } from '../utils/page-status.js';

// ---------- 1. 获取canvas元素 - 浏览器环境三维渲染基于canvas标签实现 ----------
const canvas = document.querySelector('#scene');
const apiStat = document.querySelector('#stat-api');
// 页面右下角的读数：画布尺寸（本页是「事件驱动」的重绘, 没有持续渲染循环, 所以 FPS 不显示）
const sizeStat = document.querySelector('#stat-size');

// WebGPU 的初始化全是异步的（适配器、设备都要 await），所以入口是 async 函数
main().catch((error) => {
  console.error(error);
  showError(error.message);
});

async function main() {
  // ---------- 2. 创建 WebGPU 上下文 ----------
  // 与 WebGL 一步拿到上下文不同, WebGPU 要连续拿到四个东西:
  // 显卡适配器 → 设备 → canvas 上下文 → 按格式配置上下文
  if (!navigator.gpu) throw new Error('当前浏览器不支持 WebGPU。');

  // ①适配器: 代表一块可用的显卡
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('没有可用的 WebGPU 适配器。');
  // ②设备: 真正执行命令的对象, 后面的缓冲区、管线、纹理都由它创建
  const device = await adapter.requestDevice();

  device.lost.then((info) => {
    if (info.reason !== 'destroyed') showError(`WebGPU 设备丢失：${info.message}`);
  });

  // ③上下文: 从 canvas 获取 webgpu 上下文
  const context = canvas.getContext('webgpu');
  if (!context) throw new Error('当前浏览器无法创建 WebGPU 上下文。');

  // ④配置上下文: 告诉它把渲染结果写进什么格式的纹理
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({
    device,
    format,
    // WebGL 的画布默认带透明度（gl.clearColor 默认 0,0,0,0），这里保持同样的表现
    alphaMode: 'premultiplied',
  });

  // ---------- 3. 着色器源码（WGSL） ----------
  // 与 1_basic_rendering_process_webgpu.js 完全一致：
  // 相机怎么动都不需要改着色器, 动的只是 uniform 里的 mvp 这一个矩阵。
  const shaderSource = /* wgsl */ `
    // vec3<f32> 按 16 字节对齐, 所以结构体总大小为 64 + 16 = 80 字节
    struct Uniforms {
      mvp:   mat4x4<f32>, // 偏移 0,  64 字节
      color: vec3<f32>,   // 偏移 64
    };

    @group(0) @binding(0) var<uniform> uniforms: Uniforms;

    @vertex
    fn vsMain(@location(0) position: vec3<f32>) -> @builtin(position) vec4<f32> {
      return uniforms.mvp * vec4<f32>(position, 1.0);
    }

    @fragment
    fn fsMain() -> @location(0) vec4<f32> {
      return vec4<f32>(uniforms.color, 1.0);
    }
  `;

  // ---------- 4. 创建着色器模块与渲染管线 ----------
  const shaderModule = device.createShaderModule({ code: shaderSource });

  const pipeline = device.createRenderPipeline({
    // layout: 'auto' 让管线自己推导绑定组布局, 之后用 getBindGroupLayout(0) 取回来即可
    layout: 'auto',
    vertex: {
      module: shaderModule,
      entryPoint: 'vsMain',
      // 顶点布局: 相当于 WebGL 的 vertexAttribPointer + enableVertexAttribArray
      buffers: [
        {
          arrayStride: 3 * 4, // 每个顶点 3 个 float32 = 12 字节
          stepMode: 'vertex',
          attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }], // 对应 @location(0)
        },
      ],
    },
    fragment: {
      module: shaderModule,
      entryPoint: 'fsMain',
      targets: [{ format }], // 颜色输出必须和上下文配置的格式一致
    },
    primitive: {
      topology: 'triangle-list',
      // WebGL 默认不开启面剔除, 这里保持 'none', 立方体六个面都能看到
      cullMode: 'none',
    },
    // WebGL 用 gl.enable(gl.DEPTH_TEST) 开启深度测试, WebGPU 则在管线里写死深度状态
    depthStencil: {
      format: 'depth24plus',
      depthWriteEnabled: true,
      depthCompare: 'less', // 对应 WebGL 默认的 gl.LESS
    },
  });

  // ---------- 5. 准备用于渲染的数据 ----------
  // 两类数据: 属性数据(vertex buffer) 和 uniform数据(uniform buffer + 绑定组)

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
  const positionData = new Float32Array(positions);

  // 上传属性数据的三步（WebGPU 没有 bindBuffer 这种全局状态, 创建即绑定）:
  // ①创+格 - 创建缓冲区, 声明用途: 顶点数据 + 允许拷贝写入
  const positionBuffer = device.createBuffer({
    size: positionData.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  // ②传 - 把数据从 CPU 拷到 GPU（相当于 gl.bufferData）
  device.queue.writeBuffer(positionBuffer, 0, positionData);
  // ③格+激 - 顶点布局与激活在管线创建时已经写好, 绘制时 setVertexBuffer 即可

  // 顶点个数: 每顶点 3 个分量, 绘制时按它决定画多少个顶点
  const vertexCount = positions.length / 3;

  // 上传uniform数据的四步:
  const CUBE_COLOR = [0.36, 0.55, 1.0];
  // ①创 - 创建一个 uniform 缓冲区, 大小 80 字节（64 矩阵 + 16 颜色）
  const uniformBuffer = device.createBuffer({
    size: 80,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  // ②创 - 创建绑定组, 把缓冲区挂到 WGSL 里 @group(0) @binding(0) 的位置上
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
  });
  // ③改 - 复用同一块 Float32Array 拼 uniform 数据, 每次重绘只改前 16 个分量
  const uniformData = new Float32Array(20); // 20 个 float32 = 80 字节
  uniformData.set(CUBE_COLOR, 16); // 颜色全程不变, 写一次即可
  device.queue.writeBuffer(uniformBuffer, 0, uniformData); // ④传

  // ---------- 6. 投影与相机状态 ----------
  // 投影只跟画布宽高比有关 → 放进 resize()
  const FOV = (45 * Math.PI) / 180;
  const NEAR = 0.1;
  const FAR = 100;
  let projection;   // 只在 resize() 里按当前画布宽高比生成
  let depthTexture; // 深度纹理跟随画布尺寸重建

  // 相机用「球坐标 + 观察点」描述, 这是轨道相机(Orbit)最省事的写法:
  //   · distance 决定远近（鼠标滚轮）
  //   · yaw / pitch 决定绕观察点的方位与仰角（拖动）
  //   · target 决定绕着谁转（右键平移）
  // 有了这几个量, 任意时刻都能重建出视图矩阵, 不需要自己去求相机朝向。
  const camera = {
    yaw: 0,            // 水平角: 绕 Y 轴, 0 表示相机在 +Z 正前方
    pitch: 0.25,       // 俯仰角: 正值表示相机在观察点上方（略微俯视, 与 WebGL 版初态一致）
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

    // 改动画布尺寸 = 改动上下文纹理尺寸, WebGPU 会自动跟随, 不需要再 configure
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    // WebGL 由上下文自己维护深度缓冲, WebGPU 要手动把深度纹理做成附件
    depthTexture?.destroy();
    depthTexture = device.createTexture({
      size: [width, height],
      format: 'depth24plus',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });

    // WebGL 的 gl.viewport(0, 0, width, height) 在 WebGPU 里由附件尺寸自动决定
    projection = perspective(FOV, width / height, NEAR, FAR);
    if (sizeStat) sizeStat.textContent = `${width} × ${height}`;

    render(); // 画布尺寸变化后需要重画一次
  }

  // ---------- 7. 绘制：没有 rAF 循环, 由「尺寸变化」和「相机变化」触发 ----------
  function render() {
    // 传 - uMvp: 相机一动视图矩阵就变, 所以每次重绘都重新拼一遍再上传
    //      （相当于 WebGL 里每次重绘调一次 gl.uniformMatrix4fv）
    uniformData.set(multiply(projection, buildView()), 0);
    device.queue.writeBuffer(uniformBuffer, 0, uniformData);

    // 状态设置 + 画: WebGPU 把状态与绘制都写进「渲染通道」, 最后统一提交
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: context.getCurrentTexture().createView(), // 每次重绘取当前帧的画布纹理
          clearValue: { r: 0, g: 0, b: 0, a: 0 },         // 对应 gl.clear + 默认透明清屏色
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
      depthStencilAttachment: {
        view: depthTexture.createView(),
        depthClearValue: 1.0, // 对应 gl.clear(gl.DEPTH_BUFFER_BIT)
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });

    // 相当于 gl.useProgram(program) + gl.bindBuffer + gl.drawArrays
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.setVertexBuffer(0, positionBuffer);
    pass.draw(vertexCount);
    pass.end();

    device.queue.submit([encoder.finish()]);
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

  // ---------- 9. 页面状态钩子 ----------
  document.body.dataset.api = 'webgpu';
  if (apiStat) apiStat.textContent = 'WebGPU';

  resize();
  window.addEventListener('resize', resize);
  document.body.classList.add('is-ready');
}
