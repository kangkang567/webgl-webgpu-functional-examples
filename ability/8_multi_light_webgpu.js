/**
 * 功能简介: WebGPU 多光源（uniform 数组）+ Phong 与 Blinn-Phong 高光对比
 * 作者: deepseek编写, wangweikang手动修改整理
 * 时间: 2026.10.29
 *
 * 操作:
 *   鼠标: 左键拖动=旋转观察, 右键拖动=平移, 滚轮=缩放, 双击=复位视角
 *   键盘: 1/2/3/4=开关对应光源  P=暂停/继续光源旋转  R=复位视角
 *
 * 与 8_multi_light_webgl.js 绘制同一内容、同一套交互:
 *   四盏灯的轨道/颜色/强度、两个球的位置与固有色、shininess、相机参数完全一致;
 *   左边 Phong, 右边 Blinn-Phong, 场景关于 x = 0 平面对称, 画面唯一的差别只来自高光模型。
 *
 * 差别一（本文件的核心知识点）: 光照数组的「下标 → 字节偏移」必须自己算
 *   WebGL 靠名字查位置: gl.getUniformLocation('uLights[1].color'), 映射由驱动维护;
 *   WebGPU 里同一件事就是纯算术 —— 着色器写 array<Light, 4>, 缓冲区里按偏移自己填:
 *
 *     struct Light { position: vec3<f32>, color: vec3<f32> };   // 每盏灯占 32 字节
 *
 *     | 数据               | 字节偏移            | float32 下标      |
 *     | ------------------ | ------------------- | ----------------- |
 *     | lights[i].position | LIGHTS + i*32 + 0   | lights + i*8 + 0  |
 *     | lights[i].color    | LIGHTS + i*32 + 16  | lights + i*8 + 4  |
 *
 *   vec3 只有 12 字节, 但在结构体 / 数组元素里必须按 16 字节对齐, 所以 32 字节里
 *   有 2 个 float 是填充。算错 4 个字节不会报错, 只会出现「位置读到颜色」这种
 *   静默错误 —— 这是 WebGPU 里最容易犯也最难查的一类错。
 *   （2_phonglight_webgpu.js 里那份 Uniforms 偏移表是单光源版本, 这里是数组版本。）
 *
 * 差别二: 两个球只有 useBlinn 一个值不同, 但 WebGPU 没有「改一个 uniform 再画一次」
 *   queue.writeBuffer 的写入会先于整批命令全部落地（边写边画拿不到中间值）, 所以借
 *   7_cullFace_webgpu.js 的同一招: 一块缓冲区切两段 + 动态偏移, 每条 draw 指向自己那段;
 *   WebGL 里那句 gl.uniform1f(useBlinnLocation, ...) 就变成了 setBindGroup 的第三个参数。
 *
 * 差别三: gl_PointSize 在 WebGPU 里没有对应物
 *   'point-list' 图元永远是 1 像素, 高 DPI 屏上几乎看不见。所以光源标记改成「实例化四边形」:
 *   6 个角点的偏移 + 每盏灯一份实例数据(vec3 位置 + vec3 颜色), 顶点着色器在裁剪空间里
 *   按像素尺寸外扩（偏移量乘 clip.w 抵消透视除法）, 得到一个屏幕对齐的小方块。
 *
 * 保留的 WebGL 版做法: 关灯 = 把颜色传黑, 循环次数永远是常量 4,
 *   循环里没有任何按光源判断的分支, 四盏灯永远一次性全传。
 *
 * 场景布置: 四盏点光源成对镜像、各自绕中心公转;
 *   1/2 是暖黄一对、3/4 是冷蓝一对, 每对的 mirror 互为 ±1, 于是场景关于 x = 0 对称。
 */

import { multiply, perspective, rotationX, rotationY, translation } from '../utils/mat4.js';
import { showError } from '../utils/page-status.js';

// ---------- 1. 获取canvas元素 - 浏览器环境三维渲染基于canvas标签实现 ----------
const canvas = document.querySelector('#scene');
const apiStat = document.querySelector('#stat-api');
const sizeStat = document.querySelector('#stat-size');
// 本页光源一直在动, 是持续渲染循环, FPS 读数有效
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
  // 与 WebGL 版的对应关系:
  //   · attribute vec3 aPosition/aNormal → @location(0)/@location(1)
  //   · varying                          → 顶点着色器的返回值结构体
  //   · uniform Light uLights[4]         → 结构体里的 array<Light, 4>（偏移要自己算）
  // uniform 的对齐要自己算: mat4x4 = 64 字节, mat3x3 每列补到 16 共 48 字节, vec3 按 16 对齐
  const meshShaderSource = /* wgsl */ `
    // 光源数量必须和 JS 里的 MAX_LIGHTS 一致: 着色器与 JS 互相读不到对方的值
    const MAX_LIGHTS: u32 = 4u;

    // 光源 = 一组参数的集合; 两个 vec3 各占 16 字节, 所以每个 Light 是 32 字节
    struct Light {
      position: vec3<f32>, // 偏移 0,  世界空间的光源位置（点光源）
      color: vec3<f32>,    // 偏移 16, 颜色 × 强度; 传 0 表示这盏灯关掉了
    };

    struct MeshUniforms {
      mvp:              mat4x4<f32>,          // 字节 0,   64 字节
      model:            mat4x4<f32>,          // 字节 64,  64 字节（光照在世界空间算）
      normalMatrix:     mat3x3<f32>,          // 字节 128, 48 字节（3 列, 每列 3 有效值 + 填充）
      color:            vec3<f32>,            // 字节 176, 12 字节; 下一个 vec3 对齐 16 → 跳到 192
      cameraPosition:   vec3<f32>,            // 字节 192, 算高光要用
      ambientColor:     vec3<f32>,            // 字节 208, 占 208~220
      shininess:        f32,                  // 字节 220 ★ 紧跟 vec3 之后, 不补空
      specularStrength: f32,                  // 字节 224
      useBlinn:         f32,                  // 字节 228, 1 = Blinn-Phong, 0 = Phong
      lights:           array<Light, MAX_LIGHTS>, // 字节 240（数组对齐 16, 从 232 跳到 240）
    };                                        // 整体 368 字节

    @group(0) @binding(0) var<uniform> uniforms: MeshUniforms;

    struct VertexOutput {
      @builtin(position) position: vec4<f32>,
      @location(0) worldPosition: vec3<f32>,
      @location(1) normal: vec3<f32>,
    };

    @vertex
    fn vsMain(
      @location(0) position: vec3<f32>, // 对应 WebGL 的 aPosition
      @location(1) normal: vec3<f32>,   // 对应 WebGL 的 aNormal
    ) -> VertexOutput {
      var out: VertexOutput;
      let worldPosition = uniforms.model * vec4<f32>(position, 1.0);
      out.worldPosition = worldPosition.xyz;
      out.normal = uniforms.normalMatrix * normal;
      out.position = uniforms.mvp * vec4<f32>(position, 1.0);
      return out;
    }

    // 多光源着色器: 比单光源版本只多了「数组 + 循环累加」
    @fragment
    fn fsMain(in: VertexOutput) -> @location(0) vec4<f32> {
      let N = normalize(in.normal);                                 // 法线
      let V = normalize(uniforms.cameraPosition - in.worldPosition); // 指向相机（视线）

      // ① 环境光: 与光源无关, 循环外算一次
      let ambient = uniforms.ambientColor * uniforms.color;

      // ② ③ 四盏灯逐盏累加
      var diffuseSum = vec3<f32>(0.0);
      var specularSum = vec3<f32>(0.0);

      // 下标是运行时循环变量: WebGPU 允许动态下标（WebGL1 反而要求常量下标）
      for (var i: u32 = 0u; i < MAX_LIGHTS; i = i + 1u) {
        let light = uniforms.lights[i]; // 读结构体数组, 偏移由编译器按上面的对齐规则算好

        let toLight = light.position - in.worldPosition;
        let dist = length(toLight);
        let L = toLight / dist; // 指向光源（已归一化）

        // 点光源衰减: 越远越暗。没有它, 四盏灯叠加必然过曝成一片白
        let attenuation = 1.0 / (1.0 + 0.07 * dist * dist);
        let litColor = light.color * attenuation;

        // 漫反射（Lambert）: 背面（点积为负）截断为 0
        let diffuseFactor = max(dot(N, L), 0.0);
        diffuseSum = diffuseSum + uniforms.color * litColor * diffuseFactor;

        // 镜面高光: 两种模型只差「拿什么方向去点积」
        // pow 的坑见 2_phonglight_webgpu.js: 底数为 0 时可能算出 NaN 污染整个颜色
        var specularFactor: f32 = 0.0;
        if (uniforms.useBlinn > 0.5) {
          let H = normalize(L + V); // Blinn-Phong: 半程向量
          let nh = max(dot(N, H), 0.0);
          specularFactor = select(0.0, pow(nh, uniforms.shininess), nh > 0.0);
        } else {
          let R = reflect(-L, N); // Phong: 反射向量
          let rv = max(dot(R, V), 0.0);
          specularFactor = select(0.0, pow(rv, uniforms.shininess), rv > 0.0);
        }
        specularSum = specularSum + litColor * uniforms.specularStrength * specularFactor;
      }

      return vec4<f32>(ambient + diffuseSum + specularSum, 1.0);
    }
  `;

  // 光源标记着色器: WebGL 用 gl.POINTS + gl_PointSize, WebGPU 用实例化四边形代替
  // 顶点 0: 6 个角点（两步三角形）; 顶点 1: 每盏灯一份实例数据（位置 + 颜色）
  const markerShaderSource = /* wgsl */ `
    struct MarkerUniforms {
      mvp:          mat4x4<f32>, // 字节 0,  64 字节
      viewportSize: vec2<f32>,   // 字节 64, 绘制缓冲区的像素尺寸
      pointSize:    f32,         // 字节 72, 标记点的像素大小
    };                           // 整体 80 字节

    @group(0) @binding(0) var<uniform> uniforms: MarkerUniforms;

    struct VertexOutput {
      @builtin(position) position: vec4<f32>,
      @location(0) color: vec3<f32>,
    };

    @vertex
    fn vsMain(
      @location(0) corner: vec2<f32>,          // 四边形角点, 取值 -1 ~ 1
      @location(1) instancePosition: vec3<f32>, // 每盏灯的世界坐标
      @location(2) instanceColor: vec3<f32>,    // 每盏灯的颜色
    ) -> VertexOutput {
      var out: VertexOutput;

      let clip = uniforms.mvp * vec4<f32>(instancePosition, 1.0);
      // 屏幕对齐: 先在像素空间外扩, 再换算成 NDC（2 / 视口尺寸）;
      // 乘 clip.w 是为了抵消之后的透视除法, 保证远近处标记的像素大小一致
      let halfSize = uniforms.pointSize * 0.5;
      let ndcOffset = vec2<f32>(
        corner.x * halfSize * 2.0 / uniforms.viewportSize.x,
        corner.y * halfSize * 2.0 / uniforms.viewportSize.y
      );

      out.position = vec4<f32>(clip.xy + ndcOffset * clip.w, clip.z, clip.w);
      out.color = instanceColor;
      return out;
    }

    @fragment
    fn fsMain(in: VertexOutput) -> @location(0) vec4<f32> {
      return vec4<f32>(in.color, 1.0);
    }
  `;

  // ---------- 4. 球体数据: 左右两个球共用一份 ----------
  // 几何 / 固有色 / 光源 / shininess 全部相同, 唯一变量是高光模型 → 对比才公平
  // 选球体不选立方体: 曲面法线连续, 高光斑一定落在看得见的地方, 大小与柔和的差别一眼可辨
  const SPHERE_RADIUS = 0.72;
  const sphere = buildSphere(SPHERE_RADIUS);

  const spherePositionBuffer = createVertexBuffer(device, sphere.positions); // 对应 aPosition
  const sphereNormalBuffer = createVertexBuffer(device, sphere.normals);     // 对应 aNormal
  const sphereIndexBuffer = createIndexBuffer(device, sphere.indices);       // 对应 ELEMENT_ARRAY_BUFFER
  const sphereIndexCount = sphere.indices.length;

  // ---------- 5. 四盏点光源（数组） ----------
  // 每盏灯的参数: 公转半径 / 高度 / 角速度 / 初相位 / 颜色（颜色里已经含强度）
  const MAX_LIGHTS = 4; // 必须与着色器里的 const MAX_LIGHTS = 4u 一致
  // 四盏灯成对镜像布置: 1/2 是一对暖白, 3/4 是一对冷蓝, 每对的 mirror 互为 ±1。
  // 镜像布置让整个场景关于 x = 0 平面对称 —— 左右两个球体接到的光完全对称,
  // 于是画面上唯一的差别只可能来自高光模型, 对比才有说服力。
  const LIGHTS = [
    { name: '暖黄·右', color: [1.25, 0.95, 0.58], radius: 3.6, height: 0.9, speed: 0.45, phase: 0.0, mirror: 1, enabled: true },
    { name: '暖黄·左', color: [1.25, 0.95, 0.58], radius: 3.6, height: 0.9, speed: 0.45, phase: 0.0, mirror: -1, enabled: true },
    { name: '冷蓝·右', color: [0.22, 0.50, 1.00], radius: 3.6, height: -0.3, speed: -0.65, phase: 1.9, mirror: 1, enabled: true },
    { name: '冷蓝·左', color: [0.22, 0.50, 1.00], radius: 3.6, height: -0.3, speed: -0.65, phase: 1.9, mirror: -1, enabled: true },
  ];

  const LIGHT_ORBIT_CENTER = [0, 1.1, 0]; // 四盏灯绕这个点公转
  const BLACK = [0, 0, 0];                // 「关灯」= 颜色传黑, 循环照跑, 只是不贡献亮度

  // 每盏灯当前的世界坐标, 每帧由 updateLightPositions() 重算
  LIGHTS.forEach((light) => {
    light.position = LIGHT_ORBIT_CENTER.slice();
  });

  // ---------- 6. 光照与材质参数（不随重绘变化的部分） ----------
  // 深一点的固有色: 高光才跳得出来, 否则亮色物体把高光「吃掉」, Phong 与 Blinn 看不出区别
  const SPHERE_COLOR = [0.55, 0.56, 0.62];  // 两个球体的固有色完全一样
  const AMBIENT_COLOR = [0.16, 0.17, 0.20]; // 环境光偏冷: 抬亮背光面, 又不会吃掉多光源的对比
  const SHININESS = 18.0;                   // 两边同值: Blinn 的高光天生更宽, 差异才看得出来
  const SPECULAR_STRENGTH = 1.0;            // 高光强度

  // ---------- 7. uniform 缓冲区: 一个球一段（动态偏移） ----------
  // 动态偏移的规则: 绑定时的偏移量必须是 minUniformBufferOffsetAlignment（常见 256）的倍数,
  // 所以每段分到 512 字节（368 字节数据 + 对齐填充）
  const MESH_UNIFORM_SIZE = 368;                     // MeshUniforms 结构体大小（字节）
  const MESH_UNIFORM_STRIDE = 512;                   // 每个球占的字节数（256 的倍数）
  const MESH_SLICE_FLOATS = MESH_UNIFORM_STRIDE / 4; // 每段折算成 128 个 float32 槽位

  const meshUniformBuffer = device.createBuffer({
    size: MESH_UNIFORM_STRIDE * 2,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  // 复用同一个 Float32Array 拼数据（下标单位是 float32, 与上面 WGSL 结构体的字节偏移一一对应）
  const meshUniformData = new Float32Array(MESH_SLICE_FLOATS * 2);

  // ★ vec3 只占 12 字节, 不占 16: 紧跟其后的「标量」直接接上, 不会补空;
  //   只有对齐要求 ≥ 16 的成员（vec3 / mat4 / 数组）才需要跳到下一个 16 的倍数。
  //   把 shininess 当成 224（多补了 4 字节）是这里最容易犯的错 —— 结果 shininess 读到 0,
  //   pow(x, 0) 恒等于 1, 高光铺满整个球面, 球就变成一片纯白。
  const MESH_OFFSET = {
    mvp: 0,              // 字节 0
    model: 16,           // 字节 64
    normalMatrix: 32,    // 字节 128, mat3x3 每列占 16 字节共 12 个 float
    color: 44,           // 字节 176
    cameraPosition: 48,  // 字节 192
    ambientColor: 52,    // 字节 208, 占 208~220
    shininess: 55,       // 字节 220, 紧跟 vec3 的 12 字节之后
    specularStrength: 56,// 字节 224
    useBlinn: 57,        // 字节 228
    lights: 60,          // 字节 240, 四盏灯从这里开始
  };
  // ★ 光照数组的偏移表: 与 WebGL 的 'uLights[i].position' / '.color' 一一对应
  const LIGHT_STRIDE_FLOATS = 8;    // 每盏灯 32 字节 = 8 个 float（其中 2 个是填充）
  const LIGHT_COLOR_OFFSET = 4;     // 颜色在每盏灯内部的 float 偏移（16 字节 / 4）
  // 也就是说: 第 i 盏灯位置 = MESH_OFFSET.lights + i * 8, 颜色 = 再 + 4

  // 两个球按固定顺序各占一段: 名字 → 切片序号（左 Phong, 右 Blinn-Phong）
  const MESH_SLICE = { left: 0, right: 1 };

  // 不随重绘变化的量: 每段切片各写一份
  Object.entries(MESH_SLICE).forEach(([name, slice]) => {
    const base = slice * MESH_SLICE_FLOATS;
    meshUniformData.set(SPHERE_COLOR, base + MESH_OFFSET.color);
    meshUniformData.set(AMBIENT_COLOR, base + MESH_OFFSET.ambientColor);
    meshUniformData[base + MESH_OFFSET.shininess] = SHININESS;
    meshUniformData[base + MESH_OFFSET.specularStrength] = SPECULAR_STRENGTH;
    // WebGL 里这一行是每次 draw 前的 gl.uniform1f(uUseBlinn, ...), 这里只能按切片写死
    meshUniformData[base + MESH_OFFSET.useBlinn] = name === 'right' ? 1 : 0;
  });

  // 光源标记的 uniform: mvp + 视口尺寸 + 像素大小
  const markerUniformBuffer = device.createBuffer({
    size: 80,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const markerUniformData = new Float32Array(20); // 80 字节 / 4
  const MARKER_OFFSET = { mvp: 0, viewportSize: 16, pointSize: 18 };

  // 标记点的四边形: 两个三角形拼成一个正方形, 角点取值 -1 ~ 1
  const QUAD_CORNERS = [
    -1, -1, 1, -1, 1, 1,
    -1, -1, 1, 1, -1, 1,
  ];
  const quadCornerBuffer = createVertexBuffer(device, QUAD_CORNERS);

  // 每盏灯的实例数据: vec3 位置 + vec3 颜色 = 24 字节, 每帧重新上传
  const markerInstanceBuffer = device.createBuffer({
    size: MAX_LIGHTS * 6 * 4,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  const markerInstanceData = new Float32Array(MAX_LIGHTS * 6);

  // ---------- 8. 绑定组布局与管线 ----------
  // 物体管线要用「动态偏移」, 不能用 layout: 'auto', 必须手写绑定组布局与管线布局
  const meshBindGroupLayout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, // 顶点和片元都要读这段 uniform
        buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: MESH_UNIFORM_SIZE },
      },
    ],
  });

  const meshShaderModule = device.createShaderModule({ code: meshShaderSource });
  const markerShaderModule = device.createShaderModule({ code: markerShaderSource });

  const meshPipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [meshBindGroupLayout] }),
    vertex: {
      module: meshShaderModule,
      entryPoint: 'vsMain',
      // 位置 / 法线各占一条顶点流（等同 WebGL 里两套 vertexAttribPointer）
      buffers: [
        {
          arrayStride: 3 * 4, // 位置: 每个顶点 3 个 float32 = 12 字节
          stepMode: 'vertex',
          attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }],
        },
        {
          arrayStride: 3 * 4, // 法线: 同样是 12 字节
          stepMode: 'vertex',
          attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }],
        },
      ],
    },
    fragment: {
      module: meshShaderModule,
      entryPoint: 'fsMain',
      targets: [{ format }], // 颜色输出必须和上下文配置的格式一致
    },
    primitive: {
      topology: 'triangle-list',
      cullMode: 'none', // WebGL 默认不开启面剔除, 这里保持一致
    },
    // WebGL 用 gl.enable(gl.DEPTH_TEST) 开启深度测试, WebGPU 则在管线里写死深度状态
    depthStencil: {
      format: 'depth24plus',
      depthWriteEnabled: true,
      depthCompare: 'less',
    },
  });

  // 标记管线: 6 个顶点 = 一个四边形, 每盏灯一次实例
  const markerPipeline = device.createRenderPipeline({
    layout: 'auto', // 标记管线不用动态偏移, 让管线自己推导绑定组布局
    vertex: {
      module: markerShaderModule,
      entryPoint: 'vsMain',
      buffers: [
        {
          arrayStride: 2 * 4, // 角点: 每个顶点 2 个 float32
          stepMode: 'vertex',
          attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }],
        },
        {
          arrayStride: 6 * 4, // 实例数据: vec3 位置 + vec3 颜色 = 24 字节
          stepMode: 'instance', // 每个实例（每盏灯）前进一条, 而不是每个顶点
          attributes: [
            { shaderLocation: 1, offset: 0, format: 'float32x3' },  // 位置
            { shaderLocation: 2, offset: 12, format: 'float32x3' }, // 颜色
          ],
        },
      ],
    },
    fragment: {
      module: markerShaderModule,
      entryPoint: 'fsMain',
      targets: [{ format }],
    },
    primitive: {
      topology: 'triangle-list', // 用两个三角形代替 WebGL 的 POINTS
      cullMode: 'none',
    },
    depthStencil: {
      format: 'depth24plus',
      depthWriteEnabled: true,
      depthCompare: 'less', // 被球体挡住的标记点看不见, 与 WebGL 版一致
    },
  });

  // 只建一次绑定组: 两个球靠「动态偏移」指向缓冲区里属于自己的那 512 字节
  const meshBindGroup = device.createBindGroup({
    layout: meshBindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: meshUniformBuffer, offset: 0, size: MESH_UNIFORM_SIZE } },
    ],
  });

  const markerBindGroup = device.createBindGroup({
    layout: markerPipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: markerUniformBuffer } }],
  });

  // ---------- 9. 相机与投影 ----------
  // 轨道相机: yaw/pitch/distance/target 四个量就能重建任意视角
  const FOV = (45 * Math.PI) / 180;
  const NEAR = 0.1;
  const FAR = 100;
  const DEFAULT_CAMERA = { yaw: 0, pitch: 0.28, distance: 7.2, target: [0, 0.75, 0] };
  const camera = { ...DEFAULT_CAMERA, target: DEFAULT_CAMERA.target.slice() };

  const PITCH_LIMIT = Math.PI / 2 - 0.02;
  const MIN_DISTANCE = 2.5;
  const MAX_DISTANCE = 20;
  const ROTATE_SPEED = 0.006;
  const ZOOM_SPEED = 0.0015;

  let projection;     // 只在 resize() 里按当前画布宽高比生成
  let depthTexture;   // 深度纹理跟随画布尺寸重建
  let pointSize = 10; // 光源标记的像素大小, 跟着 dpr 走

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  // V = T(0,0,-d) · Rx(pitch) · Ry(-yaw) · T(-target)
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

  // 相机世界坐标: 视图矩阵把世界搬进相机空间, 反解回来就是
  //   cam = target + Ry(yaw) · Rx(-pitch) · (0, 0, distance)
  // 高光依赖视线方向, 相机一动这个值就必须重写, 不能像固定视角那样只传一次。
  function getCameraPosition() {
    const cosPitch = Math.cos(camera.pitch);
    return [
      camera.target[0] + camera.distance * cosPitch * Math.sin(camera.yaw),
      camera.target[1] + camera.distance * Math.sin(camera.pitch),
      camera.target[2] + camera.distance * cosPitch * Math.cos(camera.yaw),
    ];
  }

  function resetCamera() {
    camera.yaw = DEFAULT_CAMERA.yaw;
    camera.pitch = DEFAULT_CAMERA.pitch;
    camera.distance = DEFAULT_CAMERA.distance;
    camera.target = DEFAULT_CAMERA.target.slice();
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
    pointSize = 10 * dpr; // 标记点也要跟着 dpr 放大, 否则高 DPI 屏上细得像灰尘
    // 标记四边形按「绘制缓冲区的像素」外扩, 所以视口尺寸要用画布像素尺寸
    markerUniformData[MARKER_OFFSET.viewportSize] = width;
    markerUniformData[MARKER_OFFSET.viewportSize + 1] = height;
    if (sizeStat) sizeStat.textContent = `${width} × ${height}`;
    // 渲染循环每帧都会重画, 这里不必手动 render()
  }

  // ---------- 10. 光源状态: 开关 + 公转 ----------
  let lightTime = 0; // 公转累计时间（暂停时不累加）
  let lightPaused = false;

  // 四盏灯各自公转: 同一个公式 + 各自的半径/高度/角速度/初相位 → 互不同步
  function updateLightPositions() {
    LIGHTS.forEach((light) => {
      const angle = light.phase + lightTime * light.speed;
      light.position = [
        LIGHT_ORBIT_CENTER[0] + light.mirror * Math.cos(angle) * light.radius,
        LIGHT_ORBIT_CENTER[1] + light.height,
        LIGHT_ORBIT_CENTER[2] + Math.sin(angle) * light.radius,
      ];
    });
  }

  function enabledLightCount() {
    return LIGHTS.filter((light) => light.enabled).length;
  }

  // 改状态 → 刷新界面读数（WebGPU 这边没有「上下文状态」可改, 只是改 CPU 侧的数据）
  function applyLightState() {
    if (apiStat) {
      apiStat.textContent = `WebGPU · ${enabledLightCount()}/${MAX_LIGHTS}灯 · Phong | Blinn`;
    }
    helpPanel.lightKeys.forEach((key, index) => {
      if (key) key.classList.toggle('is-active', LIGHTS[index].enabled);
    });
    if (helpPanel.pauseKey) helpPanel.pauseKey.classList.toggle('is-active', lightPaused);
  }

  // ---------- 11. 每帧绘制 ----------
  const LEFT_SPHERE_MODEL = translation(-1.45, 0.72, 0); // 左: Phong
  const RIGHT_SPHERE_MODEL = translation(1.45, 0.72, 0); // 右: Blinn-Phong
  let viewProjection = new Float32Array(16);

  // 法线矩阵: 模型矩阵只有旋转和平移（没有缩放）, 左上角 3x3 就是法线矩阵
  // uniform 里的 mat3x3 每列占 16 字节, 所以要拼成 12 个 float、每列末尾留 1 个填充
  function writeMatrices(model, name) {
    const base = MESH_SLICE[name] * MESH_SLICE_FLOATS;
    meshUniformData.set(multiply(viewProjection, model), base + MESH_OFFSET.mvp);
    meshUniformData.set(model, base + MESH_OFFSET.model);
    meshUniformData.set([model[0], model[1], model[2], 0], base + MESH_OFFSET.normalMatrix);
    meshUniformData.set([model[4], model[5], model[6], 0], base + MESH_OFFSET.normalMatrix + 4);
    meshUniformData.set([model[8], model[9], model[10], 0], base + MESH_OFFSET.normalMatrix + 8);
  }

  // 传光照数组: 两段切片都要写一遍（两段各自是一份完整的 MeshUniforms）
  // 这就是 WebGL 里那 8 次 gl.uniform3fv(lightPositionLocations[i], ...) 的替代品
  function writeLights() {
    Object.values(MESH_SLICE).forEach((slice) => {
      const base = slice * MESH_SLICE_FLOATS + MESH_OFFSET.lights;
      for (let i = 0; i < MAX_LIGHTS; i++) {
        const lightBase = base + i * LIGHT_STRIDE_FLOATS; // 每盏灯 8 个 float
        meshUniformData.set(LIGHTS[i].position, lightBase);
        meshUniformData.set(LIGHTS[i].enabled ? LIGHTS[i].color : BLACK, lightBase + LIGHT_COLOR_OFFSET);
      }
    });
  }

  // 画一个球: 同一条管线 + 同一份顶点数据, 只有动态偏移（→ useBlinn）不同
  function drawMesh(pass, name) {
    pass.setBindGroup(0, meshBindGroup, [MESH_SLICE[name] * MESH_UNIFORM_STRIDE]);
    pass.setVertexBuffer(0, spherePositionBuffer); // 槽位 0 → @location(0) 位置
    pass.setVertexBuffer(1, sphereNormalBuffer);   // 槽位 1 → @location(1) 法线
    pass.setIndexBuffer(sphereIndexBuffer, 'uint16'); // 对应 bindBuffer(ELEMENT_ARRAY_BUFFER)
    pass.drawIndexed(sphereIndexCount);            // 对应 gl.drawElements(gl.TRIANGLES, ...)
  }

  function render() {
    viewProjection = multiply(projection, buildView());
    updateLightPositions(); // 光源在动, 每帧重算位置

    // 传 - 每帧变化的量先全部写进 CPU 侧的数组, 再一次性拷到 GPU
    //      WebGPU 的写入会先于本批命令全部落地, 不能边画边写
    writeMatrices(LEFT_SPHERE_MODEL, 'left');   // 左: Phong
    writeMatrices(RIGHT_SPHERE_MODEL, 'right'); // 右: Blinn-Phong
    const cameraPosition = getCameraPosition(); // 轨道相机一动就要重写
    Object.values(MESH_SLICE).forEach((slice) => {
      meshUniformData.set(cameraPosition, slice * MESH_SLICE_FLOATS + MESH_OFFSET.cameraPosition);
    });
    writeLights();
    device.queue.writeBuffer(meshUniformBuffer, 0, meshUniformData);

    // 传 - 光源标记的 uniform 与实例数据
    markerUniformData.set(viewProjection, MARKER_OFFSET.mvp);
    markerUniformData[MARKER_OFFSET.pointSize] = pointSize;
    device.queue.writeBuffer(markerUniformBuffer, 0, markerUniformData);

    // 只标记还亮着的灯: 关掉的灯位置仍在数组里, 但画个黑点没有意义
    const active = LIGHTS.filter((light) => light.enabled);
    active.forEach((light, index) => {
      markerInstanceData.set(light.position, index * 6);     // vec3 位置
      markerInstanceData.set(light.color, index * 6 + 3);    // vec3 颜色
    });
    if (active.length > 0) {
      // 只上传有效的那几条实例, 未激活的槽位不参与绘制
      device.queue.writeBuffer(markerInstanceBuffer, 0, markerInstanceData, 0, active.length * 6);
    }

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

    // 画 - 同一条管线、同一份顶点数据, 只切动态偏移: 左 Phong, 右 Blinn-Phong
    pass.setPipeline(meshPipeline);
    drawMesh(pass, 'left');
    drawMesh(pass, 'right');

    // 画 - 光源标记: 一次实例化 draw 画完所有亮着的灯
    if (active.length > 0) {
      pass.setPipeline(markerPipeline);
      pass.setBindGroup(0, markerBindGroup);
      pass.setVertexBuffer(0, quadCornerBuffer);
      pass.setVertexBuffer(1, markerInstanceBuffer);
      pass.draw(6, active.length); // 6 个顶点 × 每个实例 = 一盏灯
    }
    pass.end();

    device.queue.submit([encoder.finish()]);
  }

  // ---------- 12. 渲染循环 ----------
  const LIGHT_SPEED_SCALE = 0.35; // 公转整体快慢, 单独抽出来方便调
  let lastTime = 0;
  let frameCount = 0; // FPS 统计: 每 0.5 秒结算一次
  let elapsed = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    const delta = Math.min((now - lastTime) / 1000, 0.1); // 切后台再回来时截断, 避免「瞬移」
    lastTime = now;

    if (!lightPaused) lightTime += delta * LIGHT_SPEED_SCALE;
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

  // ---------- 14. 键盘控制光源 ----------
  window.addEventListener('keydown', (event) => {
    const key = event.key.toLowerCase();

    if (key >= '1' && key <= '4') {
      // 下标直接对应着色器里 lights[0..3], 按数字键就是改数组里的一项
      const index = Number(key) - 1;
      LIGHTS[index].enabled = !LIGHTS[index].enabled;
      applyLightState();
    } else if (key === 'p') {
      lightPaused = !lightPaused;
      applyLightState();
    } else if (key === 'r') {
      resetCamera();
    }
  });

  // ---------- 15. 页面状态钩子与启动 ----------
  document.body.dataset.api = 'webgpu';
  applyLightState(); // 默认: 四盏灯全开 + 公转中, 上面板高亮同步
  resize();
  window.addEventListener('resize', resize);
  document.body.classList.add('is-ready');
  requestAnimationFrame(frame);
}

/* =============== 数据准备 =============== */

/**
 * 球体（带法线, 用索引绘制）
 * 经纬网格: rings 圈纬线 × segments 段经线, 球面上每点的法线就是它自己的单位方向
 * 关键约定: 三角形从球外面看过去逆时针 —— 与「法线朝外」一致
 * 与 WebGL 版逐字相同: 这里只是数学, 不认识 gl 也不认识 device
 * @param {number} radius 半径
 * @param {number} segments 经线分段数（水平方向）
 * @param {number} rings 纬线分段数（垂直方向）
 */
function buildSphere(radius, segments = 48, rings = 32) {
  const positions = [];
  const normals = [];
  const indices = [];

  for (let ring = 0; ring <= rings; ring++) {
    const phi = (ring / rings) * Math.PI; // 0 在北极, π 在南极
    const sinPhi = Math.sin(phi);
    const cosPhi = Math.cos(phi);

    for (let segment = 0; segment <= segments; segment++) {
      const theta = (segment / segments) * Math.PI * 2;
      // 单位方向就是法线, 乘半径就是顶点
      const nx = sinPhi * Math.cos(theta);
      const ny = cosPhi;
      const nz = sinPhi * Math.sin(theta);

      positions.push(nx * radius, ny * radius, nz * radius);
      normals.push(nx, ny, nz);
    }
  }

  for (let ring = 0; ring < rings; ring++) {
    for (let segment = 0; segment < segments; segment++) {
      const current = ring * (segments + 1) + segment;
      const below = current + segments + 1;

      // 一个四边形格子拆成两个三角形, 绕序统一为逆时针（从外部看）
      indices.push(current, current + 1, below, current + 1, below + 1, below);
    }
  }

  return { positions, normals, indices };
}

/* =============== 缓冲区 =============== */

/**
 * 上传一条顶点流（位置 / 法线 / 四边形的角点都走这条路径）
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
 * 返回需要随状态高亮的按键元素: lightKeys 按 1~4 对应四盏光源, pauseKey 对应光源旋转开关
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
        { keys: ['1'], desc: '开关 暖黄·右', light: 0 },
        { keys: ['2'], desc: '开关 暖黄·左', light: 1 },
        { keys: ['3'], desc: '开关 冷蓝·右', light: 2 },
        { keys: ['4'], desc: '开关 冷蓝·左', light: 3 },
        { keys: ['P'], desc: '暂停/继续光源旋转', pause: true },
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

  const lightKeys = [];
  let pauseKey = null;

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

      if (item.light !== undefined) lightKeys[item.light] = term;
      if (item.pause) pauseKey = term;

      list.append(term, desc);
    });

    group.appendChild(list);
    card.appendChild(group);
  });

  panel.appendChild(card);
  document.body.appendChild(panel);

  return { lightKeys, pauseKey };
}
