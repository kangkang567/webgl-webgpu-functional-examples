/**
 * 功能简介: WebGPU 图片纹理 —— 与 5_image_texture_webgl.js 绘制同一内容（立方体六面贴 cat.png）
 * 作者: deepseek编写, wangweikang手动修改整理
 * 时间: 2026.10.28
 *
 * 与 1_basic_rendering_process_webgpu.js 的差别:
 *   ① 顶点数据多一份纹理坐标（@location(1) uv: vec2<f32>）
 *   ② 片元不再输出纯色, 改成 textureSample(texture, sampler, uv)
 *   ③ 多一张纹理 + 一个采样器, 它们和 uniform 缓冲区一起挂进同一个绑定组
 *   ④ 图片加载是异步的, 纹理与绑定组都必须等图片到位后再建
 * 记忆点: WebGL 的「纹理单元 + bindTexture」在 WebGPU 里变成了「绑定组里的一个条目」。
 */

import { multiply, perspective, rotationX, rotationY, translation } from '../utils/mat4.js';
import { showError } from '../utils/page-status.js';

// ---------- 1. 获取canvas元素 - 浏览器环境三维渲染基于canvas标签实现 ----------
const canvas = document.querySelector('#scene');
const apiStat = document.querySelector('#stat-api');
// 页面右下角唯一还在更新的读数：画布尺寸（FPS 需要渲染循环，本页是单次绘制）
const sizeStat = document.querySelector('#stat-size');

// WebGPU 的初始化全是异步的（适配器、设备都要 await），所以入口是 async 函数
main().catch((error) => {
  console.error(error);
  showError(error.message);
});

async function main() {
  // ---------- 2. 创建 WebGPU 上下文 ----------
  // 显卡适配器 → 设备 → canvas 上下文 → 按格式配置上下文
  if (!navigator.gpu) throw new Error('当前浏览器不支持 WebGPU。');

  const adapter = await navigator.gpu.requestAdapter(); // ①适配器: 代表一块可用的显卡
  if (!adapter) throw new Error('没有可用的 WebGPU 适配器。');
  const device = await adapter.requestDevice(); // ②设备: 缓冲区、管线、纹理都由它创建

  device.lost.then((info) => {
    if (info.reason !== 'destroyed') showError(`WebGPU 设备丢失：${info.message}`);
  });

  const context = canvas.getContext('webgpu'); // ③上下文
  if (!context) throw new Error('当前浏览器无法创建 WebGPU 上下文。');

  const format = navigator.gpu.getPreferredCanvasFormat(); // ④配置上下文
  context.configure({
    device,
    format,
    alphaMode: 'premultiplied',
  });

  // ---------- 3. 着色器源码（WGSL） ----------
  // 与纯色版的区别:
  //   · 顶点多一个 @location(1) uv, 用 @location(0) 的输出结构体把它插值传给片元
  //   · 片元多了 sampler 与 texture_2d 两个资源, 它们在绑定组里各占一个 binding
  const shaderSource = /* wgsl */ `
    struct Uniforms {
      mvp: mat4x4<f32>, // 64 字节
    };

    @group(0) @binding(0) var<uniform> uniforms: Uniforms;
    @group(0) @binding(1) var textureSampler: sampler;          // 采样方式: 怎么插值、越界怎么办
    @group(0) @binding(2) var cubeTexture: texture_2d<f32>;     // 图片本身, 相当于 GLSL 的 sampler2D

    // 顶点着色器要输出两样东西: 裁剪空间坐标 + 插值用的纹理坐标
    struct VertexOutput {
      @builtin(position) position: vec4<f32>,
      @location(0) uv: vec2<f32>,
    };

    @vertex
    fn vsMain(
      @location(0) position: vec3<f32>,
      @location(1) uv: vec2<f32>,
    ) -> VertexOutput {
      var out: VertexOutput;
      out.position = uniforms.mvp * vec4<f32>(position, 1.0);
      // 纹理坐标只做插值, 不做任何变换（与 WebGL 版的 varying vec2 vUv 等价）
      out.uv = uv;
      return out;
    }

    @fragment
    fn fsMain(in: VertexOutput) -> @location(0) vec4<f32> {
      // 用插值后的纹理坐标采一个颜色, 与 GLSL 的 texture2D(uTexture, vUv) 等价
      return textureSample(cubeTexture, textureSampler, in.uv);
    }
  `;

  // ---------- 4. 创建着色器模块与渲染管线 ----------
  const shaderModule = device.createShaderModule({ code: shaderSource });

  const pipeline = device.createRenderPipeline({
    // layout: 'auto' 让管线按着色器里的资源声明自动推导绑定组布局
    layout: 'auto',
    vertex: {
      module: shaderModule,
      entryPoint: 'vsMain',
      // 顶点布局: 位置与纹理坐标各占一个顶点缓冲区（等同 WebGL 里两套 vertexAttribPointer）
      buffers: [
        {
          arrayStride: 3 * 4, // 每个顶点 3 个 float32 = 12 字节
          stepMode: 'vertex',
          attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }], // @location(0)
        },
        {
          arrayStride: 2 * 4, // 每个顶点 2 个 float32 = 8 字节
          stepMode: 'vertex',
          attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x2' }], // @location(1)
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
      // 与 WebGL 版一样不剔除面: 六个面都贴图, 正反面都要能看到
      cullMode: 'none',
    },
    // 开启深度测试, 否则背面会盖住正面
    depthStencil: {
      format: 'depth24plus',
      depthWriteEnabled: true,
      depthCompare: 'less',
    },
  });

  // ---------- 5. 准备顶点数据 ----------
  // 数据: 立方体 36 个顶点（6 面 × 2 三角形 × 3 顶点）, 与 WebGL 版完全相同
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

  // 数据: 每个顶点的纹理坐标 (u, v), 与 positions 一一对应, 范围固定 0~1
  // 六个面能共用同一组坐标, 是因为每个面都按「左下 → 右下 → 右上」的顺序排顶点;
  // 某个面的顶点顺序反了, 那个面的贴图就会镜像
  const FACE_UV = [0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1];
  const uvs = [];
  for (let face = 0; face < 6; face++) uvs.push(...FACE_UV);

  // 上传顶点数据的三步（与纯色版一致）: ①创+格 ②传 ③绘制时 setVertexBuffer
  function uploadVertexData(data) {
    const buffer = device.createBuffer({
      size: data.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(buffer, 0, data);
    return buffer;
  }

  const positionData = new Float32Array(positions);
  const positionBuffer = uploadVertexData(positionData);
  const uvBuffer = uploadVertexData(new Float32Array(uvs));

  // 顶点个数: 每顶点 3 个位置分量, 绘制时按它决定画多少个顶点
  const vertexCount = positions.length / 3;

  // ---------- 6. 图片 → 纹理 ----------
  // 对应 WebGL 版的「创 → 绑 → 参 → 图」, 但 WebGPU 没有全局状态:
  //   纹理对象承载「图片」, 采样器对象承载「采样参数」, 两者都通过绑定组交给着色器
  const bitmap = await loadImage('../assets/cat.png');

  // ①创 - 创建纹理: 尺寸取自图片本身, 格式 rgba8unorm 就是「每像素 4 个 8 位无符号归一化分量」
  //      usage 三件套: 能被着色器采样 + 能被拷贝写入 + 能作为拷贝目标（copyExternalImageToTexture 要求）
  const textureSize = [bitmap.width, bitmap.height];
  const texture = device.createTexture({
    size: textureSize,
    format: 'rgba8unorm',
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.RENDER_ATTACHMENT,
  });

  // ②图 - 把图片像素拷进纹理（相当于 gl.texImage2D）
  //      flipY: true 对应 WebGL 的 gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true):
  //      浏览器给 <img>/ImageBitmap 的原点在左上角, 而纹理坐标 v=0 在下方, 不翻转会上下颠倒
  device.queue.copyExternalImageToTexture(
    { source: bitmap, flipY: true },
    { texture },
    textureSize,
  );

  // ③参 - 采样器: 线性插值 + 越界取边缘。
  //      cat.png 是 400×400（非 2 的幂）, 这里只用一级纹理、不用 mipmap,
  //      所以 minFilter 取 'linear' 而不是 'linear-mipmap-linear' —— 后者需要先手动生成 mip 链
  const sampler = device.createSampler({
    magFilter: 'linear',
    minFilter: 'linear',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
  });

  // ---------- 7. uniform 缓冲区与绑定组 ----------
  // WebGL 的 uniform 是「按变量位置直接传值」; WebGPU 全部要塞进缓冲区, 再用绑定组挂到管线
  // 这里只有 mvp 一个矩阵, 16 个 float32 = 64 字节
  const uniformBuffer = device.createBuffer({
    size: 64,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const uniformData = new Float32Array(16);

  // 绑定组 = 一次性把三个资源按 WGSL 里的 binding 编号挂好:
  //   binding 0 → uniform 缓冲区   binding 1 → 采样器   binding 2 → 纹理视图
  // 这相当于 WebGL 里「activeTexture + bindTexture + uniform1i(采样器, 0)」三件事的合并版
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: uniformBuffer } },
      { binding: 1, resource: sampler },
      { binding: 2, resource: texture.createView() },
    ],
  });

  // ---------- 8. 相机、投影与尺寸 ----------
  const fov = (45 * Math.PI) / 180;
  // 相机后移、轻微俯视, 再绕 Y 转一点: 让 +Z / +X / +Y 三个面同时可见
  // （另外三个背面的贴图同样在, 只是被挡住; 把 rotationY 的数值改成 Math.PI 就能看到）
  const view = multiply(
    translation(0, 0, -6.5),
    multiply(rotationX(0.25), rotationY(0.55)),
  );
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

    projection = perspective(fov, width / height, 0.1, 100);
    if (sizeStat) sizeStat.textContent = `${width} × ${height}`;

    render(); // 画布尺寸变化后需要重画一次
  }

  // ---------- 9. 单次绘制：画面静止，没有 requestAnimationFrame 循环 ----------
  function render() {
    // 传 - mvp: 投影矩阵会随画布尺寸变化, 所以每次重绘都重新计算并上传
    uniformData.set(multiply(projection, view), 0);
    device.queue.writeBuffer(uniformBuffer, 0, uniformData);

    // 状态设置 + 画: WebGPU 把状态与绘制都写进「渲染通道」, 最后统一提交
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: context.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 }, // 与 WebGL 版的透明清屏色一致
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
      depthStencilAttachment: {
        view: depthTexture.createView(),
        depthClearValue: 1.0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });

    // 相当于 gl.useProgram + 绑定纹理 + gl.bindBuffer + gl.drawArrays
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup); // 纹理与采样器就是在这一步交给着色器的
    pass.setVertexBuffer(0, positionBuffer);
    pass.setVertexBuffer(1, uvBuffer);
    pass.draw(vertexCount);
    pass.end();

    device.queue.submit([encoder.finish()]);
  }

  // ---------- 10. 页面状态钩子 ----------
  document.body.dataset.api = 'webgpu';
  if (apiStat) apiStat.textContent = 'WebGPU';

  resize();
  window.addEventListener('resize', resize);
  document.body.classList.add('is-ready');
}

/* =============== 工具函数 =============== */

// 加载图片并解码成 ImageBitmap: WebGPU 的 copyExternalImageToTexture 接受它
// 路径相对「HTML 文档」(ui/index.html) 解析, 与当前 JS 模块所在目录无关
async function loadImage(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`纹理图片加载失败：${url}（HTTP ${response.status}）`);

  // imageOrientation 保持默认, 上下翻转交给 copyExternalImageToTexture 的 flipY 参数
  return createImageBitmap(await response.blob());
}
