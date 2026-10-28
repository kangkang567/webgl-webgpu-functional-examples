/**
 * 功能简介: WebGPU 渲染几何体的最基本流程（与 1_basic_rendering_process_webgl.js 绘制同一内容）
 * 作者: deepseek编写, wangweikang手动修改整理
 * 时间: 2026.10.23
 */

import { multiply, perspective, rotationX, translation } from '../utils/mat4.js';
import { showError } from '../utils/page-status.js';

// ---------- 1. 获取canvas元素 - 浏览器环境三维渲染基于canvas标签实现 ----------
const canvas = document.querySelector('#scene');
// 页面右下角唯一还在更新的读数：画布尺寸（FPS 需要渲染循环，本页是单次绘制）
const sizeStat = document.querySelector('#stat-size');
const apiStat = document.querySelector('#stat-api');

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
  // 与 GLSL 的区别:
  //   · 顶点与片元写在同一段代码里, 用 @vertex / @fragment 标注入口
  //   · 属性、输出都用 @location 显式声明编号, 不再靠「变量位置」查询
  //   · 顶点输入用 @location, 片元输出用 @location(0) 对应颜色附件
  const shaderSource = /* wgsl */ `
    // 注意 vec3<f32> 按 16 字节对齐, 所以结构体总大小为 64 + 16 = 80 字节
    struct Uniforms {
      mvp:   mat4x4<f32>,
      color: vec3<f32>,
    };

    // @group(0) @binding(0) 绑定0号绑定组中的1号槽位
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
  // createShaderModule 相当于 WebGL 的 createShader + compileShader（编译失败会在控制台报错）
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
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' }, // 对应 WGSL 的 @location(0)
          ],
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
  // 与 WebGL 的差别: WebGPU 的 uniform 数据也必须放在缓冲区里, 并通过绑定组送进管线

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

  // ---------- 6. 相机、投影与尺寸 ----------
  const fov = (45 * Math.PI) / 180;
  const view = multiply(translation(0, 0, -6.5), rotationX(0.25)); // 相机后移并轻微俯视，立方体居中
  let projection; // 只在 resize() 里按当前画布宽高比生成
  let depthTexture; // 深度纹理跟随画布尺寸重建

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
    projection = perspective(fov, width / height, 0.1, 100);
    if (sizeStat) sizeStat.textContent = `${width} × ${height}`;

    render(); // 画布尺寸变化后需要重画一次
  }

  // ---------- 7. 单次绘制：画面静止，没有 requestAnimationFrame 循环 ----------
  function render() {
    // 传 - uMvp: 投影矩阵会随画布尺寸变化, 所以每次重绘都重新计算并上传
    uniformData.set(multiply(projection, view), 0);
    device.queue.writeBuffer(uniformBuffer, 0, uniformData);

    // 状态设置 + 画: WebGPU 把状态与绘制都写进「渲染通道」, 最后统一提交
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: context.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 }, // 对应 gl.clear + 默认透明清屏色
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

  // ---------- 8. 页面状态钩子 ----------
  document.body.dataset.api = 'webgpu';
  if (apiStat) apiStat.textContent = 'WebGPU';

  resize();
  window.addEventListener('resize', resize);
  document.body.classList.add('is-ready');
}
