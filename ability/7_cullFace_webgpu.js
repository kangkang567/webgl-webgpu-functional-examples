/**
 * 功能简介: WebGPU 面剔除 + 最便宜的调试辅助（坐标轴 / 地面网格）
 * 作者: deepseek编写, wangweikang手动修改整理
 * 时间: 2026.10.28
 *
 * 操作:
 *   鼠标: 左键拖动=旋转观察, 右键拖动=平移, 滚轮=缩放, 双击=复位视角
 *   键盘: 1=背面剔除  2=正面剔除  3=关闭剔除  F=翻转正面绕序  R=复位视角
 *
 * 与 7_cullFace_webgl.js 绘制同一内容、同一套交互:
 *   · 立方体顶点数据、单面片的 6 个索引、反转绕序的做法完全一样
 *   · 相机参数、光照参数、坐标轴 / 地面网格的数值完全一样, 左边的立方体同样绕 Y 轴自转
 *
 * 与 7_cullFace_webgl.js 的差别（本文件唯一的新知识点）:
 *   ① WebGL 的 cullFace / frontFace 是「上下文全局状态」, 现场改一行就生效;
 *      WebGPU 把它写死在渲染管线里 —— 管线一旦创建, 剔除模式与正面绕序都不能再改。
 *      于是「3 种剔除 × 2 种绕序」的 6 个组合必须在初始化时就全部建好,
 *      运行时只是 pass.setPipeline(对应的那条) —— WebGPU 里切换静态状态的通用套路。
 *   ② topology 同样是管线状态: 网格和坐标轴要用另一条 'line-list' 的管线,
 *      WebGL 里则是同一条程序里改 drawArrays 的第一个参数。
 *   ③ 索引绘制: gl.drawElements → pass.setIndexBuffer(缓冲, 'uint16') + pass.drawIndexed,
 *      索引格式成了必须写明的信息。
 *   ④ 两个物体的 uniform 用「同一条缓冲区 + 动态偏移」分开, 一次 writeBuffer 写完整块再提交。
 *
 * 面剔除为什么最便宜:
 *   它发生在光栅化之前。被剔除的三角形不进片元着色器、不写颜色也不写深度,
 *   等于凭空少画一半三角形, 一个 cullMode 就可能换回接近两倍的填充率。
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
  // 物体着色器: 一个平行光做基础明暗, 让立方体的三个可见面能分出层次
  // 面剔除是纯管线状态, 着色器里一行都不用写 —— 被剔除的三角形根本到不了这里
  // uniform 的对齐要自己算: mat4x4 = 64 字节, mat3x3 每列补到 16 共 48 字节, vec3 按 16 对齐
  const meshShaderSource = /* wgsl */ `
    struct MeshUniforms {
      mvp:            mat4x4<f32>, // 偏移 0,   64 字节
      normalMatrix:   mat3x3<f32>, // 偏移 64,  48 字节（3 列, 每列 3 个有效值 + 填充）
      color:          vec3<f32>,   // 偏移 112, 物体固有色
      lightDirection: vec3<f32>,   // 偏移 128, 平行光方向（世界空间, 指向光源）
      ambient:        f32,         // 偏移 144, 环境光比重, 保证背光面不是纯黑
    };                             // 整体 148 → 补齐到 16 的倍数 = 160 字节

    @group(0) @binding(0) var<uniform> uniforms: MeshUniforms;

    struct VertexOutput {
      @builtin(position) position: vec4<f32>,
      @location(0) normal: vec3<f32>,
    };

    @vertex
    fn vsMain(
      @location(0) position: vec3<f32>, // 对应 WebGL 的 aPosition
      @location(1) normal: vec3<f32>,   // 对应 WebGL 的 aNormal
    ) -> VertexOutput {
      var out: VertexOutput;
      out.normal = uniforms.normalMatrix * normal;
      out.position = uniforms.mvp * vec4<f32>(position, 1.0);
      return out;
    }

    @fragment
    fn fsMain(in: VertexOutput) -> @location(0) vec4<f32> {
      let N = normalize(in.normal);
      let L = normalize(uniforms.lightDirection);
      let diffuse = max(dot(N, L), 0.0);
      return vec4<f32>(uniforms.color * (uniforms.ambient + (1.0 - uniforms.ambient) * diffuse), 1.0);
    }
  `;

  // 调试辅助线着色器: 位置 + 颜色, 画网格和坐标轴
  // 线图元 'line-list' 没有「正面」的概念, 所以永远不会被面剔除影响
  const lineShaderSource = /* wgsl */ `
    struct LineUniforms {
      mvp: mat4x4<f32>, // 偏移 0, 64 字节
    };

    @group(0) @binding(0) var<uniform> uniforms: LineUniforms;

    struct VertexOutput {
      @builtin(position) position: vec4<f32>,
      @location(0) color: vec3<f32>,
    };

    @vertex
    fn vsMain(
      @location(0) position: vec3<f32>, // 对应 WebGL 的 aPosition
      @location(1) color: vec3<f32>,    // 对应 WebGL 的 aColor
    ) -> VertexOutput {
      var out: VertexOutput;
      out.color = color;
      out.position = uniforms.mvp * vec4<f32>(position, 1.0);
      return out;
    }

    @fragment
    fn fsMain(in: VertexOutput) -> @location(0) vec4<f32> {
      return vec4<f32>(in.color, 1.0);
    }
  `;

  // ---------- 4. 顶点数据: 一份顶点, 配两套索引 ----------
  // 顶点位置/法线是共享的, 唯一差别在索引 —— 这样「绕序」就是前后对比的唯一变量
  const CUBE_HALF_SIZE = 0.7;
  const cube = buildCube(CUBE_HALF_SIZE);

  const positionBuffer = createVertexBuffer(device, cube.positions); // 对应 WebGL 的 aPosition 缓冲
  const normalBuffer = createVertexBuffer(device, cube.normals);     // 对应 WebGL 的 aNormal 缓冲

  // 立方体的 36 个索引: 每个三角形从外面看都是逆时针, 所以正面朝外
  const cubeIndexBuffer = createIndexBuffer(device, cube.indices);
  const cubeIndexCount = cube.indices.length;

  // 单面片: 只取第一个面（+Z 面）的 6 个索引, 再反转绕序
  // 顶点还是那 24 个, 索引只用到 6 个 —— 面剔除是按三角形判断的, 少几个索引就少几片三角形
  const panelIndexBuffer = createIndexBuffer(device, reverseWinding(cube.indices.slice(0, 6)));
  const panelIndexCount = 6;

  // ---------- 5. 调试辅助: 坐标轴 + 地面网格 ----------
  // 网格间距 0.5, 覆盖 ±6; 坐标轴长度就是网格半径, Y 轴单独向上伸 2.5
  const GRID_HALF_SIZE = 6;
  const GRID_STEP = 0.5;
  const AXIS_Y_LENGTH = 2.5;
  const debugLines = buildDebugLines(GRID_HALF_SIZE, GRID_STEP, AXIS_Y_LENGTH);

  const linePositionBuffer = createVertexBuffer(device, debugLines.positions);
  const lineColorBuffer = createVertexBuffer(device, debugLines.colors);
  const lineVertexCount = debugLines.positions.length / 3;

  // ---------- 6. 光照参数（与 WebGL 版相同的数值） ----------
  const LIGHT_DIRECTION = [0.45, 0.8, 0.55]; // 平行光方向（指向光源）
  const AMBIENT = 0.35;

  // ---------- 7. uniform 缓冲区: 两个物体各占一段（动态偏移） ----------
  // 动态偏移的规则: 绑定时的偏移量必须是 minUniformBufferOffsetAlignment（常见 256）的倍数,
  // 所以每个物体分到 256 字节（160 字节数据 + 对齐填充）
  const MESH_UNIFORM_STRIDE = 256;                   // 每个物体占的字节数（256 的倍数）
  const MESH_UNIFORM_SIZE = 160;                     // MeshUniforms 结构体大小
  const MESH_SLICE_FLOATS = MESH_UNIFORM_STRIDE / 4; // 每段折算成 64 个 float32 槽位

  const meshUniformBuffer = device.createBuffer({
    size: MESH_UNIFORM_STRIDE * 2,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  // 复用同一个 Float32Array 拼数据
  const meshUniformData = new Float32Array(MESH_SLICE_FLOATS * 2);

  // 下标单位是 float32, 与上面 WGSL 结构体的字节偏移一一对应
  const MESH_OFFSET = {
    mvp: 0,             // 字节 0
    normalMatrix: 16,   // 字节 64, mat3x3 每列占 16 字节共 12 个 float
    color: 28,          // 字节 112, vec3 之后只补到 4 的倍数
    lightDirection: 32, // 字节 128
    ambient: 36,        // 字节 144
  };

  // 两个物体按固定顺序各占一段: 名字 → 切片序号
  const MESH_SLICE = { cube: 0, panel: 1 };
  // 两个物体的固有色, 与 WebGL 版相同
  const MESH_COLOR = { cube: [0.36, 0.55, 1.0], panel: [1.0, 0.62, 0.3] };

  // 不随重绘变化的量: 每段切片各写一份（两段互不覆盖, 所以一次提交内两个 draw 各读各的）
  Object.keys(MESH_SLICE).forEach((name) => {
    const base = MESH_SLICE[name] * MESH_SLICE_FLOATS;
    meshUniformData.set(MESH_COLOR[name], base + MESH_OFFSET.color);
    meshUniformData.set(LIGHT_DIRECTION, base + MESH_OFFSET.lightDirection);
    meshUniformData[base + MESH_OFFSET.ambient] = AMBIENT;
  });

  // 线只需要一个 mvp
  const lineUniformBuffer = device.createBuffer({
    size: 64,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const lineUniformData = new Float32Array(16);

  // ---------- 8. 绑定组布局与管线 ----------
  // 因为物体管线要用「动态偏移」, 不能用 layout: 'auto', 必须手写绑定组布局与管线布局
  const meshBindGroupLayout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, // 顶点和片元都要读这段 uniform
        buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: MESH_UNIFORM_SIZE },
      },
    ],
  });
  const meshPipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [meshBindGroupLayout] });

  const meshShaderModule = device.createShaderModule({ code: meshShaderSource });
  const lineShaderModule = device.createShaderModule({ code: lineShaderSource });

  // 顶点布局: 位置 / 法线各占一条顶点流（等同 WebGL 里两套 vertexAttribPointer）
  const meshVertexLayout = [
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
  ];

  // ★ 本文件的核心差别: 剔除模式与正面绕序是管线状态, 只能在创建管线时定死
  //   于是把「3 种剔除 × 2 种绕序」的 6 条管线一次性全建出来, 运行时用 setPipeline 切换
  //   cullMode  : 'back' / 'front' / 'none'  ↔  gl.cullFace(gl.BACK) / gl.FRONT / gl.disable(CULL_FACE)
  //   frontFace : 'ccw'  / 'cw'              ↔  gl.frontFace(gl.CCW) / gl.CW
  function createMeshPipeline(cullMode, frontFace) {
    return device.createRenderPipeline({
      layout: meshPipelineLayout,
      vertex: {
        module: meshShaderModule,
        entryPoint: 'vsMain',
        buffers: meshVertexLayout,
      },
      fragment: {
        module: meshShaderModule,
        entryPoint: 'fsMain',
        targets: [{ format }], // 颜色输出必须和上下文配置的格式一致
      },
      primitive: {
        topology: 'triangle-list',
        cullMode,  // 剔除哪一面
        frontFace, // 哪一侧算正面
      },
      // 两个物体互相遮挡, 必须有深度测试（对应 gl.enable(gl.DEPTH_TEST)）
      depthStencil: {
        format: 'depth24plus',
        depthWriteEnabled: true,
        depthCompare: 'less',
      },
    });
  }

  // 调试辅助线的管线: topology 也是管线状态, 所以必须单独建一条线管线
  // 线没有正反面, cullMode 固定 'none', 所以永远不受剔除状态影响
  const linePipeline = device.createRenderPipeline({
    layout: 'auto', // 线管线不用动态偏移, 让管线自己推导绑定组布局
    vertex: {
      module: lineShaderModule,
      entryPoint: 'vsMain',
      buffers: [
        {
          arrayStride: 3 * 4, // 位置
          stepMode: 'vertex',
          attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }],
        },
        {
          arrayStride: 3 * 4, // 颜色
          stepMode: 'vertex',
          attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }],
        },
      ],
    },
    fragment: {
      module: lineShaderModule,
      entryPoint: 'fsMain',
      targets: [{ format }],
    },
    primitive: {
      topology: 'line-list', // 对应 WebGL 的 gl.LINES
      cullMode: 'none',
    },
    depthStencil: {
      format: 'depth24plus',
      depthWriteEnabled: true,
      depthCompare: 'less',
    },
  });

  // 只建一次物体绑定组: 两个物体靠「动态偏移」指向缓冲区里属于自己的那 256 字节
  const meshBindGroup = device.createBindGroup({
    layout: meshBindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: meshUniformBuffer, offset: 0, size: MESH_UNIFORM_SIZE } },
    ],
  });

  const lineBindGroup = device.createBindGroup({
    layout: linePipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: lineUniformBuffer } }],
  });

  // ---------- 9. 剔除状态: 三种模式 + 正面绕序定义, 每种组合一条管线 ----------
  // 与 WebGL 版一一对应, 只是这里不能「现场 enable/disable」, 而是提前把管线建好
  const CULL_STATES = [
    { label: 'BACK', cullMode: 'back', desc: '背面剔除: 立方体是实心的, 右边反转绕序的单面片整片消失' },
    { label: 'FRONT', cullMode: 'front', desc: '正面剔除: 立方体近侧墙面被剔掉, 能看到内部; 单面片反而出现' },
    { label: 'OFF', cullMode: 'none', desc: '关闭剔除: 正反面都画, 两个物体都在（默认状态）' },
  ];

  // meshPipelines[剔除状态下标][绕序下标], 绕序下标: 0 = 逆时针为正面, 1 = 顺时针为正面
  const meshPipelines = CULL_STATES.map((state) => [
    createMeshPipeline(state.cullMode, 'ccw'),
    createMeshPipeline(state.cullMode, 'cw'),
  ]);

  let cullStateIndex = 2; // 默认: 关闭剔除
  let frontFaceIsCCW = true;

  // WebGL 里这一步是 gl.enable/cullFace/frontFace, WebGPU 里只剩下「记住用哪条管线」+ 更新界面读数
  function applyCullState() {
    const state = CULL_STATES[cullStateIndex];
    updateApiStat();
    updateHelpHighlight();
    console.info(`[cullFace] ${state.desc}${frontFaceIsCCW ? '' : '（正面绕序已翻转为 CW）'}`);
  }

  function updateApiStat() {
    if (apiStat) apiStat.textContent = `WebGPU · ${CULL_STATES[cullStateIndex].label}${frontFaceIsCCW ? '' : '·CW'}`;
  }

  // 让面板上的按键跟着当前状态高亮, 用户一眼能看出哪个模式生效
  function updateHelpHighlight() {
    helpPanel.cullKeys.forEach((key, index) => {
      if (key) key.classList.toggle('is-active', index === cullStateIndex);
    });
    if (helpPanel.flipKey) helpPanel.flipKey.classList.toggle('is-active', !frontFaceIsCCW);
  }

  // ---------- 10. 相机与投影 ----------
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

  let projection;   // 只在 resize() 里按当前画布宽高比生成
  let depthTexture; // 深度纹理跟随画布尺寸重建

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  // V = T(0,0,-d) · Rx(pitch) · Ry(-yaw) · T(-target)，写法与 4_camera_control_webgpu.js 一致
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

    // gl.viewport 由附件尺寸自动决定, 这里只需要按宽高比重算投影
    projection = perspective(FOV, width / height, NEAR, FAR);
    if (sizeStat) sizeStat.textContent = `${width} × ${height}`;
    // 渲染循环每帧都会重画, 这里不必手动 render()
  }

  // ---------- 11. 每帧绘制 ----------
  let viewProjection = new Float32Array(16); // 每帧算一次, 线框和两个物体共用

  // 法线矩阵: 模型矩阵只有旋转和平移（没有缩放）, 左上角 3x3 就是法线矩阵
  // uniform 里的 mat3x3 每列占 16 字节, 所以要拼成 12 个 float、每列末尾留 1 个填充
  function writeNormalMatrix(base, model) {
    meshUniformData.set([model[0], model[1], model[2], 0], base + MESH_OFFSET.normalMatrix);
    meshUniformData.set([model[4], model[5], model[6], 0], base + MESH_OFFSET.normalMatrix + 4);
    meshUniformData.set([model[8], model[9], model[10], 0], base + MESH_OFFSET.normalMatrix + 8);
  }

  // 把某个物体的矩阵写进它自己的那段切片（相当于 WebGL 里那几行 uniformMatrix*）
  function writeMatrices(model, name) {
    const base = MESH_SLICE[name] * MESH_SLICE_FLOATS;
    meshUniformData.set(multiply(viewProjection, model), base + MESH_OFFSET.mvp);
    writeNormalMatrix(base, model);
  }

  // 画一个网格 = 绑定共用的顶点数据 + 它的索引 + 指向自己那段 uniform 的动态偏移
  function drawMesh(pass, indexBuffer, indexCount, name) {
    // 第三个参数是动态偏移: 告诉着色器「uniforms 这一段从缓冲区的哪个字节开始」
    pass.setBindGroup(0, meshBindGroup, [MESH_SLICE[name] * MESH_UNIFORM_STRIDE]);
    pass.setVertexBuffer(0, positionBuffer); // 槽位 0 → @location(0) 位置
    pass.setVertexBuffer(1, normalBuffer);   // 槽位 1 → @location(1) 法线
    pass.setIndexBuffer(indexBuffer, 'uint16'); // 对应 WebGL 的 bindBuffer(ELEMENT_ARRAY_BUFFER)
    pass.drawIndexed(indexCount);            // 对应 gl.drawElements(gl.TRIANGLES, ...)
  }

  function render() {
    viewProjection = multiply(projection, buildView());

    // 传 - 每帧只写一次整块 uniform 缓冲区: WebGPU 里 uniform 的写入会先于本批命令全部落地,
    //      所以两个物体的矩阵必须先一起写进去, 不能边画边写
    // ① 左边: 完整的封闭立方体, 逆时针绕序, 绕 Y 轴自转
    writeMatrices(multiply(translation(-1.7, 0.7, 0), rotationY(spinAngle)), 'cube');
    // ② 右边: 单面片（同一个 +Z 面, 但绕序反了）, 模型矩阵只有平移, 正好贴在同一深度
    writeMatrices(translation(1.7, 0.7, 0), 'panel');
    device.queue.writeBuffer(meshUniformBuffer, 0, meshUniformData);

    lineUniformData.set(viewProjection, 0);
    device.queue.writeBuffer(lineUniformBuffer, 0, lineUniformData);

    // 画 - WebGPU 把状态与绘制都写进「渲染通道」, 最后统一提交
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

    // ① 调试辅助线: 网格和坐标轴只是空间参照物, 便宜到几乎不占性能（fixed 的线管线）
    pass.setPipeline(linePipeline);
    pass.setBindGroup(0, lineBindGroup);
    pass.setVertexBuffer(0, linePositionBuffer);
    pass.setVertexBuffer(1, lineColorBuffer);
    pass.draw(lineVertexCount); // 对应 gl.drawArrays(gl.LINES, 0, count)

    // ② ③ 两个物体: 换管线就是换剔除状态, 这里正是 WebGL 里「改全局状态」的位置
    pass.setPipeline(meshPipelines[cullStateIndex][frontFaceIsCCW ? 0 : 1]);
    drawMesh(pass, cubeIndexBuffer, cubeIndexCount, 'cube');
    drawMesh(pass, panelIndexBuffer, panelIndexCount, 'panel');
    pass.end();

    device.queue.submit([encoder.finish()]);
  }

  // ---------- 12. 渲染循环 ----------
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

  // ---------- 13. 鼠标控制相机（与 4_camera_control_webgpu.js 相同的轨道相机） ----------
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

  // ---------- 14. 键盘控制剔除 ----------
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

  // ---------- 15. 页面状态钩子与启动 ----------
  document.body.dataset.api = 'webgpu';
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
 *           这样默认的 frontFace = ccw（WebGL 同款约定）才会把外面认成正面。
 * 与 WebGL 版逐字相同: 这里只是数学, 不认识 gl 也不认识 device
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
 * 之所以网格线画在 y = 0 上还有效, 是因为 line-list 图元不参与面剔除
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

/* =============== 缓冲区 =============== */

/**
 * 上传一条顶点流（位置 / 法线 / 颜色都走这条路径）
 * WebGPU 没有 bindBuffer 这种全局状态: 创建即绑定, 绘制时 setVertexBuffer 指定槽位
 * 对应 WebGL 的: createBuffer + bindBuffer(ARRAY_BUFFER) + bufferData
 */
function createVertexBuffer(device, data) {
  const dataArray = new Float32Array(data);
  const buffer = device.createBuffer({
    size: dataArray.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(buffer, 0, dataArray);
  return buffer;
}

/**
 * 上传索引缓冲（16 位索引, 顶点数 < 65536 够用）
 * 对应 WebGL 的 ELEMENT_ARRAY_BUFFER, 绘制时还要在 setIndexBuffer 里写出格式
 */
function createIndexBuffer(device, indices) {
  const dataArray = new Uint16Array(indices);
  const buffer = device.createBuffer({
    size: dataArray.byteLength,
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(buffer, 0, dataArray);
  return buffer;
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
