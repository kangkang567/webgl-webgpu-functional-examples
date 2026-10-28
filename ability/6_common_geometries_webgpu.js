/**
 * 功能简介: WebGPU 程序化几何体 —— 与 6_common_geometries_webgl.js 绘制同一内容（球 / 平面 / 圆环）
 * 作者: deepseek编写, wangweikang手动修改整理
 * 时间: 2026.10.28
 *
 * 与 WebGL 版完全一致的部分（可以直接对着看）:
 *   · 几何体生成函数 createSphere / createPlane / createTorus 一字不改, 调用参数也一样
 *     （球 1.3/24/32, 平面 16/16/12, 圆环 1.0/0.4/40/20）
 *   · 材质对象 materials 的 color / checkerColor / uvScale 数值相同
 *   · 光照参数、相机、三个物体的模型矩阵、动画速度也都相同
 * 可见两版的画面应当一模一样: 差别只在于「怎么把这些数据喂给 GPU」。
 *
 * 与 6_common_geometries_webgl.js 的差别:
 *   ① 上传方式: gl.bufferData → device.createBuffer + queue.writeBuffer
 *   ② 一个管线反复使用: 三次 gl.drawArrays → 三次 pass.draw, 换的只有 setVertexBuffer 与绑定组偏移
 *   ③ 三个物体要三份 uniform, 但一次提交前 queue.writeBuffer 的多次写入会「全部先落地」,
 *      用同一块缓冲区连写三次, 三个 draw 只会看到最后一份 → 这里用「切片 + 动态偏移」把三份放进同一块缓冲区
 *   ④ 每帧重新录制命令: 画布纹理由 getCurrentTexture() 提供, 命令缓冲区不能跨帧复用
 *
 * 记忆点: WebGL 的「bindBuffer + vertexAttribPointer」在 WebGPU 里变成
 *        「管线里写死布局 + 绘制时 setVertexBuffer」。
 */

import { multiply, perspective, rotationX, rotationY, translation } from '../utils/mat4.js';
import { showError } from '../utils/page-status.js';

// ---------- 1. 获取canvas元素 - 浏览器环境三维渲染基于canvas标签实现 ----------
const canvas = document.querySelector('#scene');
const apiStat = document.querySelector('#stat-api');
const sizeStat = document.querySelector('#stat-size');
// 本页有渲染循环, FPS 读数有效
const fpsStat = document.querySelector('#stat-fps');

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
  context.configure({ device, format, alphaMode: 'premultiplied' });

  // ---------- 3. 着色器源码（WGSL） ----------
  // 与 WebGL 版逐行对应: attribute → @location(n); varying → 返回结构体; 一堆 uniform → 一个 struct
  // uniform 的地址对齐必须自己算: mat4x4 = 64 字节, mat3x3 每列补到 16 共 48 字节, vec3 按 16 对齐
  const shaderSource = /* wgsl */ `
    struct Uniforms {
      mvp:              mat4x4<f32>, // 偏移 0,   64 字节
      model:            mat4x4<f32>, // 偏移 64,  64 字节
      normalMatrix:     mat3x3<f32>, // 偏移 128, 48 字节（3 列, 每列 3 个有效值 + 填充）
      color:            vec3<f32>,   // 偏移 176, 棋盘格颜色 A
      checkerColor:     vec3<f32>,   // 偏移 192, 棋盘格颜色 B
      lightColor:       vec3<f32>,   // 偏移 208
      lightPosition:    vec3<f32>,   // 偏移 224, 光源位置（世界空间）
      cameraPosition:   vec3<f32>,   // 偏移 240, 相机位置（世界空间）
      ambientColor:     vec3<f32>,   // 偏移 256
      uvScale:          f32,         // 偏移 268, 棋盘格密度
      shininess:        f32,         // 偏移 272, 高光锐利度
      specularStrength: f32,         // 偏移 276, 高光强度
    };                               // 整体 280 → 补齐到 16 的倍数 = 288 字节

    @group(0) @binding(0) var<uniform> uniforms: Uniforms;

    struct VertexOutput {
      @builtin(position) position: vec4<f32>,
      @location(0) worldPosition: vec3<f32>,
      @location(1) normal: vec3<f32>,
      @location(2) uv: vec2<f32>,
    };

    @vertex
    fn vsMain(
      @location(0) position: vec3<f32>,
      @location(1) normal: vec3<f32>,
      @location(2) uv: vec2<f32>,
    ) -> VertexOutput {
      var out: VertexOutput;
      // 几何体的形状只由 position 决定, 换个生成函数就换一个形状, 着色器一行都不用改
      let worldPosition = uniforms.model * vec4<f32>(position, 1.0);
      out.worldPosition = worldPosition.xyz;
      // 法线是从几何生成函数里算出来的, 它和位置一样要跟着模型矩阵一起转
      out.normal = uniforms.normalMatrix * normal;
      out.uv = uv;
      out.position = uniforms.mvp * vec4<f32>(position, 1.0);
      return out;
    }

    @fragment
    fn fsMain(in: VertexOutput) -> @location(0) vec4<f32> {
      // ① 用 UV 决定这一格是 A 色还是 B 色: floor 切成格子, 格子坐标之和的奇偶交替
      let cell = floor(in.uv * uniforms.uvScale);
      let isOdd = fract((cell.x + cell.y) * 0.5) * 2.0;
      let baseColor = mix(uniforms.color, uniforms.checkerColor, isOdd);

      let N = normalize(in.normal);                                  // 法线（决定明暗的关键）
      let L = normalize(uniforms.lightPosition - in.worldPosition);   // 指向光源
      let V = normalize(uniforms.cameraPosition - in.worldPosition);  // 指向相机

      // ② 环境光
      let ambient = uniforms.ambientColor * baseColor;

      // ③ 漫反射: 球面、圆环上的法线逐点变化, 所以明暗过渡是平滑的
      let diffuseFactor = max(dot(N, L), 0.0);
      let diffuse = baseColor * uniforms.lightColor * diffuseFactor;

      // ④ 镜面高光（Phong）
      let R = reflect(-L, N);
      // 坑: WGSL 的 pow 等价于 exp2(y * log2(x)), x = 0 会算出 NaN 并污染整个颜色（整块变黑）,
      //     所以把 0 的情况用 select 单独处理
      let rv = max(dot(R, V), 0.0);
      let specularFactor = select(0.0, pow(rv, uniforms.shininess), rv > 0.0);
      let specular = uniforms.lightColor * uniforms.specularStrength * specularFactor;

      return vec4<f32>(ambient + diffuse + specular, 1.0);
    }
  `;

  // ---------- 4. 生成三份几何体数据 ----------
  // 三个生成函数的返回值结构一致: { positions, normals, uvs }
  // 这部分与 WebGL 版完全相同 —— 几何体只是 CPU 算出来的普通数组, 跟 API 没关系
  const sphere = createSphere(1.3, 24, 32);
  const plane = createPlane(16, 16, 12);
  const torus = createTorus(1.0, 0.4, 40, 20);

  // ---------- 5. uniform 缓冲区: 三个物体各占一段（动态偏移） ----------
  // 动态偏移的规则: 绑定时的偏移量必须是 minUniformBufferOffsetAlignment（常见 256）的倍数,
  // 所以每个物体分到 512 字节（288 字节数据 + 对齐填充）
  const UNIFORM_STRIDE = 512;              // 每个物体占的字节数（256 的倍数）
  const UNIFORM_SIZE = 288;                // 结构体本身大小
  const SLICE_FLOATS = UNIFORM_STRIDE / 4; // 每段折算成 128 个 float32 槽位

  const uniformBuffer = device.createBuffer({
    size: UNIFORM_STRIDE * 3,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  // 复用同一个 Float32Array 拼数据
  const uniformData = new Float32Array(SLICE_FLOATS * 3);

  // 下标单位是 float32, 与上面 WGSL 结构体的字节偏移一一对应
  // 注意: vec3 的「大小」是 12 字节(对齐 16), 所以紧跟其后的 f32 只按 4 字节对齐,
  //       而不是从头再补 16 —— uvScale 落在 256 + 12 = 268, 不是 272 或 256 的下一个 16 倍数
  const OFFSET = {
    mvp: 0,               // 字节 0
    model: 16,            // 字节 64
    normalMatrix: 32,     // 字节 128, mat3x3 每列占 16 字节共 12 个 float
    color: 44,            // 字节 176
    checkerColor: 48,     // 字节 192
    lightColor: 52,       // 字节 208
    lightPosition: 56,    // 字节 224
    cameraPosition: 60,   // 字节 240
    ambientColor: 64,     // 字节 256
    uvScale: 67,          // 字节 268, vec3 之后只补到 4 的倍数
    shininess: 68,        // 字节 272
    specularStrength: 69, // 字节 276
  };

  // ---------- 6. 光照参数与材质 ----------
  // 以下数值与 6_common_geometries_webgl.js 完全相同: 同一份材质, 同一份光照
  const LIGHT_COLOR = [1.0, 1.0, 1.0];      // 白色光源
  const LIGHT_POSITION = [5.0, 7.0, 6.0];   // 光源放在物体右上前方
  const AMBIENT_COLOR = [0.16, 0.18, 0.22]; // 环境光偏冷, 让背光面有层次
  const SHININESS = 40.0;                   // 高光锐利度
  const SPECULAR_STRENGTH = 0.8;            // 高光强度

  // 同一套着色器, 只靠 uniform 区分材质; 同一份顶点数据, 只靠模型矩阵区分位置与朝向
  // 与 WebGL 版逐字相同的具名材质对象
  const materials = {
    plane: { color: [0.32, 0.35, 0.40], checkerColor: [0.24, 0.26, 0.30], uvScale: 16.0 },
    sphere: { color: [0.36, 0.55, 1.00], checkerColor: [0.80, 0.88, 1.00], uvScale: 10.0 },
    torus: { color: [1.00, 0.52, 0.30], checkerColor: [1.00, 0.82, 0.50], uvScale: 18.0 },
  };

  // 三个物体按固定顺序各占 uniform 缓冲区的一段: 名字 → 切片序号
  const MATERIAL_ORDER = ['plane', 'sphere', 'torus'];
  const MATERIAL_SLICE = { plane: 0, sphere: 1, torus: 2 };

  // 不随重绘变化的量: 每段切片各写一份（三段互不覆盖, 所以一次提交内三个 draw 各读各的）
  MATERIAL_ORDER.forEach((name, slice) => {
    const material = materials[name];
    const base = slice * SLICE_FLOATS;
    uniformData.set(material.color, base + OFFSET.color);
    uniformData.set(material.checkerColor, base + OFFSET.checkerColor);
    uniformData[base + OFFSET.uvScale] = material.uvScale;
    uniformData.set(LIGHT_COLOR, base + OFFSET.lightColor);
    uniformData.set(LIGHT_POSITION, base + OFFSET.lightPosition);
    uniformData.set(AMBIENT_COLOR, base + OFFSET.ambientColor);
    uniformData[base + OFFSET.shininess] = SHININESS;
    uniformData[base + OFFSET.specularStrength] = SPECULAR_STRENGTH;
  });

  // ---------- 7. 绑定组布局与管线 ----------
  // 因为要用「动态偏移」, 不能用 layout: 'auto', 必须手写绑定组布局与管线布局
  const bindGroupLayout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, // 顶点和片元都要读这段 uniform
        buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: UNIFORM_SIZE },
      },
    ],
  });
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });

  const shaderModule = device.createShaderModule({ code: shaderSource });

  const pipeline = device.createRenderPipeline({
    layout: pipelineLayout,
    vertex: {
      module: shaderModule,
      entryPoint: 'vsMain',
      // 顶点布局: 位置 / 法线 / UV 各占一条顶点流（等同 WebGL 里三套 vertexAttribPointer）
      buffers: [
        {
          arrayStride: 3 * 4, // 位置: 每个顶点 3 个 float32 = 12 字节
          stepMode: 'vertex',
          attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }], // @location(0)
        },
        {
          arrayStride: 3 * 4, // 法线: 同样是 12 字节
          stepMode: 'vertex',
          attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }], // @location(1)
        },
        {
          arrayStride: 2 * 4, // UV: 每个顶点 2 个 float32 = 8 字节
          stepMode: 'vertex',
          attributes: [{ shaderLocation: 2, offset: 0, format: 'float32x2' }], // @location(2)
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
      // 与 WebGL 版一样不开面剔除: 生成函数给出的绕序是「外部看逆时针」, 全画出来最直观
      cullMode: 'none',
    },
    // 三个物体互相遮挡, 必须有深度测试（对应 gl.enable(gl.DEPTH_TEST)）
    depthStencil: {
      format: 'depth24plus',
      depthWriteEnabled: true,
      depthCompare: 'less',
    },
  });

  // 只建一次绑定组: 三个物体靠「动态偏移」指向缓冲区里属于自己的那 512 字节
  const bindGroup = device.createBindGroup({
    layout: bindGroupLayout,
    entries: [{ binding: 0, resource: { buffer: uniformBuffer, offset: 0, size: UNIFORM_SIZE } }],
  });

  // ---------- 8. 上传三份顶点数据 ----------
  // 上传顶点数据的三步: ①创+格 ②传 ③绘制时 setVertexBuffer
  function createVertexBuffer(data) {
    const dataArray = new Float32Array(data);
    const buffer = device.createBuffer({
      size: dataArray.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(buffer, 0, dataArray);
    return buffer;
  }

  // 一个几何体 = 三条顶点流 + 顶点个数; 三种几何体共用管线, 缓冲区各建各的
  function uploadMesh(geometry) {
    return {
      positionBuffer: createVertexBuffer(geometry.positions),
      normalBuffer: createVertexBuffer(geometry.normals),
      uvBuffer: createVertexBuffer(geometry.uvs),
      vertexCount: geometry.positions.length / 3,
    };
  }

  // 与 WebGL 版相同的三个具名几何体（生成函数的参数见上面第 4 步, 也完全一致）
  const meshes = {
    sphere: uploadMesh(sphere),
    plane: uploadMesh(plane),
    torus: uploadMesh(torus),
  };

  // ---------- 9. 相机与投影 ----------
  const fov = (45 * Math.PI) / 180;
  const CAMERA_DISTANCE = 9.5;
  const CAMERA_PITCH = 0.34; // 相机向下俯视的角度, 让平面铺在画面下半部分
  const view = multiply(translation(0, 0, -CAMERA_DISTANCE), rotationX(CAMERA_PITCH));
  // 相机世界坐标: view = T(0,0,-d) · Rx(pitch), 反解出相机位置; 全程不变, 写一次即可
  const CAMERA_POSITION = [
    0,
    CAMERA_DISTANCE * Math.sin(CAMERA_PITCH),
    CAMERA_DISTANCE * Math.cos(CAMERA_PITCH),
  ];
  MATERIAL_ORDER.forEach((_, slice) => {
    uniformData.set(CAMERA_POSITION, slice * SLICE_FLOATS + OFFSET.cameraPosition);
  });

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

    projection = perspective(fov, width / height, 0.1, 100);
    if (sizeStat) sizeStat.textContent = `${width} × ${height}`;
    // 渲染循环每帧都会重画, 这里不必手动 render()
  }

  // ---------- 10. 动画状态 ----------
  const SPHERE_SPIN = 0.45; // 球每秒绕 Y 转的角度（球本身对称, 转起来看到的是 UV 在走）
  const TORUS_SPIN = 0.9;   // 圆环转快一点, 能看清管截面的法线在变
  const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  let sphereAngle = 0; // 球的自转角度
  let torusAngle = 0;  // 圆环的自转角度

  // 法线矩阵: 模型矩阵只有旋转和平移（没有缩放）, 左上角 3x3 就是法线矩阵
  // （若含非等比缩放, 必须用左上角 3x3 的逆转置, 否则法线会被拉歪）
  // uniform 里的 mat3x3 每列占 16 字节, 所以要拼成 12 个 float、每列末尾留 1 个填充
  function writeNormalMatrix(base, model) {
    uniformData.set([model[0], model[1], model[2], 0], base + OFFSET.normalMatrix);
    uniformData.set([model[4], model[5], model[6], 0], base + OFFSET.normalMatrix + 4);
    uniformData.set([model[8], model[9], model[10], 0], base + OFFSET.normalMatrix + 8);
  }

  // 把某个物体的矩阵写进它自己的那段切片（相当于 WebGL 里那三行 uniformMatrix*）
  function writeMatrices(model, name) {
    const base = MATERIAL_SLICE[name] * SLICE_FLOATS;
    uniformData.set(multiply(viewProjection, model), base + OFFSET.mvp);
    uniformData.set(model, base + OFFSET.model);
    writeNormalMatrix(base, model);
  }

  // 画一个几何体 = 绑定它的顶点数据 + 用它的材质（材质已在缓冲区里定好, 这里只给偏移）+ 绘制
  function drawMesh(pass, mesh, name) {
    // 第三个参数是动态偏移: 告诉着色器「uniforms 这一段从缓冲区的哪个字节开始」
    pass.setBindGroup(0, bindGroup, [MATERIAL_SLICE[name] * UNIFORM_STRIDE]);
    // 槽位 0/1/2 → 位置 / 法线 / UV（对应 @location(0)/(1)/(2)）
    pass.setVertexBuffer(0, mesh.positionBuffer);
    pass.setVertexBuffer(1, mesh.normalBuffer);
    pass.setVertexBuffer(2, mesh.uvBuffer);
    pass.draw(mesh.vertexCount);
  }

  // ---------- 11. 每帧绘制 ----------
  let viewProjection = new Float32Array(16); // resize() → render() 里会重新算

  function render() {
    viewProjection = multiply(projection, view);

    // ① 平面: 生成时就在 XZ 平面上, 法线朝 +Y, 不用转
    // ② 球: 先绕 Y 自转, 再平移到左边 —— 矩阵相乘的顺序是「右边的先作用」
    const sphereModel = multiply(translation(-2.9, 1.3, 0), rotationY(sphereAngle));
    // ③ 圆环: 先绕 X 立起来, 再绕 Y 自转, 最后平移到右边
    //    createTorus 生成的圆环是「平躺」在 XZ 面上的, 绕 X 转 90° 才立起来正对相机
    //    立起来后又歪了 0.35 弧度, 最低点大约在中心下方 1.34 处（R+r 投影得到的极值）,
    //    所以中心抬到 1.4, 底部刚好离平面 0.06, 不会穿进平面
    const torusModel = multiply(
      translation(2.9, 1.4, 0),
      multiply(rotationY(torusAngle), rotationX(Math.PI / 2 - 0.35)),
    );

    // 传 - 一次写完整块缓冲区: WebGPU 里 uniform 的写入会先于本批命令全部落地,
    //      所以三个物体的矩阵必须先一起写进去, 不能边画边写
    writeMatrices(IDENTITY, 'plane');
    writeMatrices(sphereModel, 'sphere');
    writeMatrices(torusModel, 'torus');
    device.queue.writeBuffer(uniformBuffer, 0, uniformData);

    // 画 - WebGPU 把状态与绘制都写进「渲染通道」, 最后统一提交
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
        depthClearValue: 1.0, // 对应 gl.clear(gl.DEPTH_BUFFER_BIT)
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });

    // 相当于 gl.useProgram + 三次「绑属性缓冲 + 传 uniform + gl.drawArrays」
    pass.setPipeline(pipeline);
    drawMesh(pass, meshes.plane, 'plane');
    drawMesh(pass, meshes.sphere, 'sphere');
    drawMesh(pass, meshes.torus, 'torus');
    pass.end();

    device.queue.submit([encoder.finish()]);
  }

  // ---------- 12. 渲染循环: requestAnimationFrame 驱动 ----------
  let lastTime = 0;
  let frameCount = 0; // FPS 统计: 每 0.5 秒结算一次
  let elapsed = 0;

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

  // ---------- 13. 页面状态钩子 ----------
  document.body.dataset.api = 'webgpu';
  if (apiStat) apiStat.textContent = 'WebGPU';

  resize();
  window.addEventListener('resize', resize);
  document.body.classList.add('is-ready');

  requestAnimationFrame(frame);
}

/* =============== 几何体生成函数 =============== */

// 统一的三角形绕序约定: 从物体外部看过去, 三个顶点是「逆时针」的
// 三个函数都按这个约定输出非索引的三角形列表（每 3 个顶点组成一个三角形, 可直接 pass.draw）
// 这些函数与 WebGL 版完全相同: 它们只做数学, 不认识 gl 也不认识 device

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
    normals.push(0, 1, 0);                             // 平面处处朝上, 所有顶点法线相同
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
