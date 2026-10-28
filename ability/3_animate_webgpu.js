/**
 * 功能简介: WebGPU 实现 Phong 光照 + 立方体自动旋转动画（与 3_animate_webgl.js 绘制同一内容）
 * 作者: deepseek编写, wangweikang手动修改整理
 * 时间: 2026.10.28
 */

import { multiply, perspective, rotationX, rotationY, translation } from '../utils/mat4.js';
import { showError } from '../utils/page-status.js';

// ---------- 1. 获取canvas元素 - 浏览器环境三维渲染基于canvas标签实现 ----------
const canvas = document.querySelector('#scene');
const apiStat = document.querySelector('#stat-api');
const sizeStat = document.querySelector('#stat-size');
// 本页有渲染循环, 所以 FPS 这个读数终于有意义了
const fpsStat = document.querySelector('#stat-fps');

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
  // 与 WebGL 版的对应关系:
  //   · attribute  → @location(n) 顶点输入
  //   · varying    → 顶点着色器的返回值结构体（@location 标注的字段）
  //   · gl_Position→ @builtin(position)
  //   · 多个 uniform 变量 → 合并成一个 struct + 一块 uniform 缓冲区
  // 动画同样不需要改着色器: 立方体在动, 仅仅是每帧重写 mvp/model/normalMatrix 三个字段
  // 注意 uniform 的地址对齐规则（和 GLSL 不同, 必须自己算偏移）:
  //   mat4x4<f32> = 64 字节；mat3x3<f32> 每列补到 16 字节, 共 48 字节；vec3<f32> 按 16 字节对齐
  // 坑（本文件踩过）: vec3<f32> 的 size 只有 12 字节, 不是 16 —— 对齐要求 16 不代表占 16。
  //   所以 vec3 后面紧跟的 f32 只按 4 字节对齐: ambientColor 结束于 252, shininess 就落在 252,
  //   而不是"每个字段都占 16 字节"推出来的 256。错 4 字节 → shininess 读到 vec3 的填充位 0、
  //   specularStrength 读到 48, 结果 pow(rv, 0) = 1 处处满强度高光, 面上会出现随旋转游走的纯白斑块。
  const shaderSource = /* wgsl */ `
    struct Uniforms {
      mvp:            mat4x4<f32>, // 偏移 0,   64 字节
      model:          mat4x4<f32>, // 偏移 64,  64 字节
      normalMatrix:   mat3x3<f32>, // 偏移 128, 48 字节（3 列, 每列 16 字节）
      color:          vec3<f32>,   // 偏移 176
      lightColor:     vec3<f32>,   // 偏移 192
      lightPosition:  vec3<f32>,   // 偏移 208
      cameraPosition: vec3<f32>,   // 偏移 224
      ambientColor:   vec3<f32>,   // 偏移 240（vec3 占 12 字节, 结束于 252）
      shininess:      f32,         // 偏移 252（f32 只需 4 字节对齐, 紧贴 vec3 的 12 字节之后）
      specularStrength: f32,       // 偏移 256
    };                             // 成员共 260 字节, 结构体按 16 对齐 → 272

    @group(0) @binding(0) var<uniform> uniforms: Uniforms;

    // 顶点着色器输出 = WebGL 的 varying: 世界坐标与法线交给片元着色器
    struct VertexOutput {
      @builtin(position) position: vec4<f32>,
      @location(0) worldPosition: vec3<f32>,
      @location(1) normal: vec3<f32>,
    };

    @vertex
    fn vsMain(
      @location(0) position: vec3<f32>,
      @location(1) normal: vec3<f32>,
    ) -> VertexOutput {
      var out: VertexOutput;
      let worldPosition = uniforms.model * vec4<f32>(position, 1.0);
      out.worldPosition = worldPosition.xyz;
      out.normal = uniforms.normalMatrix * normal;
      out.position = uniforms.mvp * vec4<f32>(position, 1.0);
      return out;
    }

    // Phong 光照模型 = 环境光 + 漫反射 + 镜面高光（与 WebGL 版逐行对应）
    // 光源和相机都是世界空间里的固定位置, 立方体转过来时各面亮度会连续变化
    @fragment
    fn fsMain(in: VertexOutput) -> @location(0) vec4<f32> {
      let N = normalize(in.normal);                                  // 法线
      let L = normalize(uniforms.lightPosition - in.worldPosition);   // 指向光源
      let V = normalize(uniforms.cameraPosition - in.worldPosition);  // 指向相机

      // ① 环境光: 没有方向, 让背光面不是纯黑
      let ambient = uniforms.ambientColor * uniforms.color;

      // ② 漫反射: 法线与光线夹角越小越亮, 背面（点积为负）截断为 0
      let diffuseFactor = max(dot(N, L), 0.0);
      let diffuse = uniforms.color * uniforms.lightColor * diffuseFactor;

      // ③ 镜面高光（Phong）: 先求光线关于法线的反射向量 R, 再看 R 与视线 V 是否重合
      let R = reflect(-L, N);
      // 坑: WGSL 的 pow 等价于 exp2(y * log2(x)), x = 0 时会算出 NaN, NaN 会污染整个颜色
      //     （表现为立方体全黑）, 所以把 0 的情况用 select 单独处理
      let rv = max(dot(R, V), 0.0);
      let specularFactor = select(0.0, pow(rv, uniforms.shininess), rv > 0.0);
      let specular = uniforms.lightColor * uniforms.specularStrength * specularFactor;

      return vec4<f32>(ambient + diffuse + specular, 1.0);
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
      // 位置与法线各占一块缓冲区, 所以这里有两条 bufferLayout
      buffers: [
        {
          arrayStride: 3 * 4, // 位置: 每个顶点 3 个 float32 = 12 字节
          stepMode: 'vertex',
          attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }], // 对应 @location(0)
        },
        {
          arrayStride: 3 * 4, // 法线: 同样是 12 字节
          stepMode: 'vertex',
          attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }], // 对应 @location(1)
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

  // 数据: 每个顶点的法线, 与上面的位置数据一一对应（每个面 6 个相同法线）
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

  // 上传属性数据（位置与法线各一块缓冲区）:
  // ①创+格 - 创建缓冲区, 声明用途: 顶点数据 + 允许拷贝写入
  // ②传    - 把数据从 CPU 拷到 GPU（相当于 gl.bufferData）
  // ③格+激 - 顶点布局与激活在管线创建时已经写好, 绘制时 setVertexBuffer 即可
  function createVertexBuffer(data) {
    const dataArray = new Float32Array(data);
    const buffer = device.createBuffer({
      size: dataArray.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(buffer, 0, dataArray);
    return buffer;
  }

  const positionBuffer = createVertexBuffer(positions);
  const normalBuffer = createVertexBuffer(normals);

  // 顶点个数: 每顶点 3 个分量, 绘制时按它决定画多少个顶点
  const vertexCount = positions.length / 3;

  // 上传uniform数据的四步:
  const CUBE_COLOR = [0.36, 0.55, 1.0];     // 物体固有色
  const LIGHT_COLOR = [1.0, 1.0, 1.0];      // 白色光源
  const LIGHT_POSITION = [4.0, 6.0, 7.0];   // 光源放在物体右上前方
  const AMBIENT_COLOR = [0.16, 0.18, 0.22]; // 环境光偏冷, 让背光面有层次
  const SHININESS = 48.0;                   // 高光锐利度
  const SPECULAR_STRENGTH = 0.9;            // 高光强度

  // ①创 - 创建一个 uniform 缓冲区, 大小 272 字节 = 68 个 float32
  const UNIFORM_BYTES = 272;
  const uniformBuffer = device.createBuffer({
    size: UNIFORM_BYTES,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  // ②创 - 创建绑定组, 把缓冲区挂到 WGSL 里 @group(0) @binding(0) 的位置上
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
  });

  // ③改 - 复用同一块 Float32Array 拼 uniform 数据（下标单位是 float32 = 字节数 / 4, 对应上面的偏移表）
  // 动画中每帧都会重写 mvp / model / normalMatrix 这三段, 其余字段只写一次
  const uniformData = new Float32Array(UNIFORM_BYTES / 4);
  const OFFSET = {
    mvp: 0,           // 0   ~ 63
    model: 16,        // 64  ~ 127
    normalMatrix: 32, // 128 ~ 175, mat3x3 占 12 个 float（每列 3 个有效值 + 1 个填充）
    color: 44,        // 176
    lightColor: 48,   // 192
    lightPosition: 52,  // 208
    cameraPosition: 56, // 224
    ambientColor: 60, // 240
    shininess: 63,        // 252（不是 64！vec3 只占 12 字节, 它的填充位不算成员）
    specularStrength: 64, // 256
  };
  // 不随帧变化的量, 写一次即可
  uniformData.set(CUBE_COLOR, OFFSET.color);
  uniformData.set(LIGHT_COLOR, OFFSET.lightColor);
  uniformData.set(LIGHT_POSITION, OFFSET.lightPosition);
  uniformData.set(AMBIENT_COLOR, OFFSET.ambientColor);
  uniformData[OFFSET.shininess] = SHININESS;
  uniformData[OFFSET.specularStrength] = SPECULAR_STRENGTH;

  // ---------- 6. 相机与投影（动画中不变化） ----------
  const fov = (45 * Math.PI) / 180;
  const view = multiply(translation(0, 0, -6.5), rotationX(0.25)); // 相机后移并轻微俯视，立方体居中
  // 相机世界坐标: view = T(0,0,-6.5) · Rx(0.25), 反解出相机在世界空间的位置
  const CAMERA_POSITION = [0, 6.5 * Math.sin(0.25), 6.5 * Math.cos(0.25)];
  // 相机位置全程不变, 同样写一次即可
  uniformData.set(CAMERA_POSITION, OFFSET.cameraPosition);

  let projection;   // 只在 resize() 里按当前画布宽高比生成
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
    // 这里不再手动画一次: 渲染循环每帧都会重画, 下一帧自然就用上了新的 projection
  }

  // ---------- 7. 动画状态 ----------
  // 动画 = 每帧改一个变量（角度） → 重算矩阵 → 重写 uniform → 重新绘制, 循环往复
  const SPIN_SPEED = 0.6;      // 每秒转过的弧度（约 34°/s）, 与帧率无关
  const TILT_X = 0.35;         // 固定的 X 轴倾斜, 让顶面也朝向光源, 不至于只看到四个侧面
  let rotationAngle = -0.5;    // 起始角度, 与静态版 2_phonglight_webgpu.js 的初态一致
  let lastTime = 0;            // 上一帧的时间戳（毫秒）

  // FPS 统计: 每 0.5 秒结算一次, 避免数字疯狂跳动
  let frameCount = 0;
  let elapsed = 0;

  // 一段可复用的 mat3x3 缓冲（12 个 float32, 每列末尾 1 个填充位保持 0）
  // 复用而不是每帧 new, 避免渲染循环里产生垃圾对象
  const normalMatrix = new Float32Array(12);

  // 法线矩阵: 模型矩阵只有旋转, 左上角 3x3 就是「法线矩阵」
  // （若含非等比缩放, 必须用左上角 3x3 的逆转置, 否则法线会被拉歪）
  // 立方体在转 → 法线矩阵每帧都变, 必须跟着重算, 否则光照会「粘」在屏幕上看不出旋转
  function updateNormalMatrix(model) {
    normalMatrix[0] = model[0]; normalMatrix[1] = model[1]; normalMatrix[2] = model[2];
    normalMatrix[4] = model[4]; normalMatrix[5] = model[5]; normalMatrix[6] = model[6];
    normalMatrix[8] = model[8]; normalMatrix[9] = model[9]; normalMatrix[10] = model[10];
  }

  // ---------- 8. 每帧绘制 ----------
  function render() {
    // 算 - 用当前角度重建模型矩阵: 先绕 X 倾斜, 再绕 Y 旋转
    const model = multiply(rotationY(rotationAngle), rotationX(TILT_X));

    // 传 - 三个矩阵每帧都在变, 所以每帧拼数据 + 重写 uniform 缓冲区
    //      （相当于 WebGL 里每帧调三次 gl.uniformMatrix*）
    uniformData.set(multiply(projection, multiply(view, model)), OFFSET.mvp);
    uniformData.set(model, OFFSET.model);
    updateNormalMatrix(model);
    uniformData.set(normalMatrix, OFFSET.normalMatrix);
    device.queue.writeBuffer(uniformBuffer, 0, uniformData);

    // 状态设置 + 画: WebGPU 把状态与绘制都写进「渲染通道」, 最后统一提交
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: context.getCurrentTexture().createView(), // 每帧取当前帧的画布纹理
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

    // 相当于 gl.useProgram(program) + 绑两块缓冲区 + gl.drawArrays
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.setVertexBuffer(0, positionBuffer); // 槽位 0 → 位置（@location(0)）
    pass.setVertexBuffer(1, normalBuffer);   // 槽位 1 → 法线（@location(1)）
    pass.draw(vertexCount);
    pass.end();

    device.queue.submit([encoder.finish()]);
  }

  // ---------- 9. 渲染循环: requestAnimationFrame 驱动 ----------
  function frame(now) {
    // 第一帧没有上一帧时间戳, 按 0 处理
    if (lastTime === 0) lastTime = now;
    // 转成秒; 再截断到 0.1s —— 切到后台标签页再回来时时间差可能很大,
    // 不截断的话立方体会「瞬移」掉一大截角度, 看起来像跳帧
    const delta = Math.min((now - lastTime) / 1000, 0.1);
    lastTime = now;

    // 用时间增量推进角度, 而不是「每帧加一个固定值」:
    // 后者在 60Hz 与 144Hz 屏幕上转速会差两倍多
    rotationAngle += SPIN_SPEED * delta;

    render();

    // FPS 统计
    frameCount++;
    elapsed += delta;
    if (elapsed >= 0.5) {
      if (fpsStat) fpsStat.textContent = String(Math.round(frameCount / elapsed));
      frameCount = 0;
      elapsed = 0;
    }

    // 排下一帧: rAF 的回调会在浏览器下一次重绘前执行, 标签页隐藏时自动暂停
    requestAnimationFrame(frame);
  }

  // ---------- 10. 页面状态钩子 ----------
  document.body.dataset.api = 'webgpu';
  if (apiStat) apiStat.textContent = 'WebGPU';

  resize();
  window.addEventListener('resize', resize);
  document.body.classList.add('is-ready');

  requestAnimationFrame(frame);
}
